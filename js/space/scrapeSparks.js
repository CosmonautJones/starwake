// Wall-scrape sparks for every ship in a wormhole race: while a hull grinds the tunnel wall, a
// stream of bright sparks pours off the contact point, scaled by speed and how hard it hit.
// Works for local ships (player + AI: contact from sim.scraping, impact bursts from 'scrape'
// events) and remote ships (contact found from their interpolated position). Only ships near
// the camera and on screen emit. One pooled additive billboard draw call, no per-frame
// allocation.
//
//   const fx = new ScrapeSparks(scene, { quality });
//   fx.hit(entity, point, intensity);          // on a ship's 'scrape' event (impact burst)
//   fx.update(dt, { entities, course, camera, focus });   // every rendered frame
//
// The focus ship's skim spray (near the wall, not touching) stays in SpeedFX; this adds the
// actual contact grind on top, for it and for everyone else.

import * as THREE from 'three';
import { BillboardPool, makeSpec, resetSpec } from './fx.js';
import { rng } from './util.js';

const MAX = { high: 640, medium: 440, low: 240 };
const RANGE = 360; // m: farther ships don't emit
const C_HOT = new THREE.Color(1.0, 0.92, 0.7);
const C_MID = new THREE.Color(1.0, 0.62, 0.22);
const C_END = new THREE.Color(1.0, 0.28, 0.05);
const _n = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3(), _r = new THREE.Vector3(), _v = new THREE.Vector3();
const _loc = { i: 0, u: 0, c: new THREE.Vector3(), t: new THREE.Vector3() };

export class ScrapeSparks {
  constructor(scene, { quality = 'high' } = {}) {
    this.pool = new BillboardPool(scene, MAX[quality] || MAX.high, THREE.AdditiveBlending, 23);
    this.rate = quality === 'low' ? 0.55 : 1;
    this._spec = makeSpec();
    this._r = rng(9137);
    this._st = new Map(); // entity -> { acc, hit, i, located }
    this.emitting = 0; // ships emitting this frame (debug / tests)
  }

  _state(e) {
    let st = this._st.get(e);
    if (!st) { st = { acc: 0, hit: 0, i: -1 }; this._st.set(e, st); }
    return st;
  }

  /** Impact burst from a ship's 'scrape' event (intensity 0..1). */
  hit(e, point, intensity = 0.5) {
    const st = this._state(e);
    st.hit = Math.max(st.hit, Math.min(1, intensity));
    if (!point || !e.sim) return;
    const sim = e.sim;
    _n.subVectors(sim.pos, point);
    const len = _n.length();
    if (len < 1e-4) return;
    _n.divideScalar(len); // inward (wall -> ship)
    const n = Math.round((6 + 22 * intensity) * this.rate);
    for (let k = 0; k < n; k++) this._spark(point, _n, sim.vel, 0.6 + intensity, true);
  }

  /**
   * @param {number} dt
   * @param {{entities:Array, course:object, camera:THREE.Camera, focus?:object}} o
   */
  update(dt, { entities, course, camera, focus = null }) {
    this.emitting = 0;
    if (dt > 0 && course && camera && entities) {
      const cam = camera.position;
      for (const e of entities) {
        const sim = e.sim;
        const st = this._state(e);
        st.hit = Math.max(0, st.hit - dt * 3);
        if (!e.connected || sim.dead || !e.craft?.root?.visible) { st.acc = 0; continue; }
        if (sim.pos.distanceToSquared(cam) > RANGE * RANGE) { st.acc = 0; st.i = -1; continue; }
        // on screen (with a margin so sparks entering the frame are already flowing)
        _p.copy(sim.pos).project(camera);
        if (_p.z > 1 || Math.abs(_p.x) > 1.35 || Math.abs(_p.y) > 1.35) { st.acc = 0; continue; }
        // where is the wall?
        let hint = e.kind === 'remote' ? st.i : sim.trackI;
        if (hint < 0 || hint == null) hint = this._coarse(course, sim.pos);
        const loc = course.locate(sim.pos, hint, _loc);
        st.i = loc.i;
        _r.subVectors(sim.pos, loc.c);
        _r.addScaledVector(loc.t, -_r.dot(loc.t));
        const r = _r.length();
        if (r < 1e-4) { st.acc = 0; continue; }
        const R = course.tunnelRadiusAt(loc.u) - (sim.p?.radius || 1.5);
        let contact = e.kind === 'remote' ? Math.min(1, Math.max(0, (r / R - 0.965) / 0.03)) : Math.min(1, sim.scraping || 0);
        if (contact <= 0.01 && st.hit <= 0.01) { st.acc = 0; continue; }
        const speed = sim.vel.length();
        const grind = contact * Math.min(1.25, speed / 85) * (0.55 + 0.45 * Math.min(1, st.hit * 1.5 + 0.3));
        if (grind <= 0.02) { st.acc = 0; continue; }
        this.emitting++;
        _n.copy(_r).divideScalar(-r); // inward normal
        const wall = _t.copy(loc.c).addScaledVector(_r, (R + (sim.p?.radius || 1.5)) / r); // contact point on the wall
        const rate = (e === focus ? 170 : 120) * grind * this.rate;
        st.acc += rate * dt;
        let guard = 40;
        while (st.acc >= 1 && guard-- > 0) { st.acc -= 1; this._spark(wall, _n, sim.vel, grind, false); }
        if (st.acc > 3) st.acc = 0;
        // contact glow (the focus ship already gets SpeedFX's flare)
        if (e !== focus && grind > 0.25) this._flare(wall, sim.vel, grind, dt);
      }
    }
    this.pool.update(dt);
  }

