// Builds a Three.js craft from a design: body + wings + engines + fins + cockpit.
// Local space: nose points -Z, +Y up, +X right (starboard). Length is roughly 6-7 units.
//
// Every part is a faceted, chamfered low-poly shape built from lofts and lathes
// (js/craft/craftGeo.js). All opaque parts merge into ONE mesh whose per-vertex paint
// channel picks primary / secondary / accent paint, trim metal, bright metal, recess,
// glow trim or hot engine core in the shader (js/craft/craftMaterials.js), so a craft
// costs: hull 1 + glass 1 + flames 1 + nav lights/beacon 1 draw calls (+1 underglow in
// the hangar). Geometry is shared between craft with the same parts (ref-counted).
//
// lod: 'high' -> a THREE.LOD that shows the detailed hull close up and the light hull
//      beyond ~170 units (switches by itself every render);  'low' -> light hull only.
//
// Returns { root, nozzles: [{pos, r}], flames: [Mesh], flameMat, glowColor, design,
//           setThrust(power, boost, time, glow), setHighlight(0..1), setTeamColor(c|null),
//           triangles: {high, low}, dispose() }.

import * as THREE from 'three';
import { normalizeDesign } from './parts.js';
import { Mesher, V, lathe, tube, chamferBox, bodyLoft, liftingSurface, loft, lerp } from './craftGeo.js';
import {
  CH, LIGHT, makeHullMaterial, makeGlassMaterial, makeFlameGeometry, makeFlameMaterial,
  makeLightsGeometry, makeLightsMaterial, glowTexture,
} from './craftMaterials.js';

const { PRIMARY: P, SECONDARY: S, ACCENT: A, TRIM: T, METAL: M, RECESS: R, GLOW: G, HOT: H } = CH;
const LOD_DIST = 170;
const _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _eu = new THREE.Euler();
const _col = new THREE.Color();

function mat(x = 0, y = 0, z = 0, rz = 0, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_eu.set(rx, ry, rz)), _s.set(sx, sy, sz));
}
const inZ = (c, z0, z1) => c.z >= z0 && c.z <= z1;

/**
 * Standard fuselage paint by face role: top primary with an accent centre stripe, glowing
 * side band (else dark trim line), secondary belly, optional secondary nose cone.
 * o: { stripe:[z0,z1], glow:[z0,z1], nose: z (faces ahead of it are secondary), side: chan, tail: chan }
 */
function fuselagePaint(o = {}) {
  return (ctx) => {
    const c = ctx.c, role = ctx.role;
    if (role === 'cap') return ctx.cap > 0 ? (o.tail ?? T) : (o.noseCap ?? S);
    if (role === 'band') return o.glow && inZ(c, o.glow[0], o.glow[1]) ? G : T;
    if (o.nose != null && c.z < o.nose) return role === 'stripe' && o.noseStripe ? A : (o.noseChan ?? S);
    if (role === 'stripe') return o.stripe && inZ(c, o.stripe[0], o.stripe[1]) ? A : (o.top ?? P);
    if (role === 'top' || role === 'shoulder') return o.top ?? P;
    if (role === 'side') return o.side ?? P;
    return o.belly ?? S; // chine, belly
  };
}

/** Small side intake: dark-trim housing with a recessed mouth facing forward. */
function intake(m, x, y, z, w, h, d) {
  chamferBox(m, w, h, d, Math.min(w, h) * 0.22, T, { x, y, z, chanFn: (ctx) => (ctx.cap < 0 ? R : T) });
}

