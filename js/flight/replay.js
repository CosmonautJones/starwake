// Replays: a rolling buffer of every ship's transform, highlight clips copied out of it,
// and the player that shows them (the finish replay, and highlights on the results
// screen). Cosmetic only: playback reads the buffer and moves meshes and the camera; it
// never steps or pauses the race, so in multiplayer the match keeps simulating underneath.
//
// Buffer: a fixed ring of REC_HZ frames x BUFFER_SECONDS, one Float32Array, allocated once.
// Per ship per frame: position, orientation, visual roll (bank + dodge roll), and flags with
// the engine thrust packed in the fraction. Ship explosions are kept as timed events.
//
// No DOM here: tools/replay-sim.mjs imports this under Node.

import * as THREE from 'three';

export const REC_HZ = 30;
export const BUFFER_SECONDS = 7;
export const MAX_HIGHLIGHTS = 3;
const S = 9; // floats per ship per frame: px py pz qx qy qz qw roll flags+thrust
const F_VIS = 1, F_BOOST = 2, F_SONIC = 4;
const THRUST_K = 1.1;
const MAX_EVENTS = 48;
const TELEPORT = 60; // gap between frames that means a respawn: snap, don't glide

/** Highlight kinds (all involve the local player). pri decides what to keep when full. */
export const KINDS = {
  demo: { pre: 2.6, post: 1.6, pri: 3, label: 'Demolition' },
  demoed: { pre: 2.4, post: 1.6, pri: 3, label: 'Demolished' },
  photo: { pre: 3, post: 0.9, pri: 2, label: 'Photo finish' },
  nearMiss: { pre: 2, post: 1.2, pri: 1, label: 'Supersonic near miss' },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class ReplayBuffer {
  constructor(count, { seconds = BUFFER_SECONDS, hz = REC_HZ } = {}) {
    this.count = count;
    this.hz = hz;
    this.iv = 1 / hz;
    this.seconds = seconds;
    this.cap = Math.ceil(seconds * hz) + 1;
    this.stride = 1 + count * S;
    this.data = new Float32Array(this.cap * this.stride);
    this.head = 0;
    this.size = 0;
    this.events = [];
    this.clock = 0;
    this.acc = this.iv; // record on the very first step
  }

  get bytes() { return this.data.byteLength + this.events.length * 64; }

  /** Advance the clock by one fixed step; records a frame every 1/hz. */
  step(dt, entities) {
    this.clock += dt;
    this.acc += dt;
    if (this.acc + 1e-9 < this.iv) return;
    this.acc = Math.min(this.iv, Math.max(0, this.acc - this.iv));
    this.push(this.clock, entities);
  }

  push(t, entities) {
    const D = this.data, o = this.head * this.stride;
    D[o] = t;
    for (let i = 0; i < this.count; i++) {
      const e = entities[i], k = o + 1 + i * S;
      if (!e) { D[k + 8] = 0; continue; }
      const sim = e.sim, p = sim.pos, q = sim.quat;
      D[k] = p.x; D[k + 1] = p.y; D[k + 2] = p.z;
      D[k + 3] = q.x; D[k + 4] = q.y; D[k + 5] = q.z; D[k + 6] = q.w;
      D[k + 7] = e.visRoll || 0;
      const top = sim.p?.topSpeed || 1;
      const thrust = Math.max(e.input?.throttle || 0, clamp(Math.abs(sim.forwardSpeed || 0) / top, 0, 1.5) * 0.7);
      const flags = (e.connected !== false && !sim.dead ? F_VIS : 0) | (sim.boosting ? F_BOOST : 0) | (sim.supersonic ? F_SONIC : 0);
      D[k + 8] = flags + Math.min(0.999, thrust / THRUST_K);
    }
    this.head = (this.head + 1) % this.cap;
    this.size = Math.min(this.cap, this.size + 1);
  }

  /** A ship exploded (or was demolished): replayed as an explosion + debris. */
  event(type, i, pos, vel, extra = {}) {
    this.events.push({ t: this.clock, type, i, p: [pos.x, pos.y, pos.z], v: vel ? [vel.x, vel.y, vel.z] : [0, 0, 0], ...extra });
    const old = this.clock - this.seconds;
    while (this.events.length && (this.events.length > MAX_EVENTS || this.events[0].t < old)) this.events.shift();
  }

  _slot(k) { return (this.head - this.size + k + this.cap) % this.cap; }
  frameTime(k) { return this.data[this._slot(k) * this.stride]; }

  /** Copy frames covering [t0, t1] into a standalone clip (null if there's too little). */
  slice(t0, t1, meta = {}) {
    let a = -1, b = -1;
    for (let k = 0; k < this.size; k++) {
      const t = this.frameTime(k);
      if (t >= t0 - this.iv && a < 0) a = k;
      if (t <= t1 + this.iv) b = k;
    }
    if (a < 0 || b - a < 3) return null;
    const n = b - a + 1, st = this.stride;
    const out = new Float32Array(n * st);
    for (let k = 0; k < n; k++) {
      const s = this._slot(a + k) * st;
      out.set(this.data.subarray(s, s + st), k * st);
    }
    const ta = out[0], tb = out[(n - 1) * st];
    const events = this.events.filter((e) => e.t >= ta && e.t <= tb).map((e) => ({ ...e }));
    return new Clip(this.count, st, out, n, events, meta);
  }
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class Clip {
  constructor(count, stride, data, n, events, meta = {}) {
    this.count = count; this.stride = stride; this.data = data; this.n = n; this.events = events;
    this.t0 = data[0];
    this.t1 = data[(n - 1) * stride];
    this.kind = meta.kind || 'clip';
    this.label = meta.label || '';
    this.at = meta.at ?? this.t1;
    this.focus = meta.focus ?? 0;
    this.pri = meta.pri ?? 0;
  }

  get bytes() { return this.data.byteLength + this.events.length * 64; }
  get duration() { return this.t1 - this.t0; }

  /** Index of the last frame at or before t. */
  _find(t) {
    const D = this.data, st = this.stride;
    let lo = 0, hi = this.n - 1;
    if (t <= D[0]) return 0;
    if (t >= D[hi * st]) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m * st] <= t) lo = m; else hi = m; }
    return lo;
  }

  /** Ship i at time t -> out { pos, quat (flight attitude), roll, vis, boost, sonic, thrust }. */
  sample(t, i, out) {
    const D = this.data, st = this.stride;
    const a = this._find(t), b = Math.min(this.n - 1, a + 1);
    const ka = a * st + 1 + i * S, kb = b * st + 1 + i * S;
    const ta = D[a * st], tb = D[b * st];
    let k = tb > ta ? clamp((t - ta) / (tb - ta), 0, 1) : 0;
    const fa = Math.floor(D[ka + 8]), fb = Math.floor(D[kb + 8]);
    const jump = Math.hypot(D[kb] - D[ka], D[kb + 1] - D[ka + 1], D[kb + 2] - D[ka + 2]) > TELEPORT;
    if (jump || (fa & F_VIS) !== (fb & F_VIS)) k = k < 0.5 ? 0 : 1;
    const ks = k < 0.5 ? ka : kb, fs = k < 0.5 ? fa : fb;
    out.pos.set(D[ka] + (D[kb] - D[ka]) * k, D[ka + 1] + (D[kb + 1] - D[ka + 1]) * k, D[ka + 2] + (D[kb + 2] - D[ka + 2]) * k);
    _qa.set(D[ka + 3], D[ka + 4], D[ka + 5], D[ka + 6]);
    _qb.set(D[kb + 3], D[kb + 4], D[kb + 5], D[kb + 6]);
    out.quat.copy(_qa).slerp(_qb, k);
    out.roll = D[ka + 7] + (D[kb + 7] - D[ka + 7]) * k;
    out.vis = !!(fs & F_VIS);
    out.boost = !!(fs & F_BOOST);
    out.sonic = !!(fs & F_SONIC);
    out.thrust = (D[ks + 8] - fs) * THRUST_K;
    return out;
  }
}

