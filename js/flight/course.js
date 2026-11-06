// The racing line of a wormhole course: a closed spline the tunnel follows, the
// tunnel's radius along it, and the optional boost gates floating inside.

import * as THREE from 'three';
import { mulberry32, hashString } from '../core/util.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Course {
  constructor(def) {
    this.def = def;
    const pts = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    this.length = this.curve.getLength();
    // Split lanes: stretches where the tube widens round a solid divider (see _initSplits).
    this.splits = [];
    this._initSplits();

    // Dense samples for fast nearest-point and placement queries.
    const n = Math.round(this.length / 6);
    this.samples = this.curve.getSpacedPoints(n).slice(0, n);
    this.sampleCount = n;
    this.step = this.length / n;
    // Curvature (1/turn radius) per sample, for AI speed planning.
    this.curv = new Float32Array(n);
    const k = 4;
    for (let i = 0; i < n; i++) {
      const a = this.samples[(i - k + n) % n], b = this.samples[i], c = this.samples[(i + k) % n];
      const ab = a.distanceTo(b), bc = b.distanceTo(c), ac = a.distanceTo(c);
      const sp = (ab + bc + ac) / 2;
      const area = Math.sqrt(Math.max(0, sp * (sp - ab) * (sp - bc) * (sp - ac)));
      this.curv[i] = area > 1e-6 ? (4 * area) / (ab * bc * ac) : 0;
    }

    // Boost gates (fractions of the lap), inside the wormhole. Each sits off-centre
    // by a seeded amount so taking them is a racing-line choice; they're optional.
    const rng = mulberry32(hashString(def.id) + 911);
    const count = Math.max(6, Math.round(this.length / def.ringSpacing));
    this.rings = [];
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      if (u < 0.04 || u > 0.97) continue; // keep the start straight clean
      const f = this.frameAt(u);
      const R = this.tunnelRadiusAt(u);
      const radius = Math.min(def.ringRadius, R * 0.55);
      const room = Math.max(0, R - radius - 8);
      const a = rng() * Math.PI * 2, m = (0.25 + rng() * 0.6) * room;
      const pos = f.pos.clone().addScaledVector(f.R, Math.cos(a) * m).addScaledVector(f.U, Math.sin(a) * m);
      // Through a split, gates stay in the wide safe channel, clear of the divider.
      const sp = this.splitAt(u, 30 / this.length);
      if (sp) {
        const ax = sp.axis === 'up' ? f.U : f.R;
        const lat = pos.clone().sub(f.pos).dot(ax) * sp.side;
        const lim = sp.offset - sp.thick - radius - 6;
        if (lat > lim) pos.addScaledVector(ax, sp.side * (Math.min(-lat, lim) - lat));
      }
      this.rings.push({ index: this.rings.length, u, pos, normal: f.T, right: f.R, up: f.U, radius, finish: false, station: false });
    }
  }

  /**
   * Where a point sits along the line, by hill-climbing from a hint sample (cheap
   * enough to run every physics step). Writes into `out` and returns it:
   * { i, u, c: centre on the line, t: unit tangent }.
   */
  locate(p, hint, out, maxWalk = 0) {
    const n = this.sampleCount, S = this.samples;
    let i = ((hint % n) + n) % n;
    let d = S[i].distanceToSquared(p);
    // maxWalk (samples) caps how far one call may move along the line, so a ship can never
    // be pulled onto another stretch of tube that passes close by (crossover courses).
    const walk = maxWalk > 0 ? Math.min(n, maxWalk) : n;
    for (let guard = 0; guard < walk; guard++) {
      const a = S[(i + 1) % n].distanceToSquared(p), b = S[(i - 1 + n) % n].distanceToSquared(p);
      if (a < d && a <= b) { i = (i + 1) % n; d = a; } else if (b < d) { i = (i - 1 + n) % n; d = b; } else break;
    }
    // Project onto the neighbouring segment on the nearer side.
    const nx = (i + 1) % n, pv = (i - 1 + n) % n;
    const j0 = S[nx].distanceToSquared(p) < S[pv].distanceToSquared(p) ? i : pv;
    const A = S[j0], B = S[(j0 + 1) % n];
    const t = out.t.subVectors(B, A);
    const len2 = t.lengthSq() || 1;
    const k = Math.min(1, Math.max(0, out.c.subVectors(p, A).dot(t) / len2));
    out.c.copy(A).addScaledVector(t, k);
    t.divideScalar(Math.sqrt(len2));
    out.i = i;
    out.u = ((j0 + k) / n) % 1;
    return out;
  }

  pointAt(u, out = new THREE.Vector3()) { return this.curve.getPointAt(((u % 1) + 1) % 1, out); }
  tangentAt(u, out = new THREE.Vector3()) { return this.curve.getTangentAt(((u % 1) + 1) % 1, out).normalize(); }

  /** A stable frame along the line: T forward, R right, U up (world-up biased). */
  frameAt(u) {
    const pos = this.pointAt(u);
    const T = this.tangentAt(u);
    const R = new THREE.Vector3().crossVectors(T, UP);
    if (R.lengthSq() < 1e-6) R.set(1, 0, 0);
    R.normalize();
    const U = new THREE.Vector3().crossVectors(R, T).normalize();
    return { pos, T, R, U };
  }

  /**
   * Wormhole radius at u. def.tunnel = { radius, pinches: [{ at, len, radius }] };
   * pinches ease in and out smoothly over `len` (a fraction of the lap).
   */
  tunnelRadiusAt(u) {
    const t = this.def.tunnel || { radius: 60 };
    let r = t.radius;
    for (const p of t.pinches || []) {
      let d = Math.abs((((u - p.at) % 1) + 1.5) % 1 - 0.5);
      if (d < p.len) {
        const k = 0.5 + 0.5 * Math.cos((d / p.len) * Math.PI);
        r = Math.min(r, t.radius + (p.radius - t.radius) * k);
      }
    }
    // Split lanes widen the tube: full width along the divider, easing in and out round it.
    for (const sp of this.splits) {
      const d = Math.abs((((u - sp.at) % 1) + 1.5) % 1 - 0.5);
      if (d >= sp.half + sp.ramp) continue;
      const k = d <= sp.half ? 1 : 0.5 + 0.5 * Math.cos(((d - sp.half) / sp.ramp) * Math.PI);
      r = Math.max(r, t.radius + (sp.width - t.radius) * k);
    }
    return r;
  }

  /**
   * def.splits = [{ at, length, side, axis, offset, width, thick }]: at `at` (lap fraction) the
   * tube widens to `width` and a solid divider `length` metres long, its centre `offset` metres
   * off the line on the `side` (+1/-1) of the frame's R axis ('right') or U axis ('up'), splits
   * it into a wide safe channel (through the line) and a tight risky one (big pad, hazards).
   */
  _initSplits() {
    const L = this.length, base = this.def.tunnel?.radius ?? 60;
    (this.def.splits || []).forEach((s, index) => {
      const width = s.width ?? Math.round(base * 1.7);
      const offset = s.offset ?? Math.round(width * 0.48);
      const thick = s.thick ?? 8;
      const side = s.side < 0 ? -1 : 1;
      const half = (s.length ?? 360) / 2 / L;
      this.splits.push({
        index, at: s.at, half, ramp: (s.ramp ?? 230) / L, u0: s.at - half, u1: s.at + half,
        side, axis: s.axis === 'up' ? 'up' : 'right', offset, thick, width, kind: s.kind || 'rock',
        // Lane centres, signed along the split axis (multiply by the axis vector).
        safeLane: side * (offset - thick - width) / 2,
        riskLane: side * (offset + thick + width) / 2,
        riskHalf: (width - offset - thick) / 2,
        hazards: s.hazards ?? 8,
      });
    });
  }

  /** The split whose divider covers u (widened by `margin`, a lap fraction), or null. */
  splitAt(u, margin = 0) {
    for (const sp of this.splits) {
      const d = Math.abs((((u - sp.at) % 1) + 1.5) % 1 - 0.5);
      if (d <= sp.half + margin) return sp;
    }
    return null;
  }

  curvatureAt(u) { const n = this.sampleCount; return this.curv[((Math.round(u * n) % n) + n) % n]; }

  /** Max curvature over the next `dist` units after u. */
  maxCurvatureAhead(u, dist) {
    const n = this.sampleCount;
    const i0 = Math.round(u * n), steps = Math.ceil(dist / this.step);
    let m = 0;
    for (let k = 0; k <= steps; k += 2) m = Math.max(m, this.curv[(i0 + k) % n]);
    return m;
  }

  /** Nearest fraction of the lap to a world point (coarse search, optional hint). */
  nearestU(p, hintU = null, window = 0.15) {
    const n = this.sampleCount;
    let best = Infinity, bi = 0;
    let i0 = 0, i1 = n;
    if (hintU != null) { i0 = Math.floor((hintU - window) * n); i1 = Math.ceil((hintU + window) * n); }
    for (let k = i0; k < i1; k++) {
      const i = ((k % n) + n) % n;
      const d = this.samples[i].distanceToSquared(p);
      if (d < best) { best = d; bi = i; }
    }
    return { u: bi / n, dist: Math.sqrt(best) };
  }

  /** Spawn transform for grid slot i: behind the start ring, two columns. */
  gridSlot(i) {
    const row = Math.floor(i / 2), col = i % 2;
    const back = 40 + row * 22;
    const u = 1 - back / this.length;
    const f = this.frameAt(u);
    const pos = f.pos.clone().addScaledVector(f.R, (col ? 1 : -1) * 10).addScaledVector(f.U, (row % 2 ? 3 : -3));
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.R, f.U, f.T.clone().negate()));
    return { pos, quat: q, u };
  }
}