// ---------------------------------------------------------------- bodies
// Each returns mounts: wing / engine / fin / cockpit (same placement as the original
// builder so saved designs keep their proportions) plus nav-light fallbacks.
const BODIES = {
  dart(m, hi) {
    const st = (z, w, t, b, o) => ({ z, w, t, b, wt: 0.5, wb: 0.58, yu: 0.3, yl: 0.42, band: 0.06, sw: 0.12, ...o });
    bodyLoft(m, [
      st(-3.7, 0.03, 0.05, -0.03), st(-3.15, 0.25, 0.17, -0.12), st(-2.25, 0.5, 0.32, -0.22),
      st(-1.0, 0.78, 0.46, -0.32), st(0.4, 0.92, 0.52, -0.36), st(1.8, 0.88, 0.5, -0.36),
      st(2.55, 0.72, 0.44, -0.3), st(2.8, 0.6, 0.36, -0.24),
    ], hi, fuselagePaint({ nose: -2.25, stripe: [-2.3, 2.6], glow: [-1.6, 2.2] }));
    // dorsal spine
    bodyLoft(m, [
      { z: 0.15, w: 0.03, t: 0.02, b: -0.1 }, { z: 0.7, w: 0.12, t: 0.14, b: -0.1 }, { z: 2.3, w: 0.13, t: 0.15, b: -0.1 }, { z: 2.62, w: 0.08, t: 0.08, b: -0.1 },
    ].map((s) => ({ ...s, y: 0.47, wt: 0.6, wb: 1, yu: 0.4, band: 0.03, sw: 0.3 })), hi, fuselagePaint({ top: S, side: S, stripe: [0, 3], glow: [0.8, 2.2] }));
    if (hi) {
      for (const sx of [-1, 1]) intake(m, sx * 0.86, 0.0, 0.25, 0.2, 0.3, 1.1);
      for (let i = 0; i < 3; i++) chamferBox(m, 0.5, 0.05, 0.08, 0.015, R, { y: 0.505, z: 1.05 + i * 0.22 });
    }
    return { wing: { y: -0.05, z: 0.6, span: 0.9 }, engine: { z: 2.7, y: 0, spread: 0.75 }, fin: { y: 0.4, z: 2.1 }, cockpit: { y: 0.42, z: -0.6, s: 0.85 },
      nav: { x: 0.95, y: 0.05, z: 0.6 }, tail: { y: 0.68, z: 2.5 }, guns: [[0.5, -0.26, -1.15, 1.3]] };
  },

  arrow(m, hi) {
    const st = (z, w, t, b, o) => ({ z, w, t, b, wt: 0.82, wb: 0.85, yu: 0.25, yl: 0.3, band: 0.06, sw: 0.08, ...o });
    bodyLoft(m, [
      st(-3.75, 0.05, 0.06, -0.04), st(-2.6, 0.52, 0.2, -0.16), st(-1.0, 1.02, 0.3, -0.26),
      st(1.0, 1.52, 0.34, -0.3), st(2.42, 1.38, 0.32, -0.28), st(2.62, 1.24, 0.25, -0.21),
    ], hi, fuselagePaint({ nose: -3.0, noseChan: A, glow: [-2.9, 2.5], stripe: null }));
    // raised keel / spine
    const kst = (z, w, t, o) => ({ z, w, t, b: -0.05, y: 0.12, wt: 0.5, wb: 1, yu: 0.4, yl: 0.5, band: 0.05, sw: 0.18, ...o });
    bodyLoft(m, [kst(-2.75, 0.04, 0.06), kst(-1.9, 0.38, 0.32), kst(-1.0, 0.52, 0.46), kst(1.2, 0.62, 0.55), kst(2.45, 0.5, 0.44), kst(2.66, 0.4, 0.34)], hi,
      fuselagePaint({ top: S, side: S, stripe: [-1.8, 2.6], glow: [0.6, 2.4] }));
    if (hi) {
      for (const sx of [-1, 1]) intake(m, sx * 0.86, 0.38, 1.2, 0.36, 0.16, 1.2);
      for (const sx of [-1, 1]) chamferBox(m, 0.08, 0.06, 0.9, 0.02, M, { x: sx * 1.2, y: 0.33, z: 1.6 });
    }
    return { wing: { y: 0, z: 0.4, span: 1.0 }, engine: { z: 2.7, y: 0.1, spread: 0.95 }, fin: { y: 0.6, z: 1.8 }, cockpit: { y: 0.55, z: -0.2, s: 1 },
      nav: { x: 1.56, y: 0.02, z: 1.0 }, tail: { y: 0.8, z: 2.4 }, guns: [[0.92, -0.28, -0.7, 1.4]] };
  },

  hauler(m, hi) {
    const st = (z, w, t, b, o) => ({ z, w, t, b, wt: 0.84, wb: 0.86, yu: 0.55, yl: 0.6, band: 0.08, sw: 0.1, ...o });
    bodyLoft(m, [
      st(-3.92, 0.5, 0.3, -0.26), st(-3.75, 0.66, 0.4, -0.36), st(-1.95, 1.12, 0.72, -0.7),
      st(2.5, 1.15, 0.75, -0.72), st(2.76, 0.98, 0.6, -0.58),
    ], hi, fuselagePaint({ nose: -3.6, noseCap: R, stripe: [-1.9, 2.6], glow: [-3.7, -1.95] }));
    for (const sx of [-1, 1]) {
      const pst = (z, w, t, o) => ({ z, w, t, b: -t, x: sx * 1.45, y: -0.15, wt: 0.7, wb: 0.7, yu: 0.4, yl: 0.4, band: 0.1, sw: 0.1, ...o });
      bodyLoft(m, [pst(-1.35, 0.2, 0.3), pst(-1.05, 0.35, 0.5), pst(2.2, 0.35, 0.5), pst(2.45, 0.27, 0.38)], hi,
        fuselagePaint({ top: S, side: S, belly: T, stripe: [-1, 2.3], glow: [-0.9, 2.05], tail: R }));
    }
    if (hi) {
      for (let i = 0; i < 4; i++) chamferBox(m, 1.75, 0.08, 0.16, 0.03, T, { y: 0.77, z: -0.15 + i * 0.75 });
      for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) chamferBox(m, 0.05, 0.3, 0.07, 0.015, R, { x: sx * 1.155, y: 0.1, z: -1.4 + i * 0.2 });
      chamferBox(m, 0.7, 0.05, 0.05, 0.015, G, { y: 0.0, z: -3.93 });
    }
    return { wing: { y: -0.2, z: 0.6, span: 1.15 }, engine: { z: 2.75, y: 0.1, spread: 1.0 }, fin: { y: 0.75, z: 2.0 }, cockpit: { y: 0.8, z: -1.0, s: 1.1 },
      nav: { x: 1.82, y: 0.1, z: 0.4 }, tail: { y: 0.95, z: 2.3 }, guns: [[1.45, -0.7, -1.2, 1.2]] };
  },

  glider(m, hi) {
    const st = (z, w, t, b, o) => ({ z, w, t, b, wt: 0.5, wb: 0.55, yu: 0.12, yl: 0.12, band: 0.045, sw: 0.06, ...o });
    bodyLoft(m, [
      st(-3.95, 0.06, 0.03, -0.02), st(-3.0, 0.9, 0.16, -0.1), st(-1.0, 2.15, 0.32, -0.2), st(0.6, 2.4, 0.36, -0.22),
      st(1.8, 2.2, 0.32, -0.2), st(2.75, 1.4, 0.2, -0.14), st(2.92, 1.1, 0.14, -0.1),
    ], hi, (() => { const base = fuselagePaint({ nose: -2.9, glow: [-3.3, 2.8], stripe: null });
      // two-tone swoosh: secondary shoulders on the rear two-thirds
      return (ctx) => (ctx.role === 'shoulder' && ctx.c.z > -1.2 ? S : base(ctx)); })());
    const sp = (z, w, t) => ({ z, w, t, b: -0.05, y: 0.2, wt: 0.45, wb: 1, yu: 0.4, yl: 0.5, band: 0.04, sw: 0.25 });
    bodyLoft(m, [sp(-2.3, 0.05, 0.05), sp(-1.2, 0.28, 0.27), sp(1.4, 0.34, 0.36), sp(2.5, 0.2, 0.18)], hi,
      fuselagePaint({ top: S, side: S, stripe: [-2, 2.4], glow: [-0.4, 2.2] }));
    if (hi) {
      for (const sx of [-1, 1]) chamferBox(m, 0.07, 0.05, 1.3, 0.02, A, { x: sx * 0.62, y: 0.355, z: 0.7 });
      for (const sx of [-1, 1]) chamferBox(m, 0.4, 0.08, 0.5, 0.03, R, { x: sx * 0.7, y: -0.205, z: 0.9 });
    }
    return { wing: { y: 0, z: 0.9, span: 0.8 }, engine: { z: 2.75, y: 0.1, spread: 0.9 }, fin: { y: 0.3, z: 2.1 }, cockpit: { y: 0.45, z: -0.3, s: 0.9 },
      nav: { x: 2.42, y: 0, z: 0.6 }, tail: { y: 0.45, z: 2.6 }, guns: [[1.15, -0.24, -1.3, 1.4]] };
  },

  bike(m, hi) {
    const st = (z, w, t, b, o) => ({ z, w, t, b, wt: 0.55, wb: 0.6, yu: 0.35, yl: 0.4, band: 0.07, sw: 0.14, ...o });
    bodyLoft(m, [
      st(-2.95, 0.05, 0.06, -0.04), st(-2.3, 0.3, 0.3, -0.28), st(-0.6, 0.47, 0.5, -0.5),
      st(1.2, 0.47, 0.5, -0.48), st(2.1, 0.36, 0.4, -0.38), st(2.35, 0.28, 0.3, -0.3),
    ], hi, fuselagePaint({ nose: -2.0, stripe: [-2, 0.3], glow: [-1.9, 1.9] }));
    // front fork pod
    const fst = (z, w, t) => ({ z, w, t, b: -t, y: -0.35, wt: 0.5, wb: 0.5, yu: 0.3, yl: 0.3, band: 0.06, sw: 0.15 });
    bodyLoft(m, [fst(-3.42, 0.04, 0.03), fst(-2.95, 0.22, 0.15), fst(-1.95, 0.32, 0.2), fst(-1.4, 0.22, 0.13)], hi,
      fuselagePaint({ top: S, side: S, stripe: [-3, -1.5], glow: [-3.2, -1.8] }));
    // handlebar + grips + seat
    const bs = hi ? 6 : 4;
    tube(m, [V(-0.92, 0.6, -1.08), V(-0.4, 0.68, -1.24), V(0.4, 0.68, -1.24), V(0.92, 0.6, -1.08)], 0.05, bs, T);
    chamferBox(m, 0.12, 0.2, 0.12, 0.03, T, { y: 0.55, z: -1.24 });
    for (const sx of [-1, 1]) chamferBox(m, 0.22, 0.1, 0.11, 0.03, R, { x: sx * 0.86, y: 0.61, z: -1.1 });
    chamferBox(m, 0.55, 0.16, 1.2, 0.05, T, { y: 0.55, z: 0.3, chanFn: (ctx) => (ctx.n.y > 0.7 ? R : T) });
    if (hi) {
      for (const sx of [-1, 1]) intake(m, sx * 0.5, -0.12, -0.3, 0.14, 0.32, 0.9);
      chamferBox(m, 0.3, 0.36, 0.08, 0.03, T, { y: 0.66, z: 0.94 });
    }
    return { wing: { y: -0.1, z: 0.6, span: 0.65 }, engine: { z: 2.2, y: -0.05, spread: 0.6 }, fin: { y: 0.45, z: 1.6 }, cockpit: { y: 0.55, z: -0.8, s: 0.7 },
      nav: { x: 0.95, y: 0.6, z: -1.08 }, tail: { y: 0.62, z: 2.0 }, guns: [[0.32, -0.5, -1.7, 1.2]] };
  },
};