/** Marks highlight moments and copies their clips out of the buffer once the moment has played out. */
export class Highlights {
  constructor(max = MAX_HIGHLIGHTS) {
    this.max = max;
    this.clips = [];
    this.pending = [];
  }

  get bytes() { return this.clips.reduce((s, c) => s + c.bytes, 0); }

  mark(kind, at, focus = 0) {
    const K = KINDS[kind];
    if (!K) return false;
    for (const h of this.pending) {
      if (Math.abs(h.at - at) >= 2.5) continue;
      if (K.pri > h.pri) Object.assign(h, { kind, at, pre: K.pre, post: K.post, pri: K.pri, label: K.label });
      return false;
    }
    for (const c of this.clips) if (Math.abs(c.at - at) < 2.5) return false;
    this.pending.push({ kind, at, focus, pre: K.pre, post: K.post, pri: K.pri, label: K.label });
    if (this.pending.length > this.max * 2) this.pending.shift();
    return true;
  }

  /** Capture clips whose moment has played out (force: capture whatever is there now). */
  update(buffer, force = false) {
    for (let j = this.pending.length - 1; j >= 0; j--) {
      const h = this.pending[j];
      if (!force && buffer.clock < h.at + h.post) continue;
      this.pending.splice(j, 1);
      const clip = buffer.slice(h.at - h.pre, h.at + h.post, h);
      if (clip) this._add(clip);
    }
  }

