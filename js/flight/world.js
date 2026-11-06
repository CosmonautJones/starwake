// Gameplay world for a course or arena: every object placed in it, the spatial
// grid used for collisions and shots, breakables and pickups.
// Pure logic (no rendering) so it also runs headless. Layout is seeded from the
// course/arena id, so every client builds identical worlds with identical ids.

import * as THREE from 'three';
import { mulberry32, hashString, clamp } from '../core/util.js';

const CELL = 150;
const RESPAWN_AFTER = 28;
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Matrix4();

// Nominal gameplay radius at scale 1 and default hit points for each prop type.
export const PROP_STATS = {
  asteroid: { r: 1, hp: 20, kind: 'rock', perScale: true },
  ice: { r: 1, hp: 18, kind: 'ice', perScale: true },
  boulder: { r: 1, hp: null, kind: 'rock' },
  boulderIce: { r: 1, hp: null, kind: 'ice' },
  crystal: { r: 6, hp: 50, kind: 'crystal' },
  cargo: { r: 4, hp: 35, kind: 'metal' },
  satellite: { r: 7, hp: 45, kind: 'metal' },
  mine: { r: 2.4, hp: 8, kind: 'metal', explosive: true },
  wreck: { r: 70, hp: null, kind: 'metal' },
  station: { r: 90, hp: null, kind: 'metal' },
  beacon: { r: 3, hp: null, kind: 'metal' },
  monolith: { r: 8, hp: null, kind: 'rock' },
};

// Rough collider sets for big props when the visual builder isn't available (headless).
function fallbackColliders(type) {
  if (type === 'station') {
    const out = [];
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; out.push({ x: Math.cos(a) * 90, y: Math.sin(a) * 90, z: 0, r: 16 }); }
    return out;
  }
  if (type === 'wreck') return Array.from({ length: 8 }, (_, i) => ({ x: 0, y: 0, z: -70 + i * 20, r: 18 }));
  if (type === 'beacon') return [{ x: 0, y: 0, z: 0, r: 3 }, { x: 0, y: 12, z: 0, r: 3 }, { x: 0, y: 24, z: 0, r: 3 }];
  if (type === 'monolith') return [{ x: 0, y: 6, z: 0, r: 7 }, { x: 0, y: 18, z: 0, r: 7 }, { x: 0, y: 30, z: 0, r: 7 }];
  return null;
}

export class SpaceWorld {
  /**
   * @param {import('./course.js').Course} course
   * @param {{colliderFor?: (type:string, seed:number) => {x,y,z,r}[]|null}} opts
   */
  constructor(course, { colliderFor = null } = {}) {
    this.course = course;
    this.def = course.def;
    this.colliderFor = colliderFor;
    this.items = [];
    this.byId = new Map();
    this.pickups = new Map();
    this.events = [];
    this.grid = new Map();
    this.time = 0;
    if (course.kind === 'arena') this._layoutArena(); else this._layout();
    this._colliders();
    for (const it of this.items) this._register(it);
  }

