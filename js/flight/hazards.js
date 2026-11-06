// Hazards: plasmoids (drifting balls of living plasma) and the Vesk, a hostile drone
// swarm that preys on every pilot. Pure logic (no DOM, no rendering): runs headless.
//
// PLASMOIDS move on closed-form Lissajous drifts (a function of the shared match time
// and a per-plasmoid seed), so every client sees them in the same place with no
// network traffic. In a race their anchors sit inside the wormhole at seeded fractions
// of the lap and they sweep across the tube without ever leaving it; in an arena they
// drift round anchors throughout the sphere (half of them near the rock fields).
// Touching one hurts, stuns and knocks you away. Shooting one pops it: a burst that
// hurts ships nearby (not the shooter), then it re-forms ~20 s later.
//
// THE VESK are crystalline-organic hunters: near-black violet glass chitin, toxic-green
// bioluminescent claws and eyes. Two castes:
//   skitter  small, quick, low HP; packs harass and strafe, firing slow green plasma
//            bolts after a visible 0.6 s wind-up.
//   warden   big and lumbering; fires slow homing orbs (break hard across one to lose it).
// Races: packs lurk at 2-3 seeded ambush nests, clinging to the tunnel wall facing the
// traffic. When ships approach they launch, fly ahead of their prey and strafe it, tire
// after a few seconds, peel off to the wall and melt into it, re-forming at the nest.
// Battles: waves arrive from the arena edge every ~45-60 s, hunt the nearest pilots and
// drop pickups when killed; survivors leave after a while.
//
// Authority: one client (solo, or the multiplayer host) simulates drones and emits
// droneFire / droneDown; others interpolate drones from snapshot()s. Bolts are spawned
// on every client from droneFire events (spawnBolt), and each client checks bolts and
// plasmoids against its own LOCAL ships only, emitting damage/knock events for them.
//
// Events with `net: true` should be broadcast (packEvent -> applyRemote on the others).
// Events replayed from the network carry `remote: true`.

import * as THREE from 'three';
import { mulberry32, hashString, clamp } from '../core/util.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);

export const FACTION = {
  name: 'The Vesk',
  blurb: 'A crystalline hive that nests in wormhole eddies and hunts anything with an engine.',
  colors: { glow: '#8cff2e', glowHot: '#e6ffb0', chitin: '#160c22', glass: '#3a1f5c', bolt: '#9dff3a', orb: '#c6ff4a' },
};

export const PLASMOID = {
  rMin: 6, rMax: 16,
  contactBase: 16, contactPerR: 0.5,  // contact damage = base + perR * r (~19-24)
  stun: 0.55, knockMin: 35, knockMax: 85, contactCd: 1.4,
  hpBase: 10, hpPerR: 1.1,            // 17..28 hp: 3-4 laser hits, one missile
  regen: 3,                            // hp/s back while untouched
  reform: 20, formTime: 1.8,
  splash: 22, splashDamage: 26, splashStun: 0.45, splashKnock: 45, splashDrone: 30,
  warnRange: 150,
};

export const VESK = {
  skitter: {
    radius: 3.0, hp: 20, maxSpeed: 150, accel: 165, turn: 5.5, windup: 0.6, fireCd: [1.6, 2.6],
    bolt: 'bolt', range: 430, sep: 10, bank: 1.1, dropRace: 0.38, dropBattle: 0.55, battleHp: 1.4,
  },
  warden: {
    radius: 7, hp: 110, maxSpeed: 95, accel: 70, turn: 1.6, windup: 1.1, fireCd: [3.6, 5.2],
    bolt: 'orb', range: 620, sep: 22, bank: 0.5, dropRace: 1, dropBattle: 1, battleHp: 1.2,
  },
};

export const BOLTS = {
  bolt: { speed: 240, battleSpeed: 300, radius: 1.5, life: 2.6, damage: 11, stun: 0.2, knock: 12 },
  orb: { speed: 125, radius: 2.6, life: 5.5, damage: 20, stun: 0.6, knock: 35, turn: 0.95, lose: 1.1 },
};

const STATES = ['lurk', 'hunt', 'retreat', 'burrow', 'emerge', 'enter', 'leave'];
const STATE_CODE = Object.fromEntries(STATES.map((s, i) => [s, i]));
const TYPES = ['skitter', 'warden'];
const INTERP_MS = 130;
const DRONE_DAMAGE_RAM = 10;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _g = new THREE.Vector3(), _gv = new THREE.Vector3(), _n = new THREE.Vector3();
const _des = new THREE.Vector3(), _sep = new THREE.Vector3(), _f = new THREE.Vector3(), _up = new THREE.Vector3();
const _r = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _tc = new THREE.Vector3(), _tt = new THREE.Vector3(), _tu = new THREE.Vector3(), _tr = new THREE.Vector3();
const _loc = { i: 0, u: 0, c: new THREE.Vector3(), t: new THREE.Vector3() };

const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const wrap01 = (x) => ((x % 1) + 1) % 1;
const wrapHalf = (x) => x - Math.round(x);
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

/** Spawn a drone's drop as a world pickup (same id on every client). */
export function spawnHazardDrop(world, ev) {
  if (!world || !ev || !ev.drop) return null;
  const id = ev.dropId || ('vk' + ev.droneId);
  if (world.pickups.has(id)) return world.pickups.get(id);
  const pk = { id, kind: ev.drop, pos: new THREE.Vector3().copy(ev.pos), vel: new THREE.Vector3(), alive: true, age: 0 };
  world.pickups.set(id, pk);
  world.events.push({ type: 'pickupSpawn', pickup: pk });
  return pk;
}

export class Hazards {
  /**
   * @param {import('./course.js').Course|import('./arena.js').Arena} course
   * @param {import('./world.js').SpaceWorld} world
   * @param {{seed?:number, game?:'race'|'battle', intensity?:number, authority?:boolean,
   *          plasmoids?:boolean, drones?:boolean, clock?:() => number}} opts
   *   clock: ms clock used for snapshot interpolation (default performance.now).
   */
  constructor(course, world, { seed = 1, game = 'race', intensity = 0.6, authority = true, plasmoids = true, drones = true, clock = null } = {}) {
    this.course = course;
    this.world = world;
    this.game = game === 'battle' || course.kind === 'arena' ? 'battle' : 'race';
    this.battle = this.game === 'battle';
    this.intensity = clamp(intensity, 0, 1);
    this.authority = !!authority;
    this.seed = (seed >>> 0) ^ hashString(course.def.id + ':hazards');
    this.rng = mulberry32(this.seed + 17);
    this.clock = clock || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.events = [];
    this.time = 0;
    this._plasmoids = [];
    this._drones = [];
    this._bolts = [];
    this._targets = [];
    this.droneById = new Map();
    this.nests = [];
    this.waves = { next: 0, n: 0, list: [] };
    this.nextDroneId = 1;
    this.boltSeq = 0;
    this.shipInfo = new Map();   // id -> { i, u } (race: our own locate hint per ship)
    this.charging = new Map();   // target id -> drones charging at it this step
    this.lastShotAt = new Map(); // target id -> time of the last drone shot at it
    this.stats = { pops: 0, reforms: 0, droneKills: 0, spawned: 0, fired: 0, contacts: 0, boltHits: 0, unsticks: 0 };
    this._collideFn = (c) => this._collideOne(c);
    this._colDrone = null;

    if (plasmoids) { if (this.battle) this._buildArenaPlasmoids(); else this._buildRacePlasmoids(); }
    if (drones) { if (this.battle) this._planWaves(); else this._buildNests(); }
    this._evalPlasmoids(0, null);
  }

  // =====================================================================================
  // plasmoids
  _plasmoidCount() {
    if (this.battle) return Math.round(8 + 10 * this.intensity);
    return Math.max(4, Math.round((this.course.length / 650) * (0.6 + 0.8 * this.intensity)));
  }

  _newPlasmoid(r, anchor, axes, w, ph) {
    const id = this._plasmoids.length;
    const maxHp = Math.round(PLASMOID.hpBase + PLASMOID.hpPerR * r);
    const p = {
      id, r, anchor, axes, w, ph, seed: (this.rng() * 1000) | 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      hp: maxHp, maxHp, state: 'live', popAt: -1e9, popBy: null, form: 1,
      warn: 0, nearD: Infinity, near: new THREE.Vector3(), flare: 0, flash: 0, lastHit: -1e9,
      cd: new Map(),
    };
    // What AI raycasts see: a breakable-looking item so race AI shoots or dodges it.
    p.aiItem = { id: 'pl' + id, type: 'plasmoid', kind: 'plasma', pos: p.pos, radius: r, maxHp, hp: maxHp, alive: true, explosive: false, drop: null, hazard: p };
    p.aiCol = { x: 0, y: 0, z: 0, r, ref: null, item: p.aiItem, dead: false };
    this._plasmoids.push(p);
    return p;
  }