  _add(clip) {
    const C = this.clips;
    if (clip.kind === 'nearMiss' && C.some((c) => c.kind === 'nearMiss')) return;
    if (C.length >= this.max) {
      let worst = 0;
      for (let j = 1; j < C.length; j++) if (C[j].pri < C[worst].pri) worst = j;
      if (C[worst].pri >= clip.pri) return;
      C.splice(worst, 1);
    }
    C.push(clip);
    C.sort((a, b) => a.at - b.at);
  }
}

// ---------------------------------------------------------------- playback
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();
const ZAXIS = new THREE.Vector3(0, 0, 1);
const mkSample = () => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), roll: 0, vis: false, boost: false, sonic: false, thrust: 0 });

/** Plays clips back-to-back with cuts between a chase, a trackside and a low pass-by camera. */
export class ReplayPlayer {
  constructor(race, clips, { reduce = false } = {}) {
    this.race = race;
    this.clips = clips;
    this.reduce = reduce;
    this.k = -1;
    this.age = 0;
    this.done = false;
    this.s = mkSample();
    this.f = mkSample();
    this.focusPos = new THREE.Vector3();
    this._next();
  }

  get clip() { return this.clips[this.k]; }

  _next() {
    this.k++;
    const c = this.clip;
    if (!c) { this.done = true; return; }
    this.t = c.t0;
    this.ev = 0;
    while (this.ev < c.events.length && c.events[this.ev].t < c.t0) this.ev++;
    // Shots: chase, trackside, then a low pass-by that catches the moment itself.
    const D = c.duration, at = clamp(c.at, c.t0, c.t1);
    const s3 = clamp(at - 0.9, c.t0 + D * 0.4, c.t1 - 0.4);
    const s2 = c.t0 + (s3 - c.t0) * 0.5;
    const side = this.k % 2 ? -1 : 1;
    this.shots = [
      { type: 'chase', from: c.t0, to: s2 },
      { type: 'trackside', from: s2, to: s3, anchor: (s2 + s3) / 2 + 0.15, side },
      { type: 'low', from: s3, to: c.t1, anchor: clamp(at, s3 + 0.2, c.t1 - 0.05), side: -side },
    ];
    for (const sh of this.shots) sh.cam = null;
  }

  /** Playback speed: slow motion, slowest around the moment (real time with reduce motion). */
  _rate() {
    if (this.reduce) return 1;
    const c = this.clip, d = Math.abs(this.t - c.at);
    const w = clamp((d - 0.4) / 0.5, 0, 1);
    return 0.38 + (0.68 - 0.38) * w * w * (3 - 2 * w);
  }

  update(dt) {
    if (this.done) return;
    this.age += dt;
    const c = this.clip;
    this.t += dt * this._rate();
    while (this.ev < c.events.length && c.events[this.ev].t <= this.t) this._fire(c.events[this.ev++]);
    if (this.t >= c.t1) this._next();
  }