// ---------------------------------------------------------------- wings
const WINGS = {
  swept: { root: { le: -0.8, te: 1.5, th: 0.17 }, tip: { xl: 2.6, le: 1.3, xt: 2.6, te: 1.9, th: 0.07 } },
  delta: { root: { le: -1.7, te: 1.8, th: 0.2 }, tip: { xl: 2.25, le: 1.58, xt: 2.3, te: 1.8, th: 0.05 } },
  broad: { root: { le: -1.1, te: 1.5, th: 0.19 }, tip: { xl: 3.2, le: -0.4, xt: 3.4, te: 1.0, th: 0.08 } },
  xwing: { root: { le: -0.6, te: 1.3, th: 0.15 }, tip: { xl: 2.5, le: 0.6, xt: 2.5, te: 1.1, th: 0.06 } },
  forward: { root: { le: -0.5, te: 1.7, th: 0.17 }, tip: { xl: 2.45, le: -1.25, xt: 2.5, te: -0.55, th: 0.07 } },
  blade: { root: { le: -0.4, te: 1.3, th: 0.15 }, tip: { xl: 3.7, le: 1.15, xt: 3.8, te: 1.55, th: 0.05 } },
};

const wingPaint = (ctx) => {
  const f = ctx.f, r = ctx.role;
  if (r === 'cap') return ctx.cap > 0 ? A : T;
  if (r === 'le') return f > 0.32 ? G : T;
  if (r === 'te') return T;
  if (r === 'flap') return f > 0.12 && f < 0.6 ? T : S;
  if (f > 0.7 && f < 0.8) return P;
  return S;
};

