// Ghost runs (solo races): record the player's ship at a fixed rate, pack it small enough
// for localStorage, and play it back as a time-indexed track with a live delta.
//
// Pure data: no DOM, no rendering (the holographic mesh lives in js/space/ghostView.js),
// so tools/replay-sim.mjs can run it under Node.
//
// Packed sample (13 bytes): position delta 3 x Int16 (POS_Q units), orientation 4 x Int8,
// course-distance delta Int16 (DIST_Q units), flags Uint8 (1 visible, 2 boosting).
// Deltas are taken against the reconstructed previous sample, so quantization never drifts.

import * as THREE from 'three';

export const GHOST_HZ = 12;
export const GHOST_VERSION = 1;
/** Max characters of ghost JSON kept in localStorage across every course. */
export const GHOST_BUDGET = 320_000;
const POS_Q = 0.05, DIST_Q = 0.05, BYTES = 13;
const F_VIS = 1, F_BOOST = 2;
const I16 = 32767;

const clampI = (v, m) => Math.max(-m, Math.min(m, Math.round(v)));

export function ghostKey(courseId, laps) { return `${courseId}:${laps}`; }

/** Samples a ship every 1/hz seconds of race clock (call tick() once per fixed step). */
export class GhostRecorder {
  constructor(hz = GHOST_HZ) {
    this.hz = hz;
    this.clock = 0;
    this.next = 0;
    this.samples = []; // [x, y, z, qx, qy, qz, qw, dist, flags]
    this.done = false;
  }

  tick(dt, sim) {
    if (this.done) return;
    this.clock += dt;
    while (this.clock + 1e-9 >= this.next) {
      const p = sim.pos, q = sim.quat;
      this.samples.push([p.x, p.y, p.z, q.x, q.y, q.z, q.w, sim.dist, (sim.dead ? 0 : F_VIS) | (sim.boosting ? F_BOOST : 0)]);
      this.next = this.samples.length / this.hz;
    }
  }

  /** Freeze the run. meta: { course, laps, time, design }. Returns the packed ghost. */
  finish(meta) {
    this.done = true;
    return encodeGhost(this.samples, { ...meta, hz: this.hz });
  }
}

// ---------------------------------------------------------------- packing
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** samples: [[x,y,z,qx,qy,qz,qw,dist,flags], ...] -> a plain JSON-safe object. */
export function encodeGhost(samples, { course, laps, time, design, hz = GHOST_HZ }) {
  const n = samples.length;
  const bytes = new Uint8Array(n * BYTES);
  const dv = new DataView(bytes.buffer);
  const s0 = samples[0] || [0, 0, 0, 0, 0, 0, 1, 0, 0];
  let px = s0[0], py = s0[1], pz = s0[2], pd = s0[7];
  for (let i = 0; i < n; i++) {
    const s = samples[i], o = i * BYTES;
    const dx = clampI((s[0] - px) / POS_Q, I16), dy = clampI((s[1] - py) / POS_Q, I16), dz = clampI((s[2] - pz) / POS_Q, I16);
    const dd = clampI((s[7] - pd) / DIST_Q, I16);
    px += dx * POS_Q; py += dy * POS_Q; pz += dz * POS_Q; pd += dd * DIST_Q;
    dv.setInt16(o, dx, true); dv.setInt16(o + 2, dy, true); dv.setInt16(o + 4, dz, true);
    // Canonical hemisphere (w >= 0) so the Int8 rounding is symmetric.
    const sg = s[6] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) dv.setInt8(o + 6 + k, clampI(s[3 + k] * sg * 127, 127));
    dv.setInt16(o + 10, dd, true);
    bytes[o + 12] = s[8] & 255;
  }
  return {
    v: GHOST_VERSION, course, laps, time: +(+time).toFixed(3), hz, n,
    o: [s0[0], s0[1], s0[2], s0[7]].map((v) => +v.toFixed(3)),
    design: design || null, data: toB64(bytes), savedAt: Date.now(),
  };
}

