// Low-level geometry kit for the procedural craft: a triangle accumulator that keeps
// every face facing outward (each face is oriented against an "outward hint"), plus
// lofts (cross-sections joined into a hull), lathes (surfaces of revolution), tubes
// along a path and chamfered boxes. Output is non-indexed with flat per-face normals
// and a per-vertex paint channel (`chan`), so a whole craft merges into one mesh per
// material and the palette is picked in the shader.

import * as THREE from 'three';

const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3();
const _c = new THREE.Vector3(), _h = new THREE.Vector3(), _t = new THREE.Vector3();

export class Mesher {
  constructor() { this.p = []; this.ch = []; }

  get triangles() { return this.p.length / 9; }

  /** Triangle a,b,c (Vector3). `hint` = any vector pointing out of the surface. */
  tri(a, b, c, ch, hint) {
    _e1.subVectors(b, a); _e2.subVectors(c, a); _n.crossVectors(_e1, _e2);
    const l2 = _n.lengthSq();
    if (l2 < 1e-12) return; // degenerate
    if (hint && _n.dot(hint) < 0) { const t = b; b = c; c = t; }
    this.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.ch.push(ch, ch, ch);
  }

  quad(a, b, c, d, ch, hint) { this.tri(a, b, c, ch, hint); this.tri(a, c, d, ch, hint); }