const _wingTemplates = new Map();
function wingTemplate(kind, hi) {
  const key = kind + hi;
  if (_wingTemplates.has(key)) return _wingTemplates.get(key);
  const pf = WINGS[kind];
  const w = new Mesher();
  liftingSurface(w, pf, hi, wingPaint);
  // tip pod: a slim faceted rod along the tip chord
  const tx = (pf.tip.xl + pf.tip.xt) / 2, z0 = pf.tip.le - 0.25, z1 = pf.tip.te + 0.12, r = 0.075;
  lathe(w, [[0, z0 - 0.08, M], [r * 0.6, z0, T], [r, z0 + 0.25, T], [r, z1 - 0.12, T], [r * 0.6, z1, R], [0, z1]], hi ? 6 : 4, { cx: tx + 0.02, phase: Math.PI / 6 });
  const t = { m: w, tip: V(tx + 0.02, 0, z0 - 0.02), tipX: tx };
  _wingTemplates.set(key, t);
  return t;
}

function addWings(m, kind, mount, hi, nav) {
  if (kind === 'none') return;
  const t = wingTemplate(kind, hi);
  const pairs = kind === 'xwing' ? [0.28, -0.28] : [kind === 'delta' ? -0.04 : kind === 'forward' ? -0.07 : 0.05];
  for (const dihedral of pairs) {
    const yOff = kind === 'xwing' ? Math.sign(dihedral) * 0.15 : 0;
    for (const sx of [-1, 1]) {
      const mx = mat(sx * 0.35, mount.y + yOff, mount.z, sx * dihedral, sx * mount.span, 1, 1);
      m.append(t.m, mx);
      nav.push({ pos: t.tip.clone().applyMatrix4(mx), side: sx });
    }
  }
}