  // ------------------------------------------------------------------ layout
  _layout() {
    const def = this.def;
    const rng = mulberry32(hashString(def.id) + 77);
    const course = this.course;
    const stations = def.features.filter((f) => f.type === 'station').map((f) => course.pointAt(f.at));
    const clearOfRings = (pos, r) => {
      for (const ring of course.rings) if (pos.distanceTo(ring.pos) < ring.radius + r + 6) return false;
      for (const s of stations) if (pos.distanceTo(s) < 135 + r) return false;
      for (const it of this.items) if (pos.distanceTo(it.pos) < it.radius + r + 3) return false;
      return true;
    };
    const around = (u, dist, angle) => {
      const f = course.frameAt(u);
      return f.pos.addScaledVector(f.R, Math.cos(angle) * dist).addScaledVector(f.U, Math.sin(angle) * dist);
    };
    const randQuat = () => new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 6.28, rng() * 6.28, rng() * 6.28));
    const place = this._placeFn(rng);

    for (const f of def.features) {
      if (f.type === 'field' || f.type === 'scatter' || f.type === 'mines' || f.type === 'boulders') {
        const count = f.count || 6;
        for (let i = 0, tries = 0; i < count && tries < count * 30; tries++) {
          const u = f.from + rng() * (f.to - f.from);
          let type, size, dist;
          // Inside the wormhole (radius R) is where the racing happens; anything
          // placed outside is scenery seen through the walls.
          const R = course.tunnelRadiusAt(u);
          const nearStart = u < 0.035 || u > 0.975;
          const inside = (r) => Math.max(0, R - r - 7) * Math.sqrt(rng());
          if (f.type === 'boulders') {
            type = f.kind === 'ice' ? 'boulderIce' : 'boulder';
            size = f.size[0] + rng() * (f.size[1] - f.size[0]);
            // A few smaller boulders stand inside the tube as pillars to weave round.
            if (rng() < 0.3 && !nearStart) { size = Math.min(size, R * 0.3); dist = inside(size) * 0.8; }
            else dist = R + size + 12 + rng() * 140;
          } else if (f.type === 'mines') {
            type = 'mine'; size = 1;
            dist = inside(3);
          } else if (f.type === 'field') {
            type = f.kind === 'ice' ? 'ice' : 'asteroid';
            size = f.size[0] + Math.pow(rng(), 1.6) * (f.size[1] - f.size[0]);
            dist = rng() < 0.72 && !nearStart ? inside(size) : R + size + 10 + rng() * f.spread[1];
          } else {
            type = f.prop; size = 1;
            const r = PROP_STATS[type].r;
            dist = rng() < 0.8 && !nearStart ? inside(r) : R + r + 10 + rng() * f.spread[1];
          }
          if ((f.type === 'mines' || f.type === 'boulders' && dist < R) && nearStart) continue;
          const pos = around(u, dist, rng() * Math.PI * 2);
          const r = (PROP_STATS[type].r || 1) * size;
          if (!clearOfRings(pos, r)) continue;
          let drop = null;
          if (type === 'asteroid' || type === 'ice') drop = rng() < 0.22 ? 'boost' : rng() < 0.12 ? 'missile' : null;
          else if (type === 'crystal') drop = 'boost';
          else if (type === 'satellite') drop = rng() < 0.5 ? 'missile' : 'boost';
          else if (type === 'cargo') drop = rng() < 0.55 ? 'missile' : 'shield';
          place(type, pos, randQuat(), size, { drop });
          i++;
        }
      } else if (f.type === 'station') {
        const fr = course.frameAt(f.at);
        const q = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(fr.R, fr.U, fr.T));
        place('station', fr.pos, q, 1);
      } else if (f.type === 'wreck' || f.type === 'landmark') {
        const fr = course.frameAt(f.at);
        const pos = fr.pos.addScaledVector(fr.R, (f.side || 1) * (f.offset || 160)).addScaledVector(fr.U, (rng() - 0.5) * 60);
        const type = f.type === 'wreck' ? 'wreck' : f.prop;
        const q = type === 'monolith'
          ? new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(fr.R, fr.U, fr.T)).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, rng() * 6, 0.15)))
          : randQuat();
        place(type, pos, q, f.scale || 1);
      } else if (f.type === 'beacons') {
        for (let u = f.from; u <= f.to + 1e-6; u += f.every || 0.02) {
          const fr = course.frameAt(u);
          for (const side of [-1, 1]) {
            const pos = fr.pos.clone().addScaledVector(fr.R, side * (course.tunnelRadiusAt(u) + 16)).addScaledVector(fr.U, -12);
            const q = new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(fr.R, fr.U, fr.T));
            place('beacon', pos, q, 1);
          }
        }
      }
    }
  }

  /** Colliders in world space for every placed item. */
  _colliders() {
    for (const it of this.items) {
      const local = this.colliderFor?.(it.type === 'boulder' || it.type === 'boulderIce' ? null : it.type, it.seed) || fallbackColliders(it.type);
      if (local && local.length) {
        _m.compose(it.pos, it.quat, _v.set(it.scale, it.scale, it.scale));
        for (const c of local) {
          const w = new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(_m);
          it.colliders.push({ x: w.x, y: w.y, z: w.z, r: c.r * it.scale, ref: it.maxHp != null ? it : null, item: it, dead: false });
        }
      } else {
        it.colliders.push({ x: it.pos.x, y: it.pos.y, z: it.pos.z, r: it.radius * 0.92, ref: it.maxHp != null ? it : null, item: it, dead: false });
      }
      this.byId.set(it.id, it);
    }
  }

  _layoutArena() {
    const def = this.def;
    const rng = mulberry32(hashString(def.id) + 77);
    const place = this._placeFn(rng);
    const big = [];
    const randQuat = () => new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 6.28, rng() * 6.28, rng() * 6.28));
    const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
    const inBall = (c, r) => {
      // Uniform-ish point in a ball, squashed vertically so fights stay readable.
      for (;;) {
        const x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1;
        if (x * x + y * y + z * z <= 1) return new THREE.Vector3(x, y * 0.7, z).multiplyScalar(r).add(c);
      }
    };
    const clear = (pos, r) => {
      if (pos.length() + r > def.radius - 40) return false;
      for (const b of big) if (pos.distanceTo(b.pos) < b.clear + r) return false;
      for (const it of this.items) if (pos.distanceTo(it.pos) < it.radius + r + 4) return false;
      return true;
    };
    for (const f of def.features) {
      if (f.type === 'station' || f.type === 'wreck' || f.type === 'landmark') {
        const type = f.type === 'landmark' ? f.prop : f.type;
        const pos = v3(f.pos);
        const it = place(type, pos, f.type === 'station' ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.6, 0)) : randQuat(), f.scale || 1);
        big.push({ pos, clear: (type === 'station' ? 150 : type === 'wreck' ? 110 : 40) * (f.scale || 1) });
        void it;
      }
    }
    for (const f of def.features) {
      if (!['cluster', 'boulders', 'scatter', 'mines'].includes(f.type)) continue;
      const c = v3(f.center);
      for (let i = 0, tries = 0; i < f.count && tries < f.count * 40; tries++) {
        let type, size = 1, drop = null;
        if (f.type === 'cluster') { type = f.kind === 'ice' ? 'ice' : 'asteroid'; size = f.size[0] + Math.pow(rng(), 1.6) * (f.size[1] - f.size[0]); }
        else if (f.type === 'boulders') { type = f.kind === 'ice' ? 'boulderIce' : 'boulder'; size = f.size[0] + rng() * (f.size[1] - f.size[0]); }
        else if (f.type === 'mines') type = 'mine';
        else type = f.prop;
        const r = (PROP_STATS[type].r || 1) * size;
        // Mines ring the station: keep them off its hull but close by.
        const pos = inBall(c, f.radius);
        if (!clear(pos, r + (f.type === 'mines' ? 0 : 6))) continue;
        if (type === 'asteroid' || type === 'ice') drop = rng() < 0.3 ? 'boost' : rng() < 0.22 ? 'missile' : rng() < 0.12 ? 'shield' : null;
        else if (type === 'crystal') drop = rng() < 0.6 ? 'shield' : 'boost';
        else if (type === 'satellite') drop = rng() < 0.6 ? 'missile' : 'shield';
        else if (type === 'cargo') drop = rng() < 0.6 ? 'missile' : 'shield';
        place(type, pos, randQuat(), size, { drop });
        i++;
      }
    }
  }

  _placeFn(rng) {
    return (type, pos, quat, scale, extra = {}) => {
      const st = PROP_STATS[type];
      const item = {
        id: this.items.length, type, pos, quat, scale, seed: Math.floor(rng() * 1e6),
        radius: (st.r || 1) * scale, kind: extra.kind || st.kind,
        maxHp: st.hp == null ? null : Math.round(st.hp * (st.perScale ? Math.max(1, scale * 0.6) : 1)),
        explosive: !!st.explosive, drop: extra.drop ?? null, alive: true, breaks: 0, respawnT: 0, colliders: [],
      };
      item.hp = item.maxHp;
      this.items.push(item);
      return item;
    };
  }

  // ------------------------------------------------------------------ grid
  _key(ix, iy, iz) { return ix + ',' + iy + ',' + iz; }

  _register(it) {
    for (const c of it.colliders) {
      const r = c.r;
      for (let ix = Math.floor((c.x - r) / CELL); ix <= Math.floor((c.x + r) / CELL); ix++)
        for (let iy = Math.floor((c.y - r) / CELL); iy <= Math.floor((c.y + r) / CELL); iy++)
          for (let iz = Math.floor((c.z - r) / CELL); iz <= Math.floor((c.z + r) / CELL); iz++) {
            const k = this._key(ix, iy, iz);
            let cell = this.grid.get(k);
            if (!cell) this.grid.set(k, (cell = []));
            cell.push(c);
          }
    }
  }

  forEachNear(p, r, fn) {
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let ix = Math.floor((p.x - r) / CELL); ix <= Math.floor((p.x + r) / CELL); ix++)
      for (let iy = Math.floor((p.y - r) / CELL); iy <= Math.floor((p.y + r) / CELL); iy++)
        for (let iz = Math.floor((p.z - r) / CELL); iz <= Math.floor((p.z + r) / CELL); iz++) {
          const cell = this.grid.get(this._key(ix, iy, iz));
          if (!cell) continue;
          for (const c of cell) {
            if (seen.has(c)) continue;
            seen.add(c);
            const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z, rr = r + c.r;
            if (dx * dx + dy * dy + dz * dz < rr * rr) fn(c);
          }
        }
  }

  /** Nearest live collider hit by segment a→b (thickened by pad). Returns {t, col} or null. */
  raycast(a, b, pad = 0) {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-6) return null;
    _d.divideScalar(len);
    const mid = _v.copy(a).addScaledVector(_d, len / 2);
    let best = null;
    this.forEachNear(mid, len / 2 + pad, (c) => {
      if (c.dead) return;
      // segment-sphere
      const ox = a.x - c.x, oy = a.y - c.y, oz = a.z - c.z;
      const bq = ox * _d.x + oy * _d.y + oz * _d.z;
      const rr = c.r + pad;
      const cq = ox * ox + oy * oy + oz * oz - rr * rr;
      const disc = bq * bq - cq;
      if (disc < 0) return;
      let t = -bq - Math.sqrt(disc);
      if (t < 0) t = cq < 0 ? 0 : -bq + Math.sqrt(disc);
      if (t < 0 || t > len) return;
      if (!best || t < best.t) best = { t, col: c, item: c.item, point: new THREE.Vector3().copy(a).addScaledVector(_d, t) };
    });
    return best;
  }

  // ------------------------------------------------------------------ breakables
  /** Apply damage. Returns true if the item broke. */
  hitBreakable(id, dmg, byId) {
    const it = this.byId.get(id);
    if (!it || !it.alive || it.maxHp == null) return false;
    it.hp -= dmg;
    if (it.hp > 0) { this.events.push({ type: 'damaged', item: it }); return false; }
    this.breakItem(id, byId, false);
    return true;
  }

  /** Break immediately (local or from the network). Spawns the drop. */
  breakItem(id, byId, remote) {
    const it = this.byId.get(id);
    if (!it || !it.alive) return;
    it.alive = false;
    it.hp = 0;
    it.breaks++;
    it.respawnT = RESPAWN_AFTER;
    for (const c of it.colliders) c.dead = true;
    this.events.push({ type: 'broken', item: it, by: byId, remote });
    if (it.explosive) this.events.push({ type: 'blast', pos: it.pos.clone(), radius: 32, damage: 42, by: byId, remote });
    if (it.drop) {
      const pid = it.id + ':' + it.breaks;
      const pk = { id: pid, kind: it.drop, pos: it.pos.clone(), vel: new THREE.Vector3(), alive: true, age: 0 };
      this.pickups.set(pid, pk);
      this.events.push({ type: 'pickupSpawn', pickup: pk });
    }
  }

  removePickup(pid, byId) {
    const pk = this.pickups.get(pid);
    if (!pk || !pk.alive) return null;
    pk.alive = false;
    this.pickups.delete(pid);
    this.events.push({ type: 'pickupTaken', pickup: pk, by: byId });
    return pk;
  }

  /**
   * @param {number} dt
   * @param {{id, pos, dead, local}[]} ships ships that may collect pickups (local ones only collect)
   */
  update(dt, ships) {
    this.time += dt;
    for (const it of this.items) {
      if (it.alive || it.maxHp == null) continue;
      it.respawnT -= dt;
      if (it.respawnT > 0) continue;
      let clear = true;
      for (const s of ships) if (s.pos.distanceTo(it.pos) < it.radius + 90) { clear = false; break; }
      if (!clear) { it.respawnT = 2; continue; }
      it.alive = true;
      it.hp = it.maxHp;
      for (const c of it.colliders) c.dead = false;
      this.events.push({ type: 'respawned', item: it });
    }
    for (const pk of this.pickups.values()) {
      pk.age += dt;
      // Magnet toward the nearest ship.
      let best = null, bd = 60;
      for (const s of ships) {
        if (s.dead) continue;
        const d = s.pos.distanceTo(pk.pos);
        if (d < bd) { bd = d; best = s; }
      }
      if (best) {
        _d.subVectors(best.pos, pk.pos).normalize();
        pk.vel.addScaledVector(_d, 520 * dt).multiplyScalar(Math.exp(-3 * dt));
        if (bd < best.radius + 3 && best.local) this.removePickup(pk.id, best.id);
      } else {
        pk.vel.multiplyScalar(Math.exp(-1.5 * dt));
      }
      pk.pos.addScaledVector(pk.vel, dt);
    }
  }

  /** Approximate breakable items blocking a path segment (for AI). */
  blockersAlong(a, b, pad) { return this.raycast(a, b, pad); }

  get breakables() { return this.items.filter((i) => i.maxHp != null); }

  liveBreakableCount() { return this.items.filter((i) => i.maxHp != null && i.alive).length; }

  boundsBox() {
    const box = new THREE.Box3();
    if (this.course.kind === 'arena') return box.setFromCenterAndSize(this.course.center, _v.setScalar(this.course.radius * 2));
    for (const s of this.course.samples) box.expandByPoint(s);
    return box;
  }

  static clampDamage(v) { return clamp(v, 0, 999); }
}