  _fire(ev) {
    const race = this.race, e = race.entities[ev.i];
    if (!e || ev.type !== 'boom') return;
    const pos = _a.fromArray(ev.p), vel = _b.fromArray(ev.v);
    this.clip.sample(ev.t - 0.01, ev.i, this.s);
    race.explosions?.spawn({ position: pos, size: 1.3, color: e.color.clone().lerp(new THREE.Color('#ffb36b'), 0.6), velocity: vel.clone().multiplyScalar(0.3) });
    race.debris?.shipBreak(e.craft, { position: pos, quaternion: this.s.quat, velocity: vel, intensity: ev.demo ? 1.6 : 1 });
    const distance = race._distN ? race._distN(pos) : 0;
    race.onEvent({ type: 'explosion', size: 1, ship: true, distance });
    if (ev.demo) race.onEvent({ type: 'demolition', distance });
  }

  /** Pose an entity's mesh from the clip. */
  place(e) {
    const c = this.clip;
    if (!c) return false;
    const s = c.sample(this.t, e.index, this.s), root = e.craft.root;
    root.position.copy(s.pos);
    root.quaternion.copy(s.quat).multiply(_q.setFromAxisAngle(ZAXIS, s.roll));
    root.visible = s.vis && e.connected;
    e.craft.setThrust(clamp(s.thrust, 0, 1.2), s.boost ? 1 : 0, this.race.time, 1);
    root.updateMatrixWorld();
    return true;
  }