// ---------------------------------------------------------------- engines
function nacelleProfile(r, L, zf, zb, hi) {
  const bz = zf + 0.55 * L;
  if (!hi) {
    return [
      [0, zf + 0.15, R], [0.82 * r, zf, T], [r, zf + 0.3, T], [r, bz, S], [1.06 * r, bz + 0.05, S], [1.06 * r, bz + 0.32, T],
      [0.95 * r, zb - 0.25, M], [1.0 * r, zb + 0.1, G], [0.6 * r, zb - 0.1, H], [0, zb - 0.12],
    ];
  }
  return [
    [0, zf + 0.22, R], [0.66 * r, zf + 0.22, T], [0.7 * r, zf + 0.02, M], [0.86 * r, zf - 0.02, T], [0.95 * r, zf + 0.12, T],
    [r, zf + 0.3, T], [r, bz, S], [1.07 * r, bz + 0.06, S], [1.07 * r, bz + 0.3, S], [r, bz + 0.36, T],
    [0.97 * r, zb - 0.35, T], [0.9 * r, zb - 0.22, M], [1.0 * r, zb + 0.1, M], [0.9 * r, zb + 0.13, G],
    [0.66 * r, zb - 0.1, G], [0.5 * r, zb - 0.16, H], [0, zb - 0.16],
  ];
}

function addEngines(m, kind, mount, hi) {
  const nozzles = [];
  const sides = hi ? 14 : 8;
  const place = (x, y, r, len) => {
    const zf = mount.z - len + 0.3, zb = mount.z + 0.3;
    lathe(m, nacelleProfile(r, len, zf, zb, hi), sides, { cx: x, cy: y, phase: Math.PI / sides });
    if (hi && x !== 0) {
      // pylon fairing tying the nacelle to the hull
      chamferBox(m, 0.12, r * 0.9, len * 0.5, 0.04, T, { x: x - Math.sign(x) * r * 0.75, y, z: zf + len * 0.45 });
    }
    nozzles.push({ pos: new THREE.Vector3(x, y, mount.z + 0.35), r });
  };
  const sp = mount.spread;
  if (kind === 'single') place(0, mount.y, 0.62, 2.2);
  else if (kind === 'twin') { place(-sp, mount.y, 0.48, 2.4); place(sp, mount.y, 0.48, 2.4); }
  else if (kind === 'quad') {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) place(sx * sp * 1.05, mount.y + sy * 0.32, 0.36, 2.5);
  } else if (kind === 'tri') {
    place(0, mount.y + 0.42, 0.4, 2.3);
    for (const sx of [-1, 1]) place(sx * sp * 1.05, mount.y - 0.18, 0.4, 2.4);
  } else if (kind === 'ion') {
    const zc = mount.z + 0.1, y = mount.y;
    const R0 = 0.95, a = 0.2, c = 0.07;
    // ring: chamfered square section revolved (outer -> back face -> glowing inner -> front face)
    lathe(m, [
      [R0 + a - c, zc - a, S], [R0 + a, zc - a + c, S], [R0 + a, zc + a - c, S], [R0 + a - c, zc + a, T],
      [R0 - a + c, zc + a, G], [R0 - a, zc + a - c, G], [R0 - a, zc - a + c, T], [R0 - a + c, zc - a, T], [R0 + a - c, zc - a],
    ], hi ? 24 : 12, { cy: y });
    // hot core disc + central emitter spike
    lathe(m, [[0.78, zc + 0.02, G], [0.36, zc + 0.02, H], [0, zc + 0.02]], hi ? 24 : 12, { cy: y });
    lathe(m, [[0, zc - 0.9, T], [0.26, zc - 0.4, T], [0.2, zc + 0.16, M], [0, zc + 0.26]], hi ? 10 : 6, { cy: y });
    const strut = new Mesher();
    chamferBox(strut, 0.12, 0.9, 0.9, 0.04, T, { y: 0.5 });
    for (let k = 0; k < 3; k++) m.append(strut, mat(0, y, mount.z - 0.2, (k * Math.PI * 2) / 3));
    nozzles.push({ pos: new THREE.Vector3(0, y, mount.z + 0.2), r: 0.85 });
  }
  return nozzles;
}

// ---------------------------------------------------------------- fins
const finPaint = (ctx) => {
  const f = ctx.f, r = ctx.role;
  if (r === 'cap') return ctx.cap > 0 ? A : T;
  if (r === 'le') return f > 0.55 ? G : T;
  if (r === 'te' || (r === 'flap' && f < 0.7)) return T;
  if (f > 0.84) return A;
  return S;
};

function finTemplate(h, len, hi) {
  const f = new Mesher();
  liftingSurface(f, { root: { le: -0.3, te: len * 0.9, th: 0.13 }, tip: { xl: h, le: len * 0.6, xt: h, te: len, th: 0.05 } }, hi, finPaint);
  f.tip = V(h, 0, len * 0.8);
  return f;
}

