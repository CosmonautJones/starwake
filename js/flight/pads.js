// Boost pads, Rocket League style, inside the wormhole: small pads along the safe
// middle lanes give a sip of boost, big pads near the wall (the risky line) fill it.
// Each ship has its own pad timers (no denial), so nothing needs network sync.
// Placement is deterministic from the course id, like everything else in the world.

import * as THREE from 'three';
import { mulberry32, hashString } from '../core/util.js';

const Z = new THREE.Vector3(0, 0, 1);

export const PADS = {
  small: { every: 85, lane: 0.13, boost: 0.12, cooldown: 4, radius: 5.5 },
  big: { perLap: 3, lane: 0.72, boost: 1, cooldown: 10, radius: 7.5 },
};

export class BoostPads {
  constructor(course, world) {
    this.course = course;
    this.pads = [];
    this.events = [];
    this.timers = new Map(); // ship id -> Float32Array of seconds until each pad is back
    if (course.kind === 'arena' || !course.def.tunnel) return;
    const L = course.length;
    const rng = mulberry32(hashString(course.def.id) + 404);
    const gateUs = course.rings.map((g) => g.u);
    const clear = (pos, r) => {
      let ok = true;
      world?.forEachNear(pos, r + 8, (c) => { if (!c.dead) ok = false; });
      return ok;
    };
    const place = (u, lane, ang, big) => {
      const f = course.frameAt(u);
      const R = course.tunnelRadiusAt(u);
      for (let tries = 0; tries < 5; tries++) {
        const a = ang + tries * 1.3;
        const pos = f.pos.clone().addScaledVector(f.R, Math.cos(a) * R * lane).addScaledVector(f.U, Math.sin(a) * R * lane);
        if (clear(pos, big ? PADS.big.radius : PADS.small.radius)) {
          this.pads.push({ id: this.pads.length, u, pos, big, radius: big ? PADS.big.radius : PADS.small.radius, normal: f.T });
          return;
        }
      }
    };
    // Small pads in pairs of lanes that rotate slowly round the tube.
    const n = Math.floor(L / PADS.small.every);
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      if (u < 0.03 || u > 0.985) continue;
      if (gateUs.some((g) => Math.abs(g - u) * L < 30)) continue;
      place(u, PADS.small.lane, k * 0.9 + rng() * 0.4, false);
    }
    // Big pads: a few per lap, out near the wall.
    for (let k = 0; k < PADS.big.perLap; k++) {
      const u = (k + 0.3 + rng() * 0.3) / PADS.big.perLap;
      place(u, PADS.big.lane, rng() * Math.PI * 2, true);
    }
    this.pads.sort((a, b) => a.u - b.u);
    this.pads.forEach((p, i) => { p.id = i; });
  }

  _timersFor(id) {
    let t = this.timers.get(id);
    if (!t) { t = new Float32Array(this.pads.length); this.timers.set(id, t); }
    return t;
  }

  /** Is pad `i` available to ship `id`? (for drawing the local player's view) */
  ready(id, i) { const t = this.timers.get(id); return !t || t[i] <= 0; }

  /** ships: local entities. Collect pads they fly through. */
  update(dt, ships) {
    if (!this.pads.length) return;
    for (const e of ships) {
      const t = this._timersFor(e.id);
      for (let i = 0; i < t.length; i++) if (t[i] > 0) t[i] -= dt;
      const sim = e.sim;
      if (sim.dead || sim.finished) continue;
      for (let i = 0; i < this.pads.length; i++) {
        const p = this.pads[i];
        if (t[i] > 0) continue;
        const r = p.radius + sim.p.radius;
        if (Math.abs(p.pos.x - sim.pos.x) > r || Math.abs(p.pos.y - sim.pos.y) > r || Math.abs(p.pos.z - sim.pos.z) > r) continue;
        if (p.pos.distanceToSquared(sim.pos) > r * r) continue;
        const cfg = p.big ? PADS.big : PADS.small;
        t[i] = cfg.cooldown;
        sim.boost = Math.min(1, sim.boost + cfg.boost);
        this.events.push({ type: 'pad', shipId: e.id, big: p.big, id: i, pos: p.pos });
      }
    }
  }
}

/** Instanced pad visuals: amber diamonds (small) and glowing orbs with a ring (big). */
export class BoostPadViews {
  constructor(scene, pads) {
    this.pads = pads;
    this.scene = scene;
    const smalls = pads.pads.filter((p) => !p.big), bigs = pads.pads.filter((p) => p.big);
    this.smallIdx = smalls.map((p) => p.id);
    this.bigIdx = bigs.map((p) => p.id);
    const mk = (geo, color, count) => {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      m.count = count; m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.small = mk(new THREE.OctahedronGeometry(1.6, 0), '#ffb547', smalls.length);
    this.bigCore = mk(new THREE.IcosahedronGeometry(2.6, 1), '#ffd27a', bigs.length);
    this.bigRing = mk(new THREE.TorusGeometry(5.2, 0.28, 6, 40), '#ffb547', bigs.length);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._e = new THREE.Euler();
    this.scale = new Float32Array(pads.pads.length).fill(1);
  }

  update(dt, time, shipId) {
    const { _m, _q, _s, _e } = this;
    const P = this.pads.pads;
    const set = (mesh, k, p, spin, s) => {
      _e.set(spin * 0.7, spin, 0); _q.setFromEuler(_e); _s.setScalar(s);
      _m.compose(p.pos, _q, _s); mesh.setMatrixAt(k, _m);
    };
    this.smallIdx.forEach((i, k) => {
      const want = this.pads.ready(shipId, i) ? 1 : 0.0001;
      this.scale[i] += (want - this.scale[i]) * Math.min(1, dt * 8);
      set(this.small, k, P[i], time * 2 + i, this.scale[i] * (1 + Math.sin(time * 5 + i) * 0.08));
    });
    this.bigIdx.forEach((i, k) => {
      const want = this.pads.ready(shipId, i) ? 1 : 0.0001;
      this.scale[i] += (want - this.scale[i]) * Math.min(1, dt * 6);
      set(this.bigCore, k, P[i], time * 1.3, this.scale[i] * (1 + Math.sin(time * 4) * 0.1));
      // Ring faces down the tunnel.
      _q.setFromUnitVectors(Z, P[i].normal);
      _s.setScalar(Math.max(0.0001, this.scale[i]));
      _m.compose(P[i].pos, _q, _s); this.bigRing.setMatrixAt(k, _m);
    });
    this.small.instanceMatrix.needsUpdate = true;
    this.bigCore.instanceMatrix.needsUpdate = true;
    this.bigRing.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.small, this.bigCore, this.bigRing]) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  }
}