  /** Closed-form drift. Writes pos (and vel if given). */
  _plasmoidAt(p, t, outPos, outVel) {
    outPos.copy(p.anchor);
    if (outVel) outVel.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const a = p.w[k] * t + p.ph[k];
      outPos.addScaledVector(p.axes[k], Math.sin(a));
      if (outVel) outVel.addScaledVector(p.axes[k], Math.cos(a) * p.w[k]);
    }
    return outPos;
  }

  _buildRacePlasmoids() {
    const course = this.course, L = course.length, rng = this.rng;
    const count = this._plasmoidCount();
    const stations = (course.def.features || []).filter((f) => f.type === 'station').map((f) => f.at);
    const placed = [];
    const nestU = this._nestUs();
    for (let tries = 0; placed.length < count && tries < count * 40; tries++) {
      const u = 0.06 + rng() * 0.89;
      if (course.rings.some((g) => Math.abs(wrapHalf(g.u - u)) * L < 60)) continue;
      if (placed.some((q) => Math.abs(wrapHalf(q - u)) * L < 160)) continue;
      if (nestU.some((q) => Math.abs(wrapHalf(q - u)) * L < 140)) continue;
      if (stations.some((q) => Math.abs(wrapHalf(q - u)) * L < 120)) continue;
      const along = 10 + rng() * 16;
      let R = Infinity;
      for (let k = -2; k <= 2; k++) R = Math.min(R, course.tunnelRadiusAt(u + (k * along) / 2 / L));
      const r = clamp(lerp(PLASMOID.rMin, PLASMOID.rMax, Math.pow(rng(), 1.3)), PLASMOID.rMin, R * 0.24);
      const f = course.frameAt(u);
      const room = R - r - 9;
      if (room < 8) continue;
      const ang = rng() * TAU;
      const ax1 = f.R.clone().multiplyScalar(Math.cos(ang)).addScaledVector(f.U, Math.sin(ang));
      const ax2 = f.R.clone().multiplyScalar(-Math.sin(ang)).addScaledVector(f.U, Math.cos(ang));
      const k1 = 0.55 + rng() * 0.3, k2 = Math.sqrt(Math.max(0, 0.88 - k1 * k1)) * (0.5 + rng() * 0.5);
      // Lateral sweep speed 6-13 m/s: readable, dodgeable at racing speed.
      const a1 = room * k1, a2 = room * k2;
      const w = [(6 + rng() * 7) / Math.max(4, a1), (4 + rng() * 6) / Math.max(4, a2), (3 + rng() * 4) / along];
      const ph = [rng() * TAU, rng() * TAU, rng() * TAU];
      const axes = [ax1.multiplyScalar(a1), ax2.multiplyScalar(a2), f.T.clone().multiplyScalar(along)];
      const p = this._newPlasmoid(r, f.pos.clone(), axes, w, ph);
      p.u = u;
      if (!this._validatePath(p)) {
        // Shrink the sweep and retry once; drop the anchor if it still clips something.
        for (const ax of axes) ax.multiplyScalar(0.6);
        if (!this._validatePath(p)) { this._plasmoids.pop(); continue; }
      }
      placed.push(u);
    }
    this._plasmoids.sort((a, b) => a.u - b.u).forEach((p, i) => { p.id = i; p.aiItem.id = 'pl' + i; });
  }

  _buildArenaPlasmoids() {
    const arena = this.course, rng = this.rng, world = this.world;
    const count = this._plasmoidCount();
    const centres = (arena.def.features || []).filter((f) => ['cluster', 'scatter', 'boulders'].includes(f.type)).map((f) => ({ c: new THREE.Vector3(...f.center), r: f.radius }));
    for (let tries = 0; this._plasmoids.length < count && tries < count * 60; tries++) {
      let anchor;
      const pick = rng();
      if (centres.length && pick < 0.45) {
        const z = centres[Math.floor(rng() * centres.length)];
        anchor = randInBall(rng, z.r + 120).add(z.c);
      } else if (pick < 0.7) anchor = randInBall(rng, 480).multiply(_a.set(1, 0.7, 1)).add(arena.center);
      else anchor = randInBall(rng, arena.radius * 0.8).multiply(_a.set(1, 0.7, 1)).add(arena.center);
      if (anchor.distanceTo(arena.center) > arena.radius * 0.82) continue;
      if (arena.spawns.some((s) => s.pos.distanceTo(anchor) < 170)) continue;
      if (this._plasmoids.some((q) => q.anchor.distanceTo(anchor) < 260)) continue;
      const r = lerp(PLASMOID.rMin, PLASMOID.rMax, Math.pow(rng(), 1.2));
      const x = randUnit(rng, new THREE.Vector3());
      const y = randUnit(rng, new THREE.Vector3()).cross(x).normalize();
      const z = new THREE.Vector3().crossVectors(x, y).normalize();
      const amp = [35 + rng() * 55, 25 + rng() * 45, 15 + rng() * 30];
      const w = [(5 + rng() * 6) / amp[0], (4 + rng() * 5) / amp[1], (3 + rng() * 4) / amp[2]];
      const ph = [rng() * TAU, rng() * TAU, rng() * TAU];
      const p = this._newPlasmoid(r, anchor, [x.multiplyScalar(amp[0]), y.multiplyScalar(amp[1]), z.multiplyScalar(amp[2])], w, ph);
      if (!this._validatePath(p)) {
        for (const ax of p.axes) ax.multiplyScalar(0.5);
        if (!this._validatePath(p)) { this._plasmoids.pop(); continue; }
      }
      void world;
    }
  }

  /** Sample the drift for 6 minutes: inside the tube / arena, clear of every collider. */
  _validatePath(p) {
    const course = this.course, world = this.world;
    let hint = this.battle ? 0 : Math.round(p.u * course.sampleCount);
    let ok = true;
    for (let t = 0; t < 360 && ok; t += 0.75) {
      this._plasmoidAt(p, t, _a, null);
      if (this.battle) {
        if (_a.distanceTo(course.center) + p.r > course.radius * 0.9) return false;
      } else {
        const loc = course.locate(_a, hint, _loc);
        hint = loc.i;
        _n.subVectors(_a, loc.c);
        _n.addScaledVector(loc.t, -_n.dot(loc.t));
        if (_n.length() + p.r > course.tunnelRadiusAt(loc.u) - 5) return false;
      }
      if (world) world.forEachNear(_a, p.r + 4, () => { ok = false; });
    }
    return ok;
  }

  _evalPlasmoids(dt, ships) {
    const t = this.time;
    for (const p of this._plasmoids) {
      this._plasmoidAt(p, t, p.pos, p.vel);
      p.aiCol.x = p.pos.x; p.aiCol.y = p.pos.y; p.aiCol.z = p.pos.z;
      if (p.flare > 0) p.flare = Math.max(0, p.flare - dt * 2.2);
      if (p.flash > 0) p.flash = Math.max(0, p.flash - dt * 5);
      if (p.state === 'popped') {
        if (t >= p.popAt + PLASMOID.reform) {
          p.state = 'forming';
          this.stats.reforms++;
          this.events.push({ type: 'plasmoidReform', id: p.id, pos: p.pos.clone() });
        }
      }
      if (p.state === 'forming') {
        p.form = clamp((t - p.popAt - PLASMOID.reform) / PLASMOID.formTime, 0, 1);
        if (p.form >= 1) { p.state = 'live'; p.hp = p.maxHp; }
      } else if (p.state === 'popped') p.form = 0;
      else p.form = 1;
      if (p.state === 'live' && p.hp < p.maxHp && t - p.lastHit > 2) p.hp = Math.min(p.maxHp, p.hp + PLASMOID.regen * dt);
      p.aiItem.alive = p.state === 'live';
      p.aiItem.hp = p.hp;
      p.aiCol.dead = p.state !== 'live';
      // Warning glow + contact (contact only for our own ships).
      p.warn = 0; p.nearD = Infinity;
      if (!ships) continue;
      for (const s of ships) {
        const sim = s.sim;
        if (!s.connected || sim.dead) continue;
        const d = sim.pos.distanceTo(p.pos);
        const gap = d - p.r - sim.p.radius;
        if (gap < p.nearD) { p.nearD = gap; p.near.copy(sim.pos); }
        if (p.state !== 'live') continue;
        const w = 1 - clamp(gap / PLASMOID.warnRange, 0, 1);
        if (w > p.warn) p.warn = w * w;
        if (s.local === false || sim.ghost > 0 || sim.finished) continue;
        if (d < p.r + sim.p.radius * 0.85) {
          const until = p.cd.get(s.id) || -1;
          if (t < until) continue;
          p.cd.set(s.id, t + PLASMOID.contactCd);
          _n.subVectors(sim.pos, p.pos);
          if (_n.lengthSq() < 1e-6) _n.copy(sim.vel).negate();
          _n.normalize();
          const vn = _a.subVectors(sim.vel, p.vel).dot(_n);
          const imp = clamp(-vn * 0.7 + PLASMOID.knockMin, PLASMOID.knockMin, PLASMOID.knockMax);
          const point = p.pos.clone().addScaledVector(_n, p.r);
          p.flare = 1;
          this.stats.contacts++;
          this.events.push({ type: 'damage', shipId: s.id, amount: PLASMOID.contactBase + PLASMOID.contactPerR * p.r, kind: 'plasmoid', point, stun: PLASMOID.stun, byId: null, source: p.id });
          this.events.push({ type: 'knock', shipId: s.id, impulse: _n.clone().multiplyScalar(imp) });
          this.events.push({ type: 'plasmoidZap', id: p.id, shipId: s.id, point });
        }
      }
    }
  }

  /** Damage a plasmoid (lasers/missiles from a LOCAL shooter). Returns true if it popped. */
  hitPlasmoid(id, amount, byId) {
    const p = this._plasmoids[id];
    if (!p || p.state !== 'live') return false;
    p.hp -= amount;
    p.flash = 1;
    p.lastHit = this.time;
    if (p.hp > 0) return false;
    this._pop(p, this.time, byId, false);
    return true;
  }

  /** A pop reported by another client (or replayed). */
  popPlasmoid(id, at, byId) {
    const p = this._plasmoids[id];
    if (!p || p.state === 'popped') return false;
    this._pop(p, Number.isFinite(at) ? Math.min(at, this.time) : this.time, byId, true);
    return true;
  }

  _pop(p, at, byId, remote) {
    p.state = 'popped';
    p.popAt = at;
    p.popBy = byId;
    p.hp = 0;
    p.form = 0;
    this._plasmoidAt(p, this.time, p.pos, p.vel);
    this.stats.pops++;
    const pos = p.pos.clone();
    const ev = { type: 'plasmoidPop', id: p.id, pos, byId, at, r: p.r };
    if (remote) ev.remote = true; else ev.net = true;
    this.events.push(ev);
    // Splash on our own ships (every client does this for its own), never the shooter.
    const R = p.r + PLASMOID.splash;
    for (const s of this._lastShips || []) {
      const sim = s.sim;
      if (!s.connected || sim.dead || s.local === false || sim.ghost > 0) continue;
      const d = sim.pos.distanceTo(pos);
      if (d > R) continue;
      const k = 1 - (d / R) * 0.6;
      _n.subVectors(sim.pos, pos);
      if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
      _n.normalize();
      if (s.id !== byId) this.events.push({ type: 'damage', shipId: s.id, amount: PLASMOID.splashDamage * k, kind: 'plasmoid', point: sim.pos.clone(), stun: PLASMOID.splashStun, byId, source: p.id });
      this.events.push({ type: 'knock', shipId: s.id, impulse: _n.clone().multiplyScalar(PLASMOID.splashKnock * k) });
    }
    if (this.authority) {
      for (const d of [...this._drones]) {
        if (!d.alive) continue;
        const dd = d.pos.distanceTo(pos);
        if (dd < R + d.radius) this.damageDrone(d.id, PLASMOID.splashDrone * (1 - (dd / (R + d.radius)) * 0.5), byId);
      }
    }
  }

  // =====================================================================================
  // race nests
  _nestUs() {
    if (this.battle || this._nestUCache) return this._nestUCache || [];
    const course = this.course;
    const rng = mulberry32(this.seed + 4242);
    const n = this.intensity < 0.35 ? 2 : 3;
    const stations = (course.def.features || []).filter((f) => f.type === 'station').map((f) => f.at);
    const base = n === 2 ? [0.33, 0.7] : [0.24, 0.5, 0.76];
    const out = [];
    for (const b of base) {
      let u = b;
      for (let k = 0; k < 20; k++) {
        u = b + (rng() - 0.5) * 0.12;
        if (!stations.some((s) => Math.abs(wrapHalf(s - u)) < 0.07)) break;
      }
      out.push(wrap01(u));
    }
    this._nestUCache = out;
    return out;
  }

  _buildNests() {
    const course = this.course, rng = mulberry32(this.seed + 99);
    const us = this._nestUs();
    const pack = Math.round(2 + 3.2 * this.intensity);
    us.forEach((u, idx) => {
      const f = course.frameAt(u);
      const R = course.tunnelRadiusAt(u);
      const side = rng() * TAU;
      const nest = {
        index: idx, u, i: Math.round(u * course.sampleCount), pos: f.pos.clone(), T: f.T.clone(), R: f.R.clone(), U: f.U.clone(), radius: R,
        side, state: 'dormant', cooldown: 0, pack, slots: [],
        warden: this.intensity >= 0.45 && (idx === 1 || (this.intensity >= 0.9 && idx === us.length - 1) || us.length === 1),
      };
      // Lurk slots: a cluster on the wall, facing the oncoming traffic.
      for (let k = 0; k < pack; k++) {
        const a = side + (k - (pack - 1) / 2) * 0.32 + (rng() - 0.5) * 0.12;
        const along = (rng() - 0.5) * 30;
        const rad = R * (0.72 + rng() * 0.12);
        nest.slots.push({ type: 'skitter', a, along, rad, drone: null, respawnAt: 0 });
      }
      if (nest.warden) nest.slots.push({ type: 'warden', a: side + Math.PI, along: 20, rad: R * 0.35, drone: null, respawnAt: 0 });
      for (const sl of nest.slots) sl.anchor = this._nestAnchor(nest, sl, new THREE.Vector3());
      this.nests.push(nest);
      if (this.authority) for (const sl of nest.slots) this._spawnAtSlot(nest, sl, 'lurk');
    });
  }

  _nestAnchor(nest, sl, out) {
    return out.copy(nest.pos).addScaledVector(nest.T, sl.along)
      .addScaledVector(nest.R, Math.cos(sl.a) * sl.rad).addScaledVector(nest.U, Math.sin(sl.a) * sl.rad);
  }

  _spawnAtSlot(nest, sl, state) {
    const d = this._newDrone(sl.type, sl.anchor, state);
    d.nest = nest.index;
    d.slot = sl;
    sl.drone = d;
    d.i = nest.i;
    // Face the oncoming traffic.
    this._orient(d, _a.copy(nest.T).negate(), nest.U, 1);
    d.vis = state === 'emerge' ? 0 : 1;
    return d;
  }

  _updateNests(dt, ships) {
    const L = this.course.length;
    const act = 360 + 60 * this.intensity;
    for (const nest of this.nests) {
      if (nest.cooldown > 0) nest.cooldown -= dt;
      // Respawn killed drones once nobody is near.
      let near = false;
      for (const s of ships) {
        if (!s.connected || s.sim.dead) continue;
        if (s.sim.pos.distanceTo(nest.pos) < 320) { near = true; break; }
      }
      for (const sl of nest.slots) {
        if (sl.drone && !sl.drone.alive) { sl.drone = null; sl.respawnAt = this.time + 28 - 8 * this.intensity; }
        if (!sl.drone && !near && this.time >= sl.respawnAt) this._spawnAtSlot(nest, sl, 'emerge');
      }
      const home = nest.slots.filter((sl) => sl.drone && sl.drone.alive && (sl.drone.state === 'lurk'));
      if (!home.length || nest.cooldown > 0) continue;
      // Approaching ships: along-track distance to the nest.
      const prey = [];
      for (const s of ships) {
        const sim = s.sim;
        if (!s.connected || sim.dead || sim.finished) continue;
        const info = this.shipInfo.get(s.id);
        if (!info) continue;
        const along = wrapHalf(nest.u - info.u) * L;
        if (along > -40 && along < act) prey.push({ s, along });
      }
      if (!prey.length) continue;
      prey.sort((a, b) => a.along - b.along);
      nest.state = 'active';
      nest.cooldown = 8;
      this.events.push({ type: 'ambush', section: nest.index, pos: nest.pos.clone(), net: true });
      const m = Math.min(prey.length, 2 + (this.intensity > 0.7 ? 1 : 0));
      home.forEach((sl, k) => {
        const d = sl.drone;
        d.target = prey[k % m].s.id;
        this._setState(d, 'hunt');
        d.huntFor = (d.type === 'warden' ? 10 : 8) + 6 * this.intensity + this.rng() * 2;
        d.fireCd = 0.4 + this.rng() * 0.9;
        d.slotAlong = 18 + this.rng() * 60;
        d.slotAngle = this.rng() * TAU;
      });
    }
  }

  // =====================================================================================
  // battle waves
  _planWaves() {
    this.waves.interval = lerp(60, 44, this.intensity);
    this.waves.next = 22 + 10 * (1 - this.intensity);
  }

  _updateWaves(ships) {
    const W = this.waves;
    if (this.time < W.next) return;
    W.next += W.interval;
    W.n++;
    const live = this._drones.filter((d) => d.alive).length;
    const cap = Math.round(10 + 6 * this.intensity);
    let skitters = Math.round(3 + 4 * this.intensity);
    const warden = this.intensity >= 0.35 && W.n % 2 === 0;
    skitters = Math.min(skitters, cap - live - (warden ? 1 : 0));
    if (skitters <= 0 && !warden) return;
    const arena = this.course, rng = this.rng;
    // Arrive from the edge on the side nearest the action, but not on top of anyone.
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 8; k++) {
      const dir = randUnit(rng, new THREE.Vector3()).multiply(_a.set(1, 0.6, 1)).normalize();
      const p = dir.multiplyScalar(arena.radius * 0.94).add(arena.center);
      let dMin = Infinity, dSum = 0, n = 0;
      for (const s of ships) { if (!s.connected || s.sim.dead) continue; const d = s.sim.pos.distanceTo(p); dMin = Math.min(dMin, d); dSum += d; n++; }
      const score = (dMin > 350 ? 0 : -1000) - (n ? dSum / n : 0) * 0.3 + rng() * 50;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    const inward = new THREE.Vector3().subVectors(arena.center, best).normalize();
    const wave = { n: W.n, at: this.time, drones: [] };
    const make = (type, k) => {
      const off = randUnit(rng, new THREE.Vector3()).multiplyScalar(type === 'warden' ? 0 : 14 + k * 3);
      const d = this._newDrone(type, off.add(best), 'enter');
      d.vel.copy(inward).multiplyScalar(VESK[type].maxSpeed * 0.6);
      this._orient(d, inward, UP, 1);
      d.wave = W.n;
      d.leaveAt = this.time + 70 + 15 * this.intensity;
      d.fireCd = 1.5 + rng() * 1.5;
      d.vis = 0;
      wave.drones.push(d.id);
    };
    for (let k = 0; k < skitters; k++) make('skitter', k);
    if (warden) make('warden', 0);
    W.list.push(wave);
    this.events.push({ type: 'wave', count: wave.drones.length, n: W.n, pos: best.clone(), net: true });
  }

  // =====================================================================================
  // drones
  _newDrone(type, pos, state) {
    const cfg = VESK[type];
    const rng = this.rng;
    const id = this.nextDroneId++;
    const d = {
      id, type, cfg, radius: cfg.radius, hp: 0, maxHp: Math.round(cfg.hp * (this.battle ? cfg.battleHp : 1)), alive: true,
      pos: new THREE.Vector3().copy(pos), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), fwd: new THREE.Vector3(0, 0, -1),
      bank: 0, state, stateT: 0, target: null, charge: 0, fireCd: 1, flash: 0, vis: 1, huntFor: 0,
      slotAlong: 30, slotAngle: rng() * TAU, slotDist: lerp(60, 110, rng()), orbit: (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.25),
      wob: [rng() * TAU, rng() * TAU, 0.6 + rng() * 0.9, 0.5 + rng() * 0.8],
      avoid: new THREE.Vector3(), avoidT: 0, rayT: rng() * 0.12, retargetT: 0, i: 0, tgtI: 0,
      nest: -1, slot: null, wave: 0, leaveAt: Infinity, ramCd: 0, stuckT: 0, lastPos: new THREE.Vector3().copy(pos),
      drop: null, buf: null, seen: 0,
    };
    d.hp = d.maxHp;
    const dropP = this.battle ? cfg.dropBattle : cfg.dropRace;
    if (rng() < dropP) {
      const x = rng();
      if (type === 'warden') d.drop = x < 0.5 ? 'shield' : 'missile';
      else if (this.battle) d.drop = x < 0.35 ? 'boost' : x < 0.75 ? 'missile' : 'shield';
      else d.drop = x < 0.75 ? 'boost' : 'missile';
    }
    d.proxy = {
      id: 'vk' + id, name: type === 'warden' ? 'Vesk Warden' : 'Vesk Skitter', kind: 'drone', hazard: true, droneId: id, connected: true, local: false,
      sim: { pos: d.pos, vel: d.vel, quat: d.quat, dead: false, ghost: 0, finished: false, hull: d.hp, shield: 0, p: { hull: d.maxHp, shield: 1, radius: d.radius, armor: 0 }, lock: { id: null, t: 0 } },
    };
    if (this.battle) d.i = 0; else d.i = this.course.locate(d.pos, Math.round(this.course.nearestU(d.pos).u * this.course.sampleCount), _loc).i;
    this._drones.push(d);
    this.droneById.set(id, d);
    this.stats.spawned++;
    return d;
  }

  _setState(d, s) { if (d.state !== s) { d.state = s; d.stateT = 0; d.charge = 0; } }

  /** Authority: apply damage. Non-authority: flash it and return false (forward to host). */
  damageDrone(id, amount, byId) {
    const d = this.droneById.get(id);
    if (!d || !d.alive) return false;
    d.flash = 1;
    if (!this.authority) { this.events.push({ type: 'forwardHit', droneId: id, amount, byId: byId ?? null }); return false; }
    d.hp -= amount;
    if (d.state === 'lurk' && d.nest >= 0) {
      // Shooting into a nest wakes the whole pack.
      const nest = this.nests[d.nest];
      if (nest) nest.cooldown = 0;
    }
    if (d.hp > 0) {
      // Being shot makes it come for you.
      if (byId != null && d.state === 'hunt' && this.rng() < 0.5) d.target = byId;
      return false;
    }
    this._kill(d, byId);
    return true;
  }

  _kill(d, byId) {
    d.alive = false;
    d.hp = 0;
    d.proxy.sim.dead = true;
    d.proxy.connected = false;
    this.stats.droneKills++;
    this.events.push({ type: 'droneDown', droneId: d.id, pos: d.pos.clone(), vel: d.vel.clone(), byId: byId ?? null, drop: d.drop, dropId: d.drop ? 'vk' + d.id : null, droneType: d.type, net: true });
    this._removeDrone(d);
  }

  _removeDrone(d) {
    d.alive = false;
    d.proxy.sim.dead = true;
    d.proxy.connected = false;
    this.droneById.delete(d.id);
    const i = this._drones.indexOf(d);
    if (i >= 0) this._drones.splice(i, 1);
  }

  _validTarget(id) {
    const s = this._shipById.get(id);
    return s && s.connected && !s.sim.dead && !s.sim.finished ? s : null;
  }

  _updateDrones(dt, ships) {
    // Per-target charge counts (fair: at most a couple of drones winding up on one pilot).
    this.charging.clear();
    for (const d of this._drones) if (d.charge > 0 && d.target != null) this.charging.set(d.target, (this.charging.get(d.target) || 0) + 1);
    for (let k = this._drones.length - 1; k >= 0; k--) {
      const d = this._drones[k];
      if (!d.alive) continue;
      d.stateT += dt;
      if (d.flash > 0) d.flash = Math.max(0, d.flash - dt * 6);
      if (d.ramCd > 0) d.ramCd -= dt;
      if (this.battle) this._thinkBattle(d, dt, ships); else this._thinkRace(d, dt, ships);
      if (!d.alive) continue;
      this._move(d, dt, ships);
      this._fire(d, dt, ships);
      // Stuck watchdog (for tools and as a last-resort unstick).
      const moved = d.pos.distanceTo(d.lastPos);
      d.lastPos.copy(d.pos);
      const wantsMove = d.state === 'hunt' || d.state === 'enter' || d.state === 'leave';
      if (!wantsMove) d.stuckT = 0;   // lurking / retreating to the wall / burrowing: hanging still is the point
      else if (moved < 2 * dt) d.stuckT += dt; else d.stuckT = Math.max(0, d.stuckT - dt);
      if (d.stuckT > 1.2 && d.state === 'hunt') {
        // Pinned (its slot is inside a rock, or it's pressed against one): pick another slot.
        d.slotAngle += 1.7 + this.rng();
        d.slotAlong = 18 + this.rng() * 60;
        d.slotDist = lerp(60, 110, this.rng());
        d.avoid.set(0, 0, 0); d.avoidT = 0;
        d.stuckT = 0.6;
        // ...and kick it free: toward the middle of the tube (it may be wedged between a
        // structure poking into the tunnel and the wall), or any way out in the open.
        if (this.battle) d.vel.add(randUnit(this.rng, _a).multiplyScalar(45));
        else { this._trackFrame(d.i); d.vel.add(_a.subVectors(_tc, d.pos).setLength(55)); }
        d.unsticks = (d.unsticks || 0) + 1;
        this.stats.unsticks++;
      }
      d.proxy.sim.hull = d.hp;
    }
  }

  // ---------------------------------------------------------------- race behaviour
  _thinkRace(d, dt, ships) {
    const course = this.course, L = course.length, n = course.sampleCount;
    const nest = this.nests[d.nest];
    const cfg = d.cfg;
    d.maxV = cfg.maxSpeed * (0.9 + 0.15 * this.intensity);
    _gv.set(0, 0, 0);
    if (d.state === 'emerge') {
      d.vis = Math.min(1, d.vis + dt / 1.2);
      _g.copy(d.slot.anchor);
      d.maxV = 20;
      if (d.vis >= 1) this._setState(d, 'lurk');
    } else if (d.state === 'lurk') {
      const t = this.time, w = d.wob;
      _g.copy(d.slot.anchor).addScaledVector(nest.R, Math.sin(t * w[2] + w[0]) * 3).addScaledVector(nest.U, Math.sin(t * w[3] + w[1]) * 3).addScaledVector(nest.T, Math.sin(t * 0.4 + w[0]) * 4);
      d.maxV = 25;
    } else if (d.state === 'hunt') {
      let tgt = d.target != null ? this._validTarget(d.target) : null;
      if (tgt) {
        const info = this.shipInfo.get(tgt.id);
        const along = info ? wrapHalf(info.u - d.i / n) * L : 0;
        // Prey left us far behind (boost!), or went past us long ago: give up.
        if (along > 260 || along < -560) tgt = null;
      }
      if (!tgt && d.stateT > 0.5) {
        // Try the nearest ship close by, else retreat.
        tgt = this._nearestShip(d, ships, 260);
        d.target = tgt ? tgt.id : null;
      }
      if (!tgt || d.stateT > d.huntFor) { this._setState(d, 'retreat'); d.target = null; }
      else {
        const info = this.shipInfo.get(tgt.id);
        const si = info ? info.i : d.i;
        if (d.type === 'warden') {
          // Lumbering: hold the middle of the tube ahead of the prey, backing off downstream.
          const ahead = clamp(140 - d.stateT * 6, 60, 140);
          this._trackFrame(si + ahead / course.step);
          const Rr = course.tunnelRadiusAt((si + ahead / course.step) / n);
          _g.copy(_tc).addScaledVector(_tr, Math.cos(d.slotAngle) * Rr * 0.3).addScaledVector(_tu, Math.sin(d.slotAngle) * Rr * 0.3);
          _gv.copy(tgt.sim.vel).multiplyScalar(0.55);
        } else {
          // Strafe slot ahead of the prey, swirling round the tube.
          const t = this.time;
          const along = d.slotAlong + Math.sin(t * 0.9 + d.wob[0]) * 12;
          const fi = si + along / course.step;
          this._trackFrame(fi);
          const Rr = course.tunnelRadiusAt(fi / n);
          d.slotAngle += d.orbit * dt;
          const ang = d.slotAngle + Math.sin(t * d.wob[2] + d.wob[1]) * 0.5;
          const rad = clamp(0.5 + Math.sin(t * d.wob[3] + d.wob[0]) * 0.15, 0.25, 0.7) * Rr;
          _g.copy(_tc).addScaledVector(_tr, Math.cos(ang) * rad).addScaledVector(_tu, Math.sin(ang) * rad);
          _gv.copy(tgt.sim.vel);
        }
      }
    } else if (d.state === 'retreat') {
      // Tired: slow down, drift to the wall and let the traffic pass; then burrow.
      d.maxV = 45;
      this._trackFrame(d.i + 4);
      _a.subVectors(d.pos, _tc); _a.addScaledVector(_tt, -_a.dot(_tt));
      if (_a.lengthSq() < 1) _a.copy(_tr);
      _a.normalize();
      const R = course.tunnelRadiusAt(d.i / n);
      _g.copy(_tc).addScaledVector(_a, R * 0.82);
      if (d.stateT > 2.2) this._setState(d, 'burrow');
    } else if (d.state === 'burrow') {
      d.maxV = 30;
      this._trackFrame(d.i);
      _a.subVectors(d.pos, _tc); _a.addScaledVector(_tt, -_a.dot(_tt)).normalize();
      _g.copy(_tc).addScaledVector(_a, course.tunnelRadiusAt(d.i / n));
      d.vis = Math.max(0, d.vis - dt / 0.9);
      if (d.vis <= 0) {
        // Melted into the wall: re-form at the nest.
        d.pos.copy(d.slot.anchor);
        d.vel.set(0, 0, 0);
        d.i = nest.i;
        d.hp = d.maxHp;
        this._orient(d, _a.copy(nest.T).negate(), nest.U, 1);
        this._setState(d, 'emerge');
        d.target = null;
      }
    }
    this._desired(d, dt);
  }

  // ---------------------------------------------------------------- battle behaviour
  _thinkBattle(d, dt, ships) {
    const arena = this.course, cfg = d.cfg;
    // Battle drones outpace a cruising ship (not a boosting one), so they can close in.
    d.maxV = cfg.maxSpeed * (1.05 + 0.15 * this.intensity);
    _gv.set(0, 0, 0);
    if (d.vis < 1 && d.state !== 'leave') d.vis = Math.min(1, d.vis + dt / 0.8);
    if (d.state !== 'leave' && this.time > d.leaveAt) { this._setState(d, 'leave'); d.target = null; }
    if (d.state === 'enter' || d.state === 'hunt') {
      d.retargetT -= dt;
      let tgt = d.target != null ? this._validTarget(d.target) : null;
      if (tgt && tgt.sim.ghost > 0) tgt = null;
      if (!tgt || d.retargetT <= 0) {
        d.retargetT = 2.5 + this.rng();
        const pick = this._pickBattleTarget(d, ships);
        if (pick) tgt = pick;
        d.target = tgt ? tgt.id : null;
      }
      if (d.state === 'enter' && (d.stateT > 2.5 || (tgt && tgt.sim.pos.distanceTo(d.pos) < 500))) this._setState(d, 'hunt');
      if (tgt) {
        // Circle-strafe a slot round the prey: skitters close, wardens stand off.
        d.slotAngle += d.orbit * dt;
        const dist = d.type === 'warden' ? 210 : d.slotDist;
        const tilt = Math.sin(this.time * 0.35 + d.wob[0]) * 0.6;
        _a.set(Math.cos(d.slotAngle) * Math.cos(tilt), Math.sin(tilt), Math.sin(d.slotAngle) * Math.cos(tilt));
        // Bias the slot toward the side we're already on, so we don't cross the target.
        _b.subVectors(d.pos, tgt.sim.pos).normalize();
        _a.lerp(_b, 0.45).normalize();
        _g.copy(tgt.sim.pos).addScaledVector(tgt.sim.vel, 0.6).addScaledVector(_a, dist);
        _gv.copy(tgt.sim.vel).multiplyScalar(0.7);
      } else {
        // Nobody to hunt: drift toward the middle.
        _g.copy(arena.center).addScaledVector(_a.set(Math.sin(this.time * 0.2 + d.wob[0]), 0.2, Math.cos(this.time * 0.2 + d.wob[1])), arena.radius * 0.4);
        d.maxV *= 0.6;
      }
    } else if (d.state === 'leave') {
      _a.subVectors(d.pos, arena.center);
      if (_a.lengthSq() < 1) _a.set(1, 0, 0);
      _g.copy(arena.center).addScaledVector(_a.normalize(), arena.radius * 1.1);
      if (d.pos.distanceTo(arena.center) > arena.radius * 0.9 || d.stateT > 12) {
        d.vis = Math.max(0, d.vis - dt / 0.8);
        if (d.vis <= 0) {
          this.events.push({ type: 'droneGone', droneId: d.id, net: true });
          this._removeDrone(d);
          return;
        }
      }
    }
    this._desired(d, dt);
  }

  _pickBattleTarget(d, ships) {
    let best = null, bestCost = Infinity;
    for (const s of ships) {
      const sim = s.sim;
      if (!s.connected || sim.dead || sim.ghost > 0) continue;
      const dist = sim.pos.distanceTo(d.pos);
      if (dist > 1400) continue;
      let load = 0;
      for (const o of this._drones) if (o !== d && o.alive && o.target === s.id) load++;
      const cost = dist * (1 + 0.45 * load) * (s.id === d.target ? 0.7 : 1);
      if (cost < bestCost) { bestCost = cost; best = s; }
    }
    return best;
  }

  _nearestShip(d, ships, maxD) {
    let best = null, bd = maxD;
    for (const s of ships) {
      const sim = s.sim;
      if (!s.connected || sim.dead || sim.finished || sim.ghost > 0) continue;
      const dist = sim.pos.distanceTo(d.pos);
      if (dist < bd) { bd = dist; best = s; }
    }
    return best;
  }

  /** Arrive at _g with feed-forward _gv; writes _des. */
  _desired(d, dt) {
    _des.subVectors(_g, d.pos);
    const dist = _des.length();
    const approach = Math.min(d.maxV * 1.1, dist * 1.6);
    if (dist > 1e-4) _des.multiplyScalar(approach / dist); else _des.set(0, 0, 0);
    _des.add(_gv);
    void dt;
  }

  /** Steering: flocking, obstacle avoidance, acceleration limits, containment. */
  _move(d, dt, ships) {
    const cfg = d.cfg;
    // Separation: other drones, ships, live plasmoids.
    _sep.set(0, 0, 0);
    for (const o of this._drones) {
      if (o === d || !o.alive) continue;
      _a.subVectors(d.pos, o.pos);
      const dist = _a.length(), min = cfg.sep + o.radius;
      if (dist < min && dist > 1e-4) _sep.addScaledVector(_a, ((min - dist) / min) * 70 / dist);
    }
    for (const s of ships) {
      if (!s.connected || s.sim.dead) continue;
      _a.subVectors(d.pos, s.sim.pos);
      const dist = _a.length(), min = 13 + d.radius;
      if (dist < min && dist > 1e-4) _sep.addScaledVector(_a, ((min - dist) / min) * 110 / dist);
    }
    for (const p of this._plasmoids) {
      if (p.state === 'popped') continue;
      _a.subVectors(d.pos, p.pos);
      const dist = _a.length(), min = p.r + d.radius + 12;
      if (dist < min && dist > 1e-4) _sep.addScaledVector(_a, ((min - dist) / min) * 120 / dist);
    }
    _des.add(_sep);

    // Obstacles ahead (throttled raycast along velocity / desired heading).
    d.rayT -= dt;
    if (d.rayT <= 0 && this.world) {
      d.rayT = 0.12;
      _b.copy(d.vel.lengthSq() > 25 ? d.vel : _des);
      const sp = _b.length();
      if (sp > 1e-3) {
        _b.divideScalar(sp);
        const look = 25 + sp * 0.9;
        _c.copy(d.pos).addScaledVector(_b, look);
        const hit = this.world.raycast(d.pos, _c, d.radius + 3);
        if (hit && hit.col) {
          const col = hit.col;
          _a.copy(d.pos).addScaledVector(_b, hit.t).sub(_e.set(col.x, col.y, col.z));
          _a.addScaledVector(_b, -_a.dot(_b));
          if (_a.lengthSq() < 0.25) _a.crossVectors(_b, Math.abs(_b.y) < 0.9 ? UP : _e.set(1, 0, 0));
          d.avoid.copy(_a.normalize()).multiplyScalar(d.maxV * (0.6 + 0.8 * (1 - hit.t / look)));
          d.avoidT = 0.45;
        }
      }
    }
    if (d.avoidT > 0) { d.avoidT -= dt; _des.add(d.avoid); }

    const sp = _des.length(), cap = d.maxV;
    if (sp > cap) _des.multiplyScalar(cap / sp);
    // Accelerate toward the desired velocity (limited), remembering lateral accel for banking.
    _a.subVectors(_des, d.vel);
    const dv = _a.length(), maxDv = cfg.accel * dt;
    if (dv > maxDv) _a.multiplyScalar(maxDv / dv);
    d.vel.add(_a);
    const latAcc = _a.divideScalar(Math.max(dt, 1e-4));
    d.pos.addScaledVector(d.vel, dt);

    // Hard contact with world colliders.
    if (this.world) { this._colDrone = d; this.world.forEachNear(d.pos, d.radius + 1, this._collideFn); }

    // Containment.
    if (this.battle) {
      const a = this.course;
      _n.subVectors(d.pos, a.center);
      const r = _n.length(), max = a.radius * (d.state === 'leave' ? 1.08 : 0.98);
      if (r > max) {
        _n.divideScalar(r);
        d.pos.addScaledVector(_n, max - r);
        const vn = d.vel.dot(_n);
        if (vn > 0) d.vel.addScaledVector(_n, -vn);
      }
    } else {
      const course = this.course;
      const loc = course.locate(d.pos, d.i, _loc);
      d.i = loc.i;
      _n.subVectors(d.pos, loc.c);
      _n.addScaledVector(loc.t, -_n.dot(loc.t));
      const r = _n.length();
      const R = course.tunnelRadiusAt(loc.u) - d.radius - 2;
      if (r > R && r > 1e-6) {
        _n.divideScalar(r);
        d.pos.addScaledVector(_n, R - r);
        const vn = d.vel.dot(_n);
        if (vn > 0) d.vel.addScaledVector(_n, -vn * 1.2);
      }
      d.u = loc.u;
    }

    // Orientation: face the prey while winding up, otherwise the flight path; bank into turns.
    let face;
    if (d.charge > 0 && d.aimAt) face = _f.subVectors(d.aimAt, d.pos);
    else if (d.state === 'lurk' || d.state === 'emerge') face = null;
    else face = _f.copy(d.vel.lengthSq() > 4 ? d.vel : d.fwd);
    if (face && face.lengthSq() > 1e-6) {
      face.normalize();
      if (this.battle) _up.copy(UP);
      else { this._trackFrame(d.i); _up.copy(_tu); }
      // Bank: roll toward the lateral acceleration.
      _r.crossVectors(face, _up);
      if (_r.lengthSq() < 1e-4) _r.set(1, 0, 0);
      _r.normalize();
      const lat = latAcc.dot(_r);
      const bankT = clamp(lat / 60, -1, 1) * cfg.bank + Math.sin(this.time * 2.3 + d.wob[0]) * 0.12;
      d.bank += (bankT - d.bank) * (1 - Math.exp(-4 * dt));
      _up.applyAxisAngle(face, -d.bank);
      this._orient(d, face, _up, 1 - Math.exp(-cfg.turn * dt));
    }
  }

  _collideOne(c) {
    const d = this._colDrone;
    if (c.dead) return;
    _n.set(d.pos.x - c.x, d.pos.y - c.y, d.pos.z - c.z);
    const dist = _n.length(), min = c.r + d.radius;
    if (dist >= min || dist < 1e-6) return;
    _n.divideScalar(dist);
    d.pos.addScaledVector(_n, min - dist);
    const vn = d.vel.dot(_n);
    if (vn < 0) d.vel.addScaledVector(_n, -vn * 1.3);
  }

  _orient(d, face, up, k) {
    _a.copy(face).negate();
    _b.crossVectors(up, _a);                       // right = up x back
    if (_b.lengthSq() < 1e-6) { _b.crossVectors(UP, _a); if (_b.lengthSq() < 1e-6) _b.set(1, 0, 0); }
    _b.normalize();
    _c.crossVectors(_a, _b).normalize();           // true up = back x right
    _m4.makeBasis(_b, _c, _a);
    _q.setFromRotationMatrix(_m4);
    if (k >= 1) d.quat.copy(_q); else d.quat.slerp(_q, k);
    d.fwd.copy(FWD).applyQuaternion(d.quat);
  }

  /** Centre/tangent/up/right of the line at a fractional sample index (no allocation). */
  _trackFrame(fi) {
    const course = this.course, n = course.sampleCount, S = course.samples;
    const i0 = Math.floor(fi), k = fi - i0;
    const a = S[((i0 % n) + n) % n], b = S[(((i0 + 1) % n) + n) % n];
    _tc.copy(a).lerp(b, k);
    _tt.subVectors(b, a);
    if (_tt.lengthSq() < 1e-8) _tt.set(0, 0, -1);
    _tt.normalize();
    _tu.copy(UP).addScaledVector(_tt, -UP.dot(_tt));
    if (_tu.lengthSq() < 1e-6) _tu.set(1, 0, 0);
    _tu.normalize();
    _tr.crossVectors(_tt, _tu).normalize();
  }

  // ---------------------------------------------------------------- firing
  _fire(d, dt, ships) {
    const cfg = d.cfg;
    if (d.fireCd > 0) d.fireCd -= dt;
    const armed = d.state === 'hunt' && d.vis >= 1;
    const tgt = armed && d.target != null ? this._validTarget(d.target) : null;
    if (!tgt || tgt.sim.ghost > 0) { if (d.charge > 0) d.charge = Math.max(0, d.charge - dt * 3); return; }
    const tp = tgt.sim.pos;
    const dist = tp.distanceTo(d.pos);
    if (d.charge <= 0) {
      if (d.fireCd > 0 || dist > cfg.range || dist < 12) return;
      // Fairness: in a race only shoot from where the pilot can see us (ahead-ish).
      _a.subVectors(d.pos, tp).divideScalar(dist);
      const nose = _b.copy(FWD).applyQuaternion(tgt.sim.quat);
      if (_a.dot(nose) < (this.battle ? -0.7 : 0.25)) return;
      const cap = this.intensity < 0.4 ? 1 : this.intensity < 0.8 ? 2 : 3;
      if ((this.charging.get(tgt.id) || 0) >= cap) return;
      if (this.time - (this.lastShotAt.get(tgt.id) ?? -1e9) < 0.35) return;
      if (this.world) { const h = this.world.raycast(d.pos, tp, 0.6); if (h && h.t < dist - 4) { d.fireCd = 0.4; return; } }
      d.charge = 1e-3;
      this.charging.set(tgt.id, (this.charging.get(tgt.id) || 0) + 1);
      d.aimAt = d.aimAt || new THREE.Vector3();
    }
    d.aimAt.copy(tp);
    d.charge = Math.min(1, d.charge + dt / cfg.windup);
    if (d.charge < 1) return;
    // Release.
    d.charge = 0;
    const B = BOLTS[cfg.bolt];
    d.fireCd = lerp(cfg.fireCd[0], cfg.fireCd[1], this.rng()) / (this.battle ? 0.7 + 0.9 * this.intensity : 0.55 + 0.75 * this.intensity);
    const muzzle = _c.copy(d.pos).addScaledVector(d.fwd, d.radius * 0.9);
    const speed = this.battle && B.battleSpeed ? B.battleSpeed : B.speed;
    const t = dist / speed;
    const lead = cfg.bolt === 'orb' ? 0.2 : this.battle ? 0.85 + 0.15 * this.intensity : 0.5 + 0.4 * this.intensity;
    _g.copy(tp).addScaledVector(tgt.sim.vel, t * lead).sub(muzzle).normalize();
    const spread = (this.battle ? 0.02 : 0.03) * (1.3 - this.intensity);
    _g.x += (this.rng() - 0.5) * spread; _g.y += (this.rng() - 0.5) * spread; _g.z += (this.rng() - 0.5) * spread;
    _g.normalize();
    this.lastShotAt.set(tgt.id, this.time);
    this.stats.fired++;
    this.events.push({ type: 'droneFire', droneId: d.id, pos: muzzle.clone(), dir: _g.clone(), speed, kind: cfg.bolt, targetId: tgt.id, id: d.id * 1000 + (++this.boltSeq % 1000), net: true });
  }

  /** Add an alien bolt locally (from a droneFire event, local or remote). */
  spawnBolt(data) {
    const B = BOLTS[data.kind] || BOLTS.bolt;
    let b = null;
    for (const x of this._bolts) if (!x.alive) { b = x; break; }
    if (!b) { b = { pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), alive: false }; this._bolts.push(b); }
    b.alive = true;
    b.kind = data.kind === 'orb' ? 'orb' : 'bolt';
    b.id = data.id ?? ++this.boltSeq;
    b.owner = data.droneId;
    b.target = data.targetId ?? null;
    b.pos.copy(data.pos); b.prev.copy(data.pos);
    b.vel.copy(data.dir).normalize().multiplyScalar(data.speed || B.speed);
    // Late arrivals (network) start where they would be now.
    const late = clamp(data.late || 0, 0, 0.4);
    if (late > 0) b.pos.addScaledVector(b.vel, late);
    b.life = B.life - late;
    b.age = late;
    b.radius = B.radius;
    b.lost = false;
    return b;
  }

  _updateBolts(dt, ships) {
    for (const b of this._bolts) {
      if (!b.alive) continue;
      const B = BOLTS[b.kind];
      b.age += dt;
      b.life -= dt;
      if (b.life <= 0) { b.alive = false; this.events.push({ type: 'boltFizzle', pos: b.pos.clone(), kind: b.kind }); continue; }
      b.prev.copy(b.pos);
      if (b.kind === 'orb' && b.target != null && !b.lost) {
        const s = this._shipById.get(b.target);
        if (s && s.connected && !s.sim.dead && b.age > 0.25) {
          const sp = b.vel.length();
          _a.copy(b.vel).divideScalar(sp);
          _b.subVectors(s.sim.pos, b.pos).normalize();
          const ang = _a.angleTo(_b);
          if (ang > B.lose && b.age > 0.6) b.lost = true;
          else if (ang > 1e-4) {
            _c.crossVectors(_a, _b);
            if (_c.lengthSq() > 1e-10) { _c.normalize(); _a.applyAxisAngle(_c, Math.min(ang, B.turn * dt)); b.vel.copy(_a).multiplyScalar(sp); }
          }
        }
      }
      b.pos.addScaledVector(b.vel, dt);
      // Ships (contact on any ship stops it; damage only for our own).
      const segLen = b.prev.distanceTo(b.pos);
      _a.subVectors(b.pos, b.prev).divideScalar(segLen || 1);
      let hitShip = null, hitT = Infinity;
      for (const s of ships) {
        const sim = s.sim;
        if (!s.connected || sim.dead) continue;
        const R = sim.p.radius * 1.1 + b.radius;
        _b.subVectors(b.prev, sim.pos);
        const bq = _b.dot(_a), cq = _b.lengthSq() - R * R;
        const disc = bq * bq - cq;
        if (disc < 0) continue;
        const t = -bq - Math.sqrt(disc);
        if (t >= -R && t <= segLen && t < hitT) { hitT = Math.max(0, t); hitShip = s; }
      }
      // Rocks and plasmoids soak bolts: cover.
      let blockT = Infinity;
      if (this.world) { const w = this.world.raycast(b.prev, b.pos, b.radius * 0.5); if (w) blockT = w.t; }
      for (const p of this._plasmoids) {
        if (p.state === 'popped') continue;
        const t = segSphere(b.prev, _a, segLen, p.pos, p.r);
        if (t != null && t < blockT) blockT = t;
      }
      if (blockT < hitT) {
        b.alive = false;
        this.events.push({ type: 'boltImpact', pos: b.prev.clone().addScaledVector(_a, blockT), kind: b.kind, shipId: null });
        continue;
      }
      if (hitShip) {
        b.alive = false;
        const point = b.prev.clone().addScaledVector(_a, hitT);
        this.events.push({ type: 'boltImpact', pos: point, kind: b.kind, shipId: hitShip.id });
        if (hitShip.local !== false && !(hitShip.sim.ghost > 0) && !hitShip.sim.finished) {
          this.stats.boltHits++;
          this.events.push({ type: 'damage', shipId: hitShip.id, amount: B.damage, kind: 'alien', point, stun: B.stun, byId: null, source: b.owner });
          if (B.knock) this.events.push({ type: 'knock', shipId: hitShip.id, impulse: _a.clone().multiplyScalar(B.knock) });
        }
      }
    }
  }

  /** Local ships brushing a drone: a jolt for the ship; the authority kills the drone. */
  _ramChecks(ships) {
    for (let k = this._drones.length - 1; k >= 0; k--) {
      const d = this._drones[k];
      if (!d.alive || d.vis < 0.5 || d.ramCd > 0) continue;
      for (const s of ships) {
        const sim = s.sim;
        if (!s.connected || sim.dead || s.local === false || sim.ghost > 0) continue;
        const min = d.radius + sim.p.radius;
        if (sim.pos.distanceToSquared(d.pos) > min * min) continue;
        d.ramCd = 1;
        _n.subVectors(sim.pos, d.pos).normalize();
        this.events.push({ type: 'damage', shipId: s.id, amount: d.type === 'warden' ? DRONE_DAMAGE_RAM * 2 : DRONE_DAMAGE_RAM, kind: 'alien', point: d.pos.clone(), stun: 0.3, byId: null, source: d.id });
        this.events.push({ type: 'knock', shipId: s.id, impulse: _n.clone().multiplyScalar(30) });
        this.damageDrone(d.id, d.type === 'warden' ? 25 : 999, s.id);
        break;
      }
    }
  }

  // =====================================================================================
  // main update
  /**
   * @param {number} dt
   * @param {{id, sim, connected, local}[]} ships
   * @param {number} time match time in seconds (shared clock)
   */
  update(dt, ships, time) {
    this.time = time;
    this._lastShips = ships;
    const byId = this._shipById || (this._shipById = new Map());
    byId.clear();
    for (const s of ships) byId.set(s.id, s);
    if (!this.battle) {
      const course = this.course;
      for (const s of ships) {
        let info = this.shipInfo.get(s.id);
        if (!info) { info = { i: Number.isInteger(s.sim.trackI) ? s.sim.trackI : Math.round(course.nearestU(s.sim.pos).u * course.sampleCount), u: 0 }; this.shipInfo.set(s.id, info); }
        const loc = course.locate(s.sim.pos, info.i, _loc);
        info.i = loc.i; info.u = loc.u;
      }
    }
    this._evalPlasmoids(dt, ships);
    if (this.authority) {
      if (this.battle) { if (this.waves.interval) this._updateWaves(ships); }
      else this._updateNests(dt, ships);
      this._updateDrones(dt, ships);
    } else this._interpolate(dt);
    this._updateBolts(dt, ships);
    this._ramChecks(ships);
    for (const d of this._drones) { d.proxy.sim.hull = d.hp; }
  }

  // =====================================================================================
  // queries
  /**
   * Segment a->b (thickened by pad) against live drones and plasmoids.
   * @returns {{t:number, kind:'drone'|'plasmoid', id:number, point:THREE.Vector3}|null}
   */
  hitTest(a, b, pad = 0) {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-6) return null;
    _d.divideScalar(len);
    let best = null, bt = Infinity, kind = null;
    for (const p of this._plasmoids) {
      if (p.state !== 'live') continue;
      const t = segSphere(a, _d, len, p.pos, p.r + pad);
      if (t != null && t < bt) { bt = t; best = p; kind = 'plasmoid'; }
    }
    for (const d of this._drones) {
      if (!d.alive || d.vis < 0.4) continue;
      const t = segSphere(a, _d, len, d.pos, d.radius * 1.1 + pad);
      if (t != null && t < bt) { bt = t; best = d; kind = 'drone'; }
    }
    if (!best) return null;
    return { t: bt, kind, id: best.id, point: new THREE.Vector3().copy(a).addScaledVector(_d, bt) };
  }

  /** Splash (missiles): damage every drone and plasmoid within radius. Returns hits. */
  splash(pos, radius, amount, byId) {
    let n = 0;
    for (const p of this._plasmoids) {
      if (p.state !== 'live') continue;
      if (p.pos.distanceTo(pos) < radius + p.r) { this.hitPlasmoid(p.id, amount, byId); n++; }
    }
    for (const d of [...this._drones]) {
      if (!d.alive) continue;
      const dist = d.pos.distanceTo(pos);
      if (dist < radius + d.radius) { this.damageDrone(d.id, amount * (1 - (dist / (radius + d.radius)) * 0.6), byId); n++; }
    }
    return n;
  }

  /** Nearest live plasmoid hit by a->b, shaped like world.raycast (for AI look-ahead). */
  raycastPlasmoids(a, b, pad = 0) {
    _e.subVectors(b, a);
    const len = _e.length();
    if (len < 1e-6) return null;
    _e.divideScalar(len);
    let best = null, bt = Infinity;
    for (const p of this._plasmoids) {
      if (p.state !== 'live') continue;
      // Pad a little extra for the drift during the look-ahead.
      const t = segSphere(a, _e, len, p.pos, p.r + pad + 3);
      if (t != null && t < bt) { bt = t; best = p; }
    }
    if (!best) return null;
    return { t: bt, col: best.aiCol, item: best.aiItem, point: new THREE.Vector3().copy(a).addScaledVector(_e, bt) };
  }

  /**
   * A view of `world` for AI pilots whose raycast() also sees plasmoids (so race AI
   * dodges or shoots them). Everything else reads through to the real world.
   */
  aiWorld(world = this.world) {
    if (this._aiWorld && this._aiWorldBase === world) return this._aiWorld;
    const w = Object.create(world);
    w.raycast = (a, b, pad = 0) => {
      const h1 = world.raycast(a, b, pad);
      const h2 = this.raycastPlasmoids(a, b, pad);
      if (!h2) return h1;
      if (!h1) return h2;
      return h2.t < h1.t ? h2 : h1;
    };
    w.blockersAlong = w.raycast;
    this._aiWorld = w;
    this._aiWorldBase = world;
    return w;
  }

  /** Drones as entity-shaped targets ({id, sim:{pos, vel, quat, dead, hull, ...}}) for AI. */
  get targets() {
    const out = this._targets;
    out.length = 0;
    for (const d of this._drones) if (d.alive && d.vis >= 1 && d.state !== 'lurk' && d.state !== 'emerge' && d.state !== 'burrow') out.push(d.proxy);
    return out;
  }

  /** Drones currently winding up a shot at this ship (HUD "targeted" cue). */
  chargingAt(shipId) {
    let n = 0;
    for (const d of this._drones) if (d.alive && d.charge > 0 && d.target === shipId) n++;
    return n;
  }

  /** Incoming alien bolts heading at a ship within `seconds` (HUD / audio cue). */
  incomingFor(shipId, pos, seconds = 1.2) {
    let n = 0;
    for (const b of this._bolts) {
      if (!b.alive) continue;
      _a.subVectors(pos, b.pos);
      const d = _a.length();
      const closing = b.vel.dot(_a) / (d || 1);
      if (closing > 0 && d / closing < seconds && _a.normalize().dot(_b.copy(b.vel).normalize()) > 0.96) n++;
    }
    void shipId;
    return n;
  }

  get drones() { return this._drones; }
  get plasmoids() { return this._plasmoids; }
  get bolts() { return this._bolts; }

  // =====================================================================================
  // networking
  /** Compact drone states for the host to send ~10 Hz. */
  snapshot() {
    const d = [];
    for (const x of this._drones) {
      if (!x.alive) continue;
      d.push([x.id, x.type === 'warden' ? 1 : 0, r1(x.pos.x), r1(x.pos.y), r1(x.pos.z),
        +x.quat.x.toFixed(3), +x.quat.y.toFixed(3), +x.quat.z.toFixed(3), +x.quat.w.toFixed(3),
        Math.max(0, Math.round(x.hp)), STATE_CODE[x.state] ?? 0, Math.round(x.charge * 100), Math.round(x.vis * 100),
        r1(x.vel.x), r1(x.vel.y), r1(x.vel.z), x.drop ? ['boost', 'missile', 'shield'].indexOf(x.drop) : -1, x.target ?? null]);
    }
    return { t: r2(this.time), d };
  }

  /** Non-authority: buffer a snapshot for interpolation. `now` is the receive time in ms. */
  applySnapshot(s, now = this.clock()) {
    if (this.authority || !s || !Array.isArray(s.d)) return;
    const seen = new Set();
    for (const e of s.d) {
      if (!Array.isArray(e) || e.length < 13 || !e.slice(0, 13).every(Number.isFinite)) continue;
      const id = e[0];
      seen.add(id);
      let d = this.droneById.get(id);
      if (!d) {
        if (this._gone && this._gone.has(id)) continue;
        d = this._newDrone(TYPES[e[1]] || 'skitter', _a.set(e[2], e[3], e[4]), STATES[e[10]] || 'hunt');
        // Use the host's id.
        this.droneById.delete(d.id);
        this.nextDroneId--;
        d.id = id; d.proxy.id = 'vk' + id; d.proxy.droneId = id;
        this.droneById.set(id, d);
        d.buf = [];
        d.quat.set(e[5], e[6], e[7], e[8]).normalize();
        d.drop = e[16] >= 0 ? ['boost', 'missile', 'shield'][e[16]] : null;
      }
      d.buf.push({ t: now, p: [e[2], e[3], e[4]], q: [e[5], e[6], e[7], e[8]], v: [e[13] || 0, e[14] || 0, e[15] || 0] });
      if (d.buf.length > 12) d.buf.shift();
      d.hp = e[9];
      d.state = STATES[e[10]] || d.state;
      d.netCharge = e[11] / 100;
      d.netVis = e[12] / 100;
      d.target = e[17] ?? null;
      d.seen = now;
    }
    void seen;
  }

  _interpolate(dt) {
    const now = this.clock();
    const renderT = now - INTERP_MS;
    for (let k = this._drones.length - 1; k >= 0; k--) {
      const d = this._drones[k];
      if (d.flash > 0) d.flash = Math.max(0, d.flash - dt * 6);
      if (!d.buf || !d.buf.length) continue;
      if (now - d.seen > 1500) { this._removeDrone(d); continue; }
      const buf = d.buf;
      let a = null, b = null;
      for (let i = buf.length - 1; i >= 0; i--) if (buf[i].t <= renderT) { a = buf[i]; b = buf[i + 1] || null; break; }
      if (!a) a = buf[0];
      d.pos.set(a.p[0], a.p[1], a.p[2]);
      d.quat.set(a.q[0], a.q[1], a.q[2], a.q[3]).normalize();
      d.vel.set(a.v[0], a.v[1], a.v[2]);
      if (b) {
        const t = clamp((renderT - a.t) / Math.max(1, b.t - a.t), 0, 1);
        d.pos.lerp(_a.set(b.p[0], b.p[1], b.p[2]), t);
        d.quat.slerp(_q2.set(b.q[0], b.q[1], b.q[2], b.q[3]).normalize(), t);
        d.vel.lerp(_a.set(b.v[0], b.v[1], b.v[2]), t);
      } else {
        d.pos.addScaledVector(d.vel, Math.min(0.3, (renderT - a.t) / 1000));
      }
      d.fwd.copy(FWD).applyQuaternion(d.quat);
      d.charge = d.netCharge || 0;
      d.vis = d.netVis ?? 1;
      if (!this.battle) d.i = this.course.locate(d.pos, d.i, _loc).i;
    }
  }

  /** Plain JSON-safe form of an event with `net: true`, for sendEvent(). */
  static packEvent(ev) {
    const v = (x) => (x ? [r2(x.x), r2(x.y), r2(x.z)] : null);
    switch (ev.type) {
      case 'droneFire': return { type: ev.type, droneId: ev.droneId, pos: v(ev.pos), dir: [+ev.dir.x.toFixed(4), +ev.dir.y.toFixed(4), +ev.dir.z.toFixed(4)], speed: ev.speed, kind: ev.kind, targetId: ev.targetId ?? null, id: ev.id, at: null };
      case 'droneDown': return { type: ev.type, droneId: ev.droneId, pos: v(ev.pos), vel: v(ev.vel), byId: ev.byId ?? null, drop: ev.drop ?? null, dropId: ev.dropId ?? null, droneType: ev.droneType };
      case 'droneGone': return { type: ev.type, droneId: ev.droneId };
      case 'plasmoidPop': return { type: ev.type, id: ev.id, at: r2(ev.at), byId: ev.byId ?? null };
      case 'wave': return { type: ev.type, count: ev.count, n: ev.n, pos: v(ev.pos) };
      case 'ambush': return { type: ev.type, section: ev.section, pos: v(ev.pos) };
      default: return null;
    }
  }

  /**
   * Apply a packed event from another client. Re-emits it locally (remote: true) so the
   * caller can run the same visuals/audio/pickup code for local and remote events.
   * @param {object} data packEvent() output
   * @param {number} [late] seconds since it was sent (optional; bolts start further along)
   */
  applyRemote(data, late = 0) {
    if (!data || typeof data !== 'object') return;
    const vec = (a) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? new THREE.Vector3(a[0], a[1], a[2]) : null);
    switch (data.type) {
      case 'droneFire': {
        const pos = vec(data.pos), dir = vec(data.dir);
        if (!pos || !dir || dir.lengthSq() < 1e-6) return;
        const ev = { type: 'droneFire', droneId: data.droneId, pos, dir: dir.normalize(), speed: clamp(Number(data.speed) || 0, 20, 600), kind: data.kind === 'orb' ? 'orb' : 'bolt', targetId: data.targetId ?? null, id: data.id, remote: true, late };
        // Remote drones are interpolated in the past: make the muzzle flash show.
        const d = this.droneById.get(data.droneId);
        if (d) d.flash = Math.max(d.flash, 0.3);
        this.events.push(ev);
        return;
      }
      case 'droneDown': {
        const pos = vec(data.pos);
        if (!pos) return;
        const d = this.droneById.get(data.droneId);
        if (d) this._removeDrone(d);
        (this._gone ||= new Set()).add(data.droneId);
        this.events.push({ type: 'droneDown', droneId: data.droneId, pos, vel: vec(data.vel) || new THREE.Vector3(), byId: data.byId ?? null, drop: ['boost', 'missile', 'shield'].includes(data.drop) ? data.drop : null, dropId: typeof data.dropId === 'string' ? data.dropId : null, droneType: data.droneType === 'warden' ? 'warden' : 'skitter', remote: true });
        return;
      }
      case 'droneGone': {
        const d = this.droneById.get(data.droneId);
        if (d) this._removeDrone(d);
        (this._gone ||= new Set()).add(data.droneId);
        this.events.push({ type: 'droneGone', droneId: data.droneId, remote: true });
        return;
      }
      case 'plasmoidPop': if (Number.isInteger(data.id)) this.popPlasmoid(data.id, Number(data.at), data.byId ?? null); return;
      case 'wave': this.events.push({ type: 'wave', count: data.count | 0, n: data.n | 0, pos: vec(data.pos), remote: true }); return;
      case 'ambush': this.events.push({ type: 'ambush', section: data.section | 0, pos: vec(data.pos), remote: true }); return;
      default:
    }
  }

  dispose() {
    this._plasmoids.length = 0;
    this._drones.length = 0;
    this._bolts.length = 0;
    this.droneById.clear();
    this.events.length = 0;
  }
}

// ------------------------------------------------------------------------------ helpers
/** Ray (origin o, unit dir d, length len) vs sphere: entry distance or null. */
function segSphere(o, d, len, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cq = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cq;
  if (disc < 0) return null;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = cq < 0 ? 0 : -b + Math.sqrt(disc);
  if (t < 0 || t > len) return null;
  return t;
}

function randUnit(rng, out) {
  const z = rng() * 2 - 1, a = rng() * TAU, s = Math.sqrt(1 - z * z);
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
}

function randInBall(rng, r) {
  for (;;) {
    const x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1;
    if (x * x + y * y + z * z <= 1) return new THREE.Vector3(x, y, z).multiplyScalar(r);
  }
}