function addFins(m, kind, mount, hi, strobes) {
  if (kind === 'none') return;
  const put = (h, len, x, y, rz) => {
    const t = finTemplate(h, len, hi);
    // template spans +X; rotate so span points up (+Y), then tilt by rz
    const mx = mat(x, mount.y + y, mount.z - 0.3, rz).multiply(_m4b.makeRotationZ(Math.PI / 2));
    m.append(t, mx);
    return t.tip.clone().applyMatrix4(mx);
  };
  if (kind === 'twin') { strobes.push(put(1.1, 1.5, -0.55, 0, 0.25)); strobes.push(put(1.1, 1.5, 0.55, 0, -0.25)); }
  else if (kind === 'tall') strobes.push(put(1.8, 1.9, 0, 0, 0));
  else if (kind === 'tri') { strobes.push(put(1.2, 1.4, 0, 0, 0)); put(1.0, 1.2, -0.3, -0.2, 2.2); put(1.0, 1.2, 0.3, -0.2, -2.2); }
  else if (kind === 'quad') {
    strobes.push(put(1.0, 1.4, -0.45, 0, 0.6)); strobes.push(put(1.0, 1.4, 0.45, 0, -0.6));
    put(0.85, 1.2, -0.4, -0.25, 2.45); put(0.85, 1.2, 0.4, -0.25, -2.45);
  }
}

// ---------------------------------------------------------------- cockpits
/** Arch cross-sections (open at the bottom) lofted along z: canopy glass. */
function archLoft(g, stations, k, roof = 1) {
  const secs = [], centers = [];
  for (const s of stations) {
    const pts = [];
    for (let i = 0; i < k; i++) {
      const a = (i / (k - 1)) * Math.PI;
      const c = Math.cos(a), sn = Math.sin(a);
      // squarer shoulders than an ellipse: reads as a cut-glass canopy
      const ex = Math.sign(c) * Math.pow(Math.abs(c), roof), ey = Math.pow(sn, roof);
      pts.push(V(ex * s.w, s.y0 + ey * s.h, s.z));
    }
    secs.push(pts); centers.push(V(0, s.y0 + s.h * 0.3, s.z));
  }
  loft(g, secs, () => 0, { open: true, centers, capStart: true, capEnd: true });
  return secs;
}

function addCockpit(m, g, kind, mount, hi) {
  const c = new Mesher(), cg = new Mesher();
  const k = hi ? 9 : 5;
  let frames = [];
  if (kind === 'bubble') {
    const st = [];
    const n = hi ? 7 : 4;
    for (let i = 0; i <= n; i++) { const phi = -Math.PI / 2 + (i / n) * Math.PI; const r = Math.max(0.06, Math.cos(phi)); st.push({ z: Math.sin(phi) * 1.0, w: 0.56 * r, h: 0.5 * r, y0: -0.04 }); }
    const secs = archLoft(cg, st, k, 0.85);
    frames = [secs[Math.round(n * 0.62)]];
  } else if (kind === 'canopy') {
    const prof = [[-1.25, 0.06], [-0.85, 0.55], [-0.3, 0.92], [0.35, 1], [0.85, 0.82], [1.2, 0.35], [1.32, 0.08]];
    const st = prof.map(([z, s]) => ({ z, w: 0.42 * s, h: 0.36 * Math.min(1, s * 1.1), y0: -0.05 }));
    const secs = archLoft(cg, st, k, 0.8);
    frames = [secs[2], secs[4]];
  } else if (kind === 'visor') {
    const prof = [[-0.95, 0.03], [-0.5, 0.45], [0.1, 0.85], [0.6, 1], [0.92, 0.8]];
    const st = prof.map(([z, s]) => ({ z, w: 0.62 * s, h: 0.34 * s, y0: -0.04 }));
    const secs = archLoft(cg, st, hi ? 5 : 3, 1.6);
    frames = [secs[3]];
    // rear fairing behind the visor
    chamferBox(c, 1.0, 0.24, 0.5, 0.08, P, { y: 0.08, z: 1.05, chanFn: (ctx) => (ctx.n.z > 0.6 ? T : P) });
  } else {
    // armored: a chamfered metal shell with a narrow glass slit and a glow strip
    chamferBox(c, 1.1, 0.55, 1.6, 0.14, P, { y: 0.0, chanFn: (ctx) => (ctx.n.y < -0.5 ? T : ctx.n.z < -0.6 ? T : ctx.n.y > 0.75 ? S : P) });
    chamferBox(cg, 0.86, 0.13, 0.12, 0.04, 0, { y: 0.12, z: -0.79 });
    chamferBox(c, 0.96, 0.05, 0.06, 0.015, G, { y: -0.06, z: -0.8 });
    if (hi) for (const sx of [-1, 1]) chamferBox(c, 0.05, 0.08, 1.2, 0.02, T, { x: sx * 0.56, y: 0.0, z: 0.05 });
  }
  if (kind !== 'armored') {
    // frame: sill rails + hoops (dark trim), slightly proud of the glass
    for (const sec of frames) tube(c, sec.map((p) => p.clone().multiplyScalar(1.03).setZ(p.z)), 0.03, 4, T, { up: V(0, 0, 1) });
    if (hi) {
      // pilot: helmet + seat back, seen through the tinted glass
      lathe(c, [[0, -0.16, M], [0.12, -0.12, M], [0.16, 0.0, M], [0.12, 0.13, R], [0, 0.17]], 8, { cy: 0.17, cz: 0.15 });
      chamferBox(c, 0.36, 0.42, 0.12, 0.04, R, { y: 0.12, z: 0.42 });
      chamferBox(c, 0.7, 0.05, 1.1, 0.04, R, { y: -0.02, z: 0.1 });
    }
  }
  const mx = mat(0, mount.y, mount.z, 0, mount.s, mount.s, mount.s);
  m.append(c, mx);
  g.append(cg, mx);
}