  /** Append another mesher through a Matrix4 (mirroring flips winding back). */
  append(o, matrix, chanMap = null) {
    const e = matrix ? matrix.elements : null;
    const flip = matrix ? matrix.determinant() < 0 : false;
    const P = o.p, C = o.ch;
    for (let i = 0; i < P.length; i += 9) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        const x = P[i + k * 3], y = P[i + k * 3 + 1], z = P[i + k * 3 + 2];
        if (e) tri.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
        else tri.push(x, y, z);
      }
      if (flip) this.p.push(tri[0], tri[1], tri[2], tri[6], tri[7], tri[8], tri[3], tri[4], tri[5]);
      else this.p.push(...tri);
      const ch = C[i / 3];
      const m = chanMap ? (chanMap[ch] ?? ch) : ch;
      this.ch.push(m, m, m);
    }
    return this;
  }

  geometry() {
    const n = this.p.length / 3;
    const pos = new Float32Array(this.p);
    const nor = new Float32Array(n * 3);
    for (let i = 0; i < pos.length; i += 9) {
      _e1.set(pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]);
      _e2.set(pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]);
      _n.crossVectors(_e1, _e2).normalize();
      for (let k = 0; k < 3; k++) { nor[i + k * 3] = _n.x; nor[i + k * 3 + 1] = _n.y; nor[i + k * 3 + 2] = _n.z; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('chan', new THREE.BufferAttribute(new Float32Array(this.ch), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export { V };

/**
 * Loft closed cross-sections into a hull. sections: Vector3[][] (equal lengths).
 * chan(ctx) -> channel, ctx = { s, i, c: centroid, n: outward normal, role }.
 * centers: per-section centre used for the outward hint (defaults to the average).
 */
export function loft(m, sections, chan, { capStart = true, capEnd = true, centers = null, roles = null, open = false } = {}) {
  const cs = centers || sections.map(avg);
  const n = sections[0].length;
  const ctx = { s: 0, i: 0, c: new THREE.Vector3(), n: new THREE.Vector3(), role: null, cap: 0 };
  const segs = open ? n - 1 : n;
  for (let s = 0; s < sections.length - 1; s++) {
    const A = sections[s], B = sections[s + 1];
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      _c.copy(A[i]).add(A[j]).add(B[j]).add(B[i]).multiplyScalar(0.25);
      _h.copy(cs[s]).add(cs[s + 1]).multiplyScalar(0.5);
      _h.subVectors(_c, _h);
      faceNormal(A[i], A[j], B[j], B[i], _h, ctx.n);
      ctx.s = s; ctx.i = i; ctx.c.copy(_c); ctx.role = roles ? roles[i] : null; ctx.cap = 0;
      const ch = chan(ctx);
      if (ch < 0) continue;
      m.quad(A[i], A[j], B[j], B[i], ch, _h.clone());
    }
  }
  const cap = (k, other, tag) => {
    const S = sections[k];
    const hint = _t.subVectors(cs[k], cs[other]).clone();
    if (hint.lengthSq() < 1e-10) return;
    ctx.s = k; ctx.i = -1; ctx.c.copy(cs[k]); ctx.n.copy(hint).normalize(); ctx.role = 'cap'; ctx.cap = tag;
    const ch = chan(ctx);
    if (ch < 0) return;
    for (let i = 0; i < n; i++) m.tri(cs[k], S[i], S[(i + 1) % n], ch, hint);
  };
  if (capStart) cap(0, 1, -1);
  if (capEnd) cap(sections.length - 1, sections.length - 2, 1);
}

function faceNormal(a, b, c, d, hint, out) {
  _e1.subVectors(c, a); _e2.subVectors(d, b); out.crossVectors(_e1, _e2);
  if (out.lengthSq() < 1e-14) { out.copy(hint); }
  if (out.dot(hint) < 0) out.negate();
  return out.normalize();
}

function avg(pts) {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  return c.multiplyScalar(1 / pts.length);
}

/**
 * Surface of revolution around the Z axis. prof: [[r, z, chan], ...] traversed so the
 * outside is on the right when walking front (-z) to back (+z); a profile that folds back
 * (nozzle bells, intakes) therefore gets correct inner normals automatically.
 * chan of point i applies to the band between point i and i+1.
 */
export function lathe(m, prof, sides, { phase = 0, sx = 1, sy = 1, cx = 0, cy = 0, cz = 0 } = {}) {
  const P = (r, z, a) => V(cx + Math.cos(a) * r * sx, cy + Math.sin(a) * r * sy, cz + z);
  for (let k = 0; k < prof.length - 1; k++) {
    const [r0, z0, ch] = prof[k], [r1, z1] = prof[k + 1];
    if (ch < 0) continue;
    const dr = r1 - r0, dz = z1 - z0;
    for (let j = 0; j < sides; j++) {
      const a0 = phase + (j / sides) * Math.PI * 2, a1 = phase + ((j + 1) / sides) * Math.PI * 2, am = (a0 + a1) / 2;
      const hint = V(Math.cos(am) * dz * sy, Math.sin(am) * dz * sx, -dr * (sx + sy) * 0.5);
      m.quad(P(r0, z0, a0), P(r0, z0, a1), P(r1, z1, a1), P(r1, z1, a0), ch, hint);
    }
  }
}

/** Square/n-gon tube along a polyline (trim strips, frames, bars). */
export function tube(m, pts, radius, sides, ch, { up = V(0, 1, 0), caps = true, phase = Math.PI / 4, sy = 1 } = {}) {
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    const t = V(0, 0, 0);
    if (i < pts.length - 1) t.add(_t.subVectors(pts[i + 1], pts[i]).normalize());
    if (i > 0) t.add(_t.subVectors(pts[i], pts[i - 1]).normalize());
    t.normalize();
    let nrm = V(0, 0, 0).crossVectors(up, t);
    if (nrm.lengthSq() < 1e-6) nrm = V(0, 0, 0).crossVectors(V(1, 0, 0), t);
    nrm.normalize();
    const b = V(0, 0, 0).crossVectors(t, nrm).normalize();
    const ring = [];
    for (let k = 0; k < sides; k++) {
      const a = phase + (k / sides) * Math.PI * 2;
      ring.push(pts[i].clone().addScaledVector(nrm, Math.cos(a) * radius).addScaledVector(b, Math.sin(a) * radius * sy));
    }
    rings.push(ring);
  }
  loft(m, rings, () => ch, { capStart: caps, capEnd: caps, centers: pts });
}

/** Chamfered rectangle cross-section (8 points) in the XY plane at z. */
export function rectSection(w, h, c, z, cx = 0, cy = 0) {
  const x = w / 2, y = h / 2, cc = Math.min(c, x * 0.95, y * 0.95);
  return [V(cx + x - cc, cy + y, z), V(cx + x, cy + y - cc, z), V(cx + x, cy - y + cc, z), V(cx + x - cc, cy - y, z),
    V(cx - x + cc, cy - y, z), V(cx - x, cy - y + cc, z), V(cx - x, cy + y - cc, z), V(cx - x + cc, cy + y, z)];
}

/** Box with every edge chamfered by c (long axis Z). */
export function chamferBox(m, w, h, d, c, ch, { x = 0, y = 0, z = 0, taper = 1, chanFn = null } = {}) {
  const z0 = z - d / 2, z1 = z + d / 2;
  const secs = [
    rectSection((w - 2 * c) * taper, (h - 2 * c) * taper, c * 0.6, z0, x, y),
    rectSection(w * taper, h * taper, c, z0 + c, x, y),
    rectSection(w, h, c, z1 - c, x, y),
    rectSection(w - 2 * c, h - 2 * c, c * 0.6, z1, x, y),
  ];
  loft(m, secs, chanFn || (() => ch), { centers: secs.map((s, i) => V(x, y, [z0, z0 + c, z1 - c, z1][i])) });
}

/**
 * Faceted fuselage cross-section: flat top with a centre stripe, chamfered shoulders,
 * a thin side "band" (trim strip), flat side, chamfered chine, flat belly.
 * Returns { pts, roles } — roles name each face i -> i+1 so parts can paint by role.
 */
export function bodySection(st, hi) {
  const { z, w, t, b } = st;
  const x0 = st.x ?? 0, y0 = st.y ?? 0;
  const wt = w * (st.wt ?? 0.55), wb = w * (st.wb ?? 0.6);
  const sw = Math.min(w * (st.sw ?? 0.14), wt * 0.6);
  const yu = t * (st.yu ?? 0.35), band = Math.max(0.0, st.band ?? 0.07) * Math.max(0.3, Math.min(1, w));
  const yl = b * (st.yl ?? 0.4);
  const yTop = t, yBot = b;
  const R = [];
  const roles = [];
  R.push([sw, yTop]); roles.push('top');
  R.push([wt, yTop]); roles.push('shoulder');
  if (hi) { R.push([wt + (w - wt) * 0.62, yTop - (yTop - yu) * 0.26]); roles.push('shoulder'); }
  R.push([w, yu]); roles.push('band');
  R.push([w, Math.max(yl + 0.01, yu - band)]); roles.push('side');
  R.push([w, yl]); roles.push('chine');
  if (hi) { R.push([wb + (w - wb) * 0.62, yBot - (yBot - yl) * 0.26]); roles.push('chine'); }
  R.push([wb, yBot]); roles.push('belly');
  // full ring: right side top->bottom, then left side bottom->top
  const pts = [];
  const allRoles = [];
  for (let i = 0; i < R.length; i++) { pts.push(V(x0 + R[i][0], y0 + R[i][1], z)); allRoles.push(roles[i]); }
  for (let i = R.length - 1; i >= 0; i--) {
    pts.push(V(x0 - R[i][0], y0 + R[i][1], z));
    // face from L[i] to L[i-1] has the role of the right-side face (i-1 -> i)
    allRoles.push(i > 0 ? roles[i - 1] : 'stripe');
  }
  // the face from R[last] to L[last] is the belly centre
  allRoles[R.length - 1] = 'belly';
  return { pts, roles: allRoles };
}

/** Loft a list of body stations (see bodySection). Returns the sections for reuse. */
export function bodyLoft(m, stations, hi, chan, opts = {}) {
  if (hi) stations = refineStations(stations);
  const secs = stations.map((st) => bodySection(st, hi));
  const centers = stations.map((st) => V(st.x ?? 0, (st.y ?? 0) + (st.t + st.b) / 2, st.z));
  loft(m, secs.map((s) => s.pts), (ctx) => chan(ctx, stations[ctx.s], stations[Math.min(ctx.s + 1, stations.length - 1)]),
    { centers, roles: secs[0].roles, ...opts });
  return secs;
}

/**
 * Lifting surface (wing / fin) lofted along its span (+X). Planform given as root and tip
 * leading/trailing edge points {x, z}; thickness tapers root->tip. Airfoil is a faceted
 * hexagon with a thin leading-edge band and a trailing "flap" band, so parts can paint
 * a glowing leading edge and dark control surfaces without extra geometry.
 * chan(ctx) gets ctx.f (span fraction 0..1) and ctx.role ('le','upper','flap','te','lower').
 */
export function liftingSurface(m, pf, hi, chan) {
  const N = hi ? 5 : 3;
  const secs = [], centers = [], fr = [];
  for (let k = 0; k <= N; k++) {
    const f = k / N;
    const le = V(lerp(pf.root.xl ?? 0, pf.tip.xl, f), 0, lerp(pf.root.le, pf.tip.le, f));
    const te = V(lerp(pf.root.xt ?? 0, pf.tip.xt, f), 0, lerp(pf.root.te, pf.tip.te, f));
    const th = lerp(pf.root.th, pf.tip.th, f);
    const P = (u, y) => le.clone().lerp(te, u).setY(y);
    // order: LE, upper LE band, upper crest, upper flap hinge, TE top, TE bottom, lower hinge, lower crest, lower LE band
    const s = [P(0, 0), P(0.06, th * 0.3), P(0.3, th * 0.5), P(0.74, th * 0.36), P(1, th * 0.08), P(1, -th * 0.08), P(0.74, -th * 0.3), P(0.3, -th * 0.42), P(0.06, -th * 0.26)];
    secs.push(s); centers.push(P(0.4, 0)); fr.push(f);
  }
  const roles = ['le', 'upper', 'upper', 'flap', 'te', 'lower', 'lower', 'lower', 'le'];
  loft(m, secs, (ctx) => { ctx.f = ctx.role === 'cap' ? (ctx.cap > 0 ? 1 : 0) : (fr[ctx.s] + fr[ctx.s + 1]) / 2; return chan(ctx); }, { centers, roles });
  return { secs, centers };
}

export const lerp = (a, b, t) => a + (b - a) * t;

/** High LOD: insert Catmull-Rom mid-stations in long gaps so profiles curve smoothly. */
function refineStations(st) {
  const out = [];
  const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  for (let i = 0; i < st.length; i++) {
    out.push(st[i]);
    if (i === st.length - 1) break;
    const a = st[i], b = st[i + 1];
    if (b.z - a.z < 0.7) continue;
    const p = st[Math.max(0, i - 1)], q = st[Math.min(st.length - 1, i + 2)];
    const mid = { ...a, z: (a.z + b.z) / 2 };
    for (const k of ['w', 't', 'b']) {
      const v = cr(p[k], a[k], b[k], q[k], 0.5);
      // never overshoot outside the neighbours' envelope (keeps noses from bulging)
      mid[k] = Math.min(Math.max(v, Math.min(a[k], b[k]) - Math.abs(b[k] - a[k]) * 0.25), Math.max(a[k], b[k]) + Math.abs(b[k] - a[k]) * 0.25 + 0.06 * Math.abs(a[k]));
    }
    out.push(mid);
  }
  return out;
}