  camera(cam) {
    const c = this.clip;
    if (!c) return;
    const f = c.sample(this.t, c.focus, this.f);
    this.focusPos.copy(f.pos);
    let shot = this.shots[0];
    for (const sh of this.shots) if (this.t >= sh.from) shot = sh;
    const up = _c.set(0, 1, 0).applyQuaternion(f.quat);
    if (shot.type === 'chase') {
      cam.position.copy(f.pos).add(_a.set(3.5, 3.4, 13).applyQuaternion(f.quat));
      cam.up.copy(up);
      cam.lookAt(_b.copy(f.pos).add(_a.set(0, 0.6, -12).applyQuaternion(f.quat)));
      cam.fov = 60;
    } else {
      if (!shot.cam) {
        // Fixed camera beside the line where the ship will be at `anchor`.
        const a = c.sample(shot.anchor, c.focus, mkSample());
        const low = shot.type === 'low';
        const off = _a.set(shot.side * (low ? 5.5 : 20), low ? -2.2 : 6, low ? -1 : -6).applyQuaternion(a.quat);
        shot.cam = a.pos.clone().add(off);
        shot.up = new THREE.Vector3(0, 1, 0).applyQuaternion(a.quat);
        this._insideTunnel(shot.cam, a.pos);
      }
      cam.position.copy(shot.cam);
      cam.up.copy(shot.up);
      cam.lookAt(f.pos);
      // Trackside zooms to keep the ship framed as it closes in; the low camera stays wide.
      cam.fov = shot.type === 'low' ? 72 : clamp(2 * Math.atan(10 / Math.max(1, shot.cam.distanceTo(f.pos))) * 180 / Math.PI, 16, 50);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Keep a fixed camera inside the wormhole wall. */
  _insideTunnel(p, ref) {
    const course = this.race.course;
    if (this.race.battle || !course?.nearestU) return;
    const { u } = course.nearestU(ref);
    const centre = course.pointAt(u, _b), R = course.tunnelRadiusAt(u) * 0.8;
    const d = _c.subVectors(p, centre);
    if (d.length() > R) p.copy(centre).addScaledVector(d.normalize(), R);
  }
}

/** One per match: records, marks highlights, triggers the finish replay, runs playback. */
export class ReplayDirector {
  constructor(race) {
    this.race = race;
    this.reduce = !!race.settings?.reduceMotion;
    this.buffer = new ReplayBuffer(race.entities.length);
    this.highlights = new Highlights();
    this.player = null;
    this.onDone = null;
    this.after = [];
    this.finishAt = null;
    this.finishPlayed = false;
    this.photoDone = false;
  }

  get playing() { return !!this.player; }
  get clips() { return this.highlights.clips; }
  get hasHighlights() { return this.highlights.clips.length + this.highlights.pending.length > 0; }

  /** Once per fixed step. */
  step(dt, racing) { if (racing) this.buffer.step(dt, this.race.entities); }

  explosion(e) {
    if (e?.index == null) return;
    this.buffer.event('boom', e.index, e.sim.pos, e.sim.vel, { demo: e.sim.lastKind === 'demo' });
  }

  /** A highlight moment for the local player, now (or at buffer time `at`). */
  mark(kind, at = this.buffer.clock) {
    const p = this.race.player;
    if (!p || this.race.mode === 'attract') return false;
    return this.highlights.mark(kind, at, p.index);
  }

  demolition(killer, victim) {
    const p = this.race.player;
    if (!p || !killer || killer === victim) return;
    if (killer === p) this.mark('demo');
    else if (victim === p) this.mark('demoed');
  }

  /** Once per frame, after the race's own finish logic. */
  update(dt) {
    const race = this.race, p = race.player;
    this.highlights.update(this.buffer);
    if (p && !race.battle && p.finishTime != null) {
      if (this.finishAt == null) this.finishAt = this.buffer.clock;
      if (!this.photoDone) {
        for (const e of race.entities) {
          if (e !== p && e.connected && e.finishTime != null && Math.abs(e.finishTime - p.finishTime) <= 0.3) { this.mark('photo', this.finishAt); this.photoDone = true; break; }
        }
        if (race.raceTime - p.finishTime > 0.4) this.photoDone = true;
      }
      if (!this.finishPlayed && this.buffer.clock - this.finishAt >= (this.reduce ? 0.6 : 0.8)) {
        this.finishPlayed = true;
        const pre = this.reduce ? 2.2 : 3.2;
        const clip = this.buffer.slice(this.finishAt - pre, this.buffer.clock, { kind: 'finish', label: 'Finish', at: this.finishAt, focus: p.index });
        if (clip) this.play([clip]);
      }
    }
    if (this.player) {
      this.player.update(dt);
      if (this.player.done) this._end();
    }
  }

  play(clips, onDone = null) {
    if (this.player) this._end(true);
    this.player = new ReplayPlayer(this.race, clips, { reduce: this.reduce });
    this.onDone = onDone;
    const wv = this.race.weaponView;
    if (wv?.bolts) { wv.bolts.visible = false; wv.cores.visible = false; }
    this.race.onEvent({ type: 'replay', on: true });
  }

  /** Results screen: every highlight back to back. Returns false if there are none. */
  playHighlights(onDone) {
    this.highlights.update(this.buffer, true);
    if (!this.clips.length) return false;
    this.play(this.clips.slice(), onDone);
    return true;
  }

  /** Skip (ignored for a moment after a replay starts, so the key that started it doesn't end it). */
  skip() {
    if (!this.player || this.player.age < 0.35) return false;
    this._end();
    return true;
  }

  /** Run fn when the current replay ends (now if none is playing). */
  afterPlay(fn) { if (this.player) this.after.push(fn); else fn(); }

  _end(quiet = false) {
    this.player = null;
    const wv = this.race.weaponView;
    if (wv?.bolts) { wv.bolts.visible = true; wv.cores.visible = true; }
    for (const e of this.race.entities) for (const t of e.trails || []) t.trail.reset();
    if (quiet) return;
    const done = this.onDone, after = this.after;
    this.onDone = null; this.after = [];
    this.race.onEvent({ type: 'replay', on: false });
    done?.();
    for (const fn of after) fn();
  }

  // Hooks for the race's render pass.
  place(e) { return this.player ? this.player.place(e) : false; }
  camera(cam) { this.player?.camera(cam); }
  focusPos() { return this.player ? this.player.focusPos : null; }
  hudState() {
    const pl = this.player;
    if (!pl || !pl.clip) return null;
    return { label: pl.clip.label, index: pl.k + 1, count: pl.clips.length, kind: pl.clip.kind };
  }

  dispose() { this.player = null; this.onDone = null; this.after = []; }
}