// ---------------------------------------------------------------- assembly + cache
/** Forward cannon barrels (the lasers alternate between them): housing, barrel, muzzle. */
function addGuns(m, guns, hi) {
  const sides = hi ? 8 : 5;
  for (const [gx, gy, gz, len] of guns) {
    for (const sx of [-1, 1]) {
      const z1 = gz + len * 0.45, z0 = gz - len * 0.55;
      lathe(m, [[0, z0 - 0.04, M], [0.035, z0 - 0.04, R], [0.035, z0 + 0.01, M], [0.055, z0 + 0.02, M], [0.05, z0 + 0.1, T], [0.04, z0 + 0.12, T],
        [0.04, gz, T], [0.09, gz + 0.04, T], [0.1, z1 - 0.1, T], [0.07, z1, T], [0, z1 + 0.02]], sides, { cx: sx * gx, cy: gy, phase: Math.PI / sides });
    }
  }
}

function buildShape(d, hi) {
  const m = new Mesher(), g = new Mesher();
  const body = BODIES[d.body](m, hi);
  if (hi && body.guns) addGuns(m, body.guns, hi);
  const nav = [], strobes = [];
  addWings(m, d.wings, body.wing, hi, nav);
  const nozzles = addEngines(m, d.engines, body.engine, hi);
  addFins(m, d.fins, body.fin, hi, strobes);
  addCockpit(m, g, d.cockpit, body.cockpit, hi);
  return { m, g, body, nav, strobes, nozzles };
}

function buildLights(shape) {
  const L = [];
  const nav = shape.nav.length ? shape.nav : [-1, 1].map((sx) => ({ pos: V(sx * shape.body.nav.x, shape.body.nav.y, shape.body.nav.z), side: sx }));
  for (const n of nav) {
    L.push({ pos: n.pos.clone().add(V(n.side * 0.05, 0, -0.04)), color: n.side < 0 ? [1.0, 0.07, 0.05] : [0.1, 1.0, 0.32], size: 0.13, type: LIGHT.NAV, phase: n.side < 0 ? 0 : 0.5, minAng: 0.0028 });
  }
  let strobe = shape.strobes.length ? shape.strobes.reduce((a, b) => (b.y > a.y ? b : a)) : V(0, shape.body.tail.y, shape.body.tail.z);
  L.push({ pos: strobe.clone().add(V(0, 0.08, 0)), color: [1, 1, 1], size: 0.12, type: LIGHT.STROBE, phase: 0, minAng: 0.0026 });
  L.push({ pos: V(0, 0.15, 0.3), color: [1, 1, 1], size: 1, type: LIGHT.BEACON, phase: 0, minAng: 0.014 });
  return L;
}

const _cache = new Map();
const _idle = [];
const IDLE_MAX = 8;

function acquireShape(d, lod) {
  const key = `${d.body}|${d.wings}|${d.engines}|${d.fins}|${d.cockpit}|${lod}`;
  let e = _cache.get(key);
  if (!e) {
    const lo = buildShape(d, false);
    e = { key, refs: 0, lo: { hull: lo.m.geometry(), glass: lo.g.geometry() } };
    if (lod !== 'low') { const hi = buildShape(d, true); e.hi = { hull: hi.m.geometry(), glass: hi.g.geometry() }; }
    e.nozzles = lo.nozzles.map((n) => ({ pos: n.pos.clone(), r: n.r }));
    e.lo.flames = makeFlameGeometry(e.nozzles, 6);
    if (e.hi) e.hi.flames = makeFlameGeometry(e.nozzles, 10);
    e.lights = makeLightsGeometry(buildLights(lo));
    const tris = (lv) => lv.hull.attributes.position.count / 3 + lv.glass.attributes.position.count / 3 + lv.flames.index.count / 3;
    e.tris = { high: e.hi ? tris(e.hi) : 0, low: tris(e.lo) };
    _cache.set(key, e);
  }
  const i = _idle.indexOf(e);
  if (i >= 0) _idle.splice(i, 1);
  e.refs++;
  return e;
}