/** Returns a GhostTrack, or null if the object isn't a usable ghost. */
export function decodeGhost(g) {
  try {
    if (!g || g.v !== GHOST_VERSION || !Number.isFinite(g.n) || g.n < 2 || !Array.isArray(g.o) || typeof g.data !== 'string') return null;
    const bytes = fromB64(g.data);
    if (bytes.length !== g.n * BYTES) return null;
    return new GhostTrack(bytes, g);
  } catch {
    return null;
  }
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

export class GhostTrack {
  constructor(bytes, g) {
    const n = g.n;
    this.n = n; this.hz = g.hz || GHOST_HZ; this.time = g.time; this.design = g.design;
    this.course = g.course; this.laps = g.laps;
    this.pos = new Float32Array(n * 3);
    this.quat = new Float32Array(n * 4);
    this.dist = new Float32Array(n);
    this.reach = new Float32Array(n); // running max of dist: the furthest the ghost had got by sample i
    this.flags = new Uint8Array(n);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let x = g.o[0], y = g.o[1], z = g.o[2], d = g.o[3], reach = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * BYTES;
      x += dv.getInt16(o, true) * POS_Q; y += dv.getInt16(o + 2, true) * POS_Q; z += dv.getInt16(o + 4, true) * POS_Q;
      d += dv.getInt16(o + 10, true) * DIST_Q;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      _qa.set(dv.getInt8(o + 6), dv.getInt8(o + 7), dv.getInt8(o + 8), dv.getInt8(o + 9)).normalize();
      this.quat.set([_qa.x, _qa.y, _qa.z, _qa.w], i * 4);
      this.dist[i] = d;
      reach = Math.max(reach, d);
      this.reach[i] = reach;
      this.flags[i] = bytes[o + 12];
    }
    this.duration = (n - 1) / this.hz;
  }

  /** Interpolated pose at race-clock t. Returns false when the ghost isn't there (wrecked, or done). */
  sample(t, pos, quat, out = {}) {
    if (t < 0 || t > this.duration) return false;
    const f = t * this.hz, i = Math.min(this.n - 2, Math.floor(f)), k = f - i;
    const fa = this.flags[i], fb = this.flags[i + 1];
    if (!(fa & F_VIS)) return false;
    const P = this.pos, Q = this.quat;
    const cut = !(fb & F_VIS) || Math.hypot(P[i * 3 + 3] - P[i * 3], P[i * 3 + 4] - P[i * 3 + 1], P[i * 3 + 5] - P[i * 3 + 2]) > 80; // respawn jump
    const j = cut ? i : i + 1, kk = cut ? 0 : k;
    pos.set(P[i * 3] + (P[j * 3] - P[i * 3]) * kk, P[i * 3 + 1] + (P[j * 3 + 1] - P[i * 3 + 1]) * kk, P[i * 3 + 2] + (P[j * 3 + 2] - P[i * 3 + 2]) * kk);
    _qa.fromArray(Q, i * 4); _qb.fromArray(Q, j * 4);
    quat.copy(_qa).slerp(_qb, kk);
    out.boost = !!(fa & F_BOOST);
    return true;
  }

  /** Course distance the ghost had covered at race-clock t. */
  distAt(t) {
    const f = Math.max(0, Math.min(this.duration, t)) * this.hz, i = Math.min(this.n - 2, Math.floor(f)), k = f - i;
    return this.dist[i] + (this.dist[i + 1] - this.dist[i]) * k;
  }

  /** Race-clock time at which the ghost first got as far as course distance d (null if it never did). */
  timeAtDist(d) {
    const R = this.reach;
    if (d <= R[0]) return 0;
    if (d > R[this.n - 1]) return null;
    let lo = 0, hi = this.n - 1; // R[lo] < d <= R[hi]
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m] >= d) hi = m; else lo = m; }
    const span = R[hi] - R[lo];
    return (lo + (span > 1e-6 ? (d - R[lo]) / span : 1)) / this.hz;
  }

  /**
   * Seconds behind (+) or ahead (-) of the ghost, comparing course progress at matching
   * times: now minus when the ghost reached the distance you're at. Null if not comparable.
   */
  delta(t, dist) {
    const tg = this.timeAtDist(dist);
    if (tg == null) return null;
    return t - tg;
  }
}

/**
 * Keep the stored ghosts under budget (characters of JSON): drop the oldest-saved first,
 * never `keepKey`. Mutates and returns `all`.
 */
export function pruneGhosts(all, budget = GHOST_BUDGET, keepKey = null) {
  const size = () => JSON.stringify(all).length;
  while (size() > budget) {
    const keys = Object.keys(all).filter((k) => k !== keepKey);
    if (!keys.length) break;
    keys.sort((a, b) => (all[a]?.savedAt || 0) - (all[b]?.savedAt || 0));
    delete all[keys[0]];
  }
  return all;
}