  /** Nearest sample by a coarse scan (first sighting of a remote ship). */
  _coarse(course, p) {
    const S = course.samples;
    let best = 0, bd = Infinity;
    for (let i = 0; i < S.length; i += 12) { const d = S[i].distanceToSquared(p); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  _spark(p, n, vel, k, burst) {
    const o = this._spec, r = this._r;
    resetSpec(o);
    o.shape = 3;
    o.px = p.x + (r() - 0.5) * 0.8; o.py = p.y + (r() - 0.5) * 0.8; o.pz = p.z + (r() - 0.5) * 0.8;
    // Sparks are torn off against the wall: they keep only part of the ship's speed, kick
    // inward off the wall, and fan out sideways.
    const lag = burst ? 0.15 + r() * 0.5 : 0.25 + r() * 0.55;
    const out = (burst ? 6 : 3) + r() * (burst ? 26 : 16);
    _v.set(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(burst ? 22 : 12);
    o.vx = vel.x * lag + n.x * out + _v.x; o.vy = vel.y * lag + n.y * out + _v.y; o.vz = vel.z * lag + n.z * out + _v.z;
    o.drag = 1.4 + r() * 1.2;
    o.life = 0.2 + r() * (burst ? 0.45 : 0.4);
    o.s0 = o.s1 = 0.09 + r() * 0.09 * Math.min(1.5, k);
    o.streak = 0.045;
    o.fadePow = 1.1;
    o.colPow = 0.7;
    o.alpha = Math.min(1, 0.6 + 0.4 * k);
    const hot = r() < 0.35 ? C_HOT : C_MID;
    const b0 = 3.2 + r() * 1.4;
    o.r0 = hot.r * b0; o.g0 = hot.g * b0; o.b0 = hot.b * b0;
    o.r1 = C_END.r * 1.3; o.g1 = C_END.g * 1.3; o.b1 = C_END.b * 1.3;
    this.pool.spawn(o);
  }

  _flare(p, vel, k, dt) {
    const o = this._spec, r = this._r;
    resetSpec(o);
    o.shape = 1; o.px = p.x; o.py = p.y; o.pz = p.z;
    o.vx = vel.x * 0.9; o.vy = vel.y * 0.9; o.vz = vel.z * 0.9;
    o.life = Math.max(0.05, dt * 1.6); o.s0 = o.s1 = 1.6 + k * 1.8 + r() * 0.8; o.fadePow = 1; o.alpha = 0.6 * Math.min(1, k);
    o.r0 = C_MID.r * 2.4; o.g0 = C_MID.g * 2.4; o.b0 = C_MID.b * 2.4; o.r1 = C_END.r * 1.6; o.g1 = C_END.g * 1.6; o.b1 = C_END.b * 1.6;
    this.pool.spawn(o);
  }

  /** Forget a ship (e.g. it left). */
  forget(e) { this._st.delete(e); }

  dispose() { this.pool.dispose(); this._st.clear(); }
}