function releaseShape(e) {
  if (--e.refs > 0) return;
  _idle.push(e);
  while (_idle.length > IDLE_MAX) {
    const old = _idle.shift();
    _cache.delete(old.key);
    for (const lv of [old.hi, old.lo]) if (lv) { lv.hull.dispose(); lv.glass.dispose(); lv.flames.dispose(); }
    old.lights.dispose();
  }
}

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }

export function buildCraft(designIn, { lod = 'high', underglow = true } = {}) {
  const d = normalizeDesign(designIn);
  const primary = new THREE.Color(d.colors.primary);
  const secondary = new THREE.Color(d.colors.secondary);
  const glow = new THREE.Color(d.colors.glow);
  const lodKey = lod === 'low' ? 'low' : 'high';
  const shape = acquireShape(d, lodKey);

  const hullMat = makeHullMaterial({ primary, secondary, glow }, d.finish);
  const glassMat = makeGlassMaterial(glow);
  const fMat = makeFlameMaterial(glow.clone());
  const lightsMat = makeLightsMaterial(glow);
  lightsMat.uniforms.uPhase.value = hashStr(d.id || d.name || '') * 7.3;
  const hu = hullMat.userData.uniforms, gu = glassMat.userData.uniforms;

  const root = new THREE.Group();
  const flames = [];
  const level = (lv) => {
    const grp = new THREE.Group();
    const hull = new THREE.Mesh(lv.hull, hullMat);
    const glass = new THREE.Mesh(lv.glass, glassMat);
    glass.renderOrder = 1;
    const flame = new THREE.Mesh(lv.flames, fMat);
    flame.renderOrder = 2;
    flames.push(flame);
    grp.add(hull, glass, flame);
    return grp;
  };
  let lodObj = null;
  if (shape.hi) {
    lodObj = new THREE.LOD();
    lodObj.addLevel(level(shape.hi), 0, 0.08);
    lodObj.addLevel(level(shape.lo), LOD_DIST, 0.08);
    root.add(lodObj);
  } else root.add(level(shape.lo));

  const lights = new THREE.Mesh(shape.lights, lightsMat);
  lights.renderOrder = 3;
  root.add(lights);

  let ugMat = null;
  if (lodKey === 'high' && underglow) {
    ugMat = new THREE.MeshBasicMaterial({ map: glowTexture(), color: glow, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }); // a pool of light, not a floodlight
    const ug = new THREE.Mesh(underglowGeo(), ugMat);
    ug.position.y = -0.7;
    ug.scale.set(4.5, 1, 7.5);
    root.add(ug);
  }

  const nozzles = shape.nozzles.map((n) => ({ pos: n.pos.clone(), r: n.r }));
  let highlight = 0;
  const RIM_BASE = 0.42, RIM_HI = 0.9;
  const applyRim = () => {
    hu.uRimK.value = RIM_BASE + highlight * RIM_HI;
    gu.uRimK.value = 0.5 + highlight * 0.6;
    lightsMat.uniforms.uHi.value = highlight;
  };
  applyRim();
  let disposed = false;

  return {
    root, nozzles, flames, flameMat: fMat, glowColor: glow, design: d,
    triangles: { ...shape.tris },
    setThrust(power, boost, time, glowK = 1) {
      const fu = fMat.uniforms;
      fu.uPower.value = (0.45 + power * 0.55 + boost * 0.65) * glowK;
      fu.uTime.value = time;
      fu.uLen.value = 1.2 + power * 2.2 + boost * 4.5;
      fu.uWidth.value = 0.78 + boost * 0.25;
      hu.uHot.value = (0.6 + power * 0.4 + boost * 0.5) * (0.45 + 0.55 * glowK);
      lightsMat.uniforms.uTime.value = time;
    },
    /** 0..1: brighter rim light + beacon (e.g. locked target, team-mate callout). */
    setHighlight(levelIn) {
      highlight = Math.min(1, Math.max(0, +levelIn || 0));
      applyRim();
    },
    /** Team colour for the rim light and long-range beacon; null restores the glow colour. */
    setTeamColor(c) {
      if (c == null) _col.copy(glow); else _col.set(c);
      hu.uRim.value.copy(_col);
      gu.uRim.value.copy(_col);
      lightsMat.uniforms.uTint.value.copy(_col);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hullMat.dispose(); glassMat.dispose(); fMat.dispose(); lightsMat.dispose(); ugMat?.dispose();
      releaseShape(shape);
    },
  };
}

let _ugGeo = null;
function underglowGeo() {
  if (!_ugGeo) { _ugGeo = new THREE.PlaneGeometry(1, 1); _ugGeo.rotateX(-Math.PI / 2); }
  return _ugGeo;
}
