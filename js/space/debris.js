// Destruction debris: ships that break into real chunks of their own hull, and rocks / ice /
// crystals / cargo that split into tumbling faceted pieces.
//
//   const debris = new Debris(scene, { max: 160, quality: 'high' });
//   debris.prepare(craft);                                  // optional: pre-split at race start
//   debris.shipBreak(craft, { velocity, color, intensity }); // craft can be hidden right after
//   debris.rockBreak(pos, radius, { kind, velocity, color });
//   debris.update(dt, camera, { bounds });                  // bounds(pos, radius, slot) => { normal, depth } | null
//   debris.dispose();
//
// Ships: the craft's detailed hull (the merged mesh with the per-vertex paint channel) is cut
// into ~8-18 spatially clustered pieces (area-weighted k-means on triangle centroids with a
// coherent noise term, so the cut lines are ragged), cached per design. One dying ship is ONE
// draw call: every piece lives in one geometry and the vertex shader moves each piece by its
// own quaternion + position from a small uniform array. The pieces keep the ship's paint, the
// glow strips flicker out, the torn interior (back faces) smoulders, and the bigger pieces
// trail fire and smoke. Rocks: instanced faceted chunks per kind (a few draw calls in total)
// that tumble apart with dust, gravel and sparks. Everything is pooled; update() allocates
// nothing.

import * as THREE from 'three';
import { rng, makeNoise3, hashSeed } from './util.js';
import { makeRockGeometry, rockMaterial } from './rocks.js';
import { BillboardPool, makeSpec, resetSpec } from './fx.js';
import { makeHullMaterial } from '../craft/craftMaterials.js';

const MAXP = 18;                       // pieces per ship (uniform array size)
const QUALITY = {
  high:   { slots: 4, pieces: 15, fire: 1, add: 900, alpha: 300 },
  medium: { slots: 3, pieces: 12, fire: 0.7, add: 650, alpha: 220 },
  low:    { slots: 2, pieces: 9, fire: 0.45, add: 380, alpha: 140 },
};
const SHIP_LIFE = 5.2;                 // seconds a wreck lingers (pieces vary ±)

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _ax = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Color(), _c2 = new THREE.Color();
const ZERO = new THREE.Vector3();

function randUnit(r, out) {
  const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
}
function setCol(o, c0, k0, c1, k1) { o.r0 = c0.r * k0; o.g0 = c0.g * k0; o.b0 = c0.b * k0; o.r1 = c1.r * k1; o.g1 = c1.g * k1; o.b1 = c1.b * k1; }

// ================================================================ ship hull splitting
const _splitCache = new Map();
const SPLIT_CACHE_MAX = 12;

function findParts(craft) {
  let hull = null, glass = null;
  const stack = [craft.root];
  while (stack.length) {
    const o = stack.pop();
    if (o.isMesh && o.geometry?.attributes?.chan) {
      if (!hull || o.geometry.attributes.position.count > hull.geometry.attributes.position.count) hull = o;
    }
    // highest LOD level first is enough, but walk everything (cheap: a craft is a dozen nodes)
    for (let i = 0; i < o.children.length; i++) stack.push(o.children[i]);
  }
  if (hull && hull.parent) {
    for (const s of hull.parent.children) {
      const a = s.geometry?.attributes;
      if (s !== hull && s.isMesh && a && a.normal && !a.chan && !a.aNoz) glass = s;
    }
  }
  return { hull, glass };
}

function designKey(craft, hull) {
  const d = craft.design || {};
  return `${d.body}|${d.wings}|${d.engines}|${d.fins}|${d.cockpit}|${hull.geometry.attributes.position.count}`;
}

/**
 * Cut a non-indexed hull (+ optional glass) into K ragged pieces.
 * Returns { geo, n, centers: Float32Array(n*3), radius: Float32Array(n), area: Float32Array(n), hot: Uint8Array(n), tris }.
 */
function splitHull(hullGeo, glassGeo, K, seed) {
  const HP = hullGeo.attributes.position.array, HN = hullGeo.attributes.normal.array, HC = hullGeo.attributes.chan.array;
  const nh = HP.length / 9;
  const GP = glassGeo ? glassGeo.attributes.position.array : null;
  const GN = glassGeo ? glassGeo.attributes.normal?.array : null;
  const ng = GP ? GP.length / 9 : 0;
  const nt = nh + ng;
  const cx = new Float32Array(nt), cy = new Float32Array(nt), cz = new Float32Array(nt), ar = new Float32Array(nt);
  const tri = (i) => (i < nh ? HP : GP);
  const off = (i) => (i < nh ? i : i - nh) * 9;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < nt; i++) {
    const P = tri(i), o = off(i);
    const ax = P[o], ay = P[o + 1], az = P[o + 2], bx = P[o + 3], by = P[o + 4], bz = P[o + 5], qx = P[o + 6], qy = P[o + 7], qz = P[o + 8];
    cx[i] = (ax + bx + qx) / 3; cy[i] = (ay + by + qy) / 3; cz[i] = (az + bz + qz) / 3;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    ar[i] = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-6;
    x0 = Math.min(x0, cx[i]); y0 = Math.min(y0, cy[i]); z0 = Math.min(z0, cz[i]);
    x1 = Math.max(x1, cx[i]); y1 = Math.max(y1, cy[i]); z1 = Math.max(z1, cz[i]);
  }
  const r = rng(seed);
  const noise = makeNoise3(seed + 17);
  const ext = Math.max(x1 - x0, y1 - y0, z1 - z0) || 1;
  // jaggedness of the cut lines, in units (coherent so neighbours agree -> torn, not speckled)
  const jag = ext * 0.07, nf = 1.6 / ext * 4;
  // farthest-point seeding (first seed weighted by area)
  const kx = new Float32Array(K), ky = new Float32Array(K), kz = new Float32Array(K);
  let total = 0; for (let i = 0; i < nt; i++) total += ar[i];
  let pick = r() * total, first = 0;
  for (let i = 0; i < nt; i++) { pick -= ar[i]; if (pick <= 0) { first = i; break; } }
  kx[0] = cx[first]; ky[0] = cy[first]; kz[0] = cz[first];
  const dmin = new Float32Array(nt).fill(Infinity);
  for (let k = 1; k < K; k++) {
    let best = -1, bi = 0;
    for (let i = 0; i < nt; i++) {
      const dx = cx[i] - kx[k - 1], dy = cy[i] - ky[k - 1], dz = cz[i] - kz[k - 1];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < dmin[i]) dmin[i] = d;
      const score = dmin[i] * (0.6 + 0.8 * r());   // a little randomness: not a perfect lattice
      if (score > best) { best = score; bi = i; }
    }
    kx[k] = cx[bi]; ky[k] = cy[bi]; kz[k] = cz[bi];
  }
  const asg = new Uint8Array(nt);
  const sx = new Float64Array(K), sy = new Float64Array(K), sz = new Float64Array(K), sw = new Float64Array(K);
  const assign = (withNoise) => {
    for (let i = 0; i < nt; i++) {
      let best = Infinity, bk = 0;
      for (let k = 0; k < K; k++) {
        const dx = cx[i] - kx[k], dy = cy[i] - ky[k], dz = cz[i] - kz[k];
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (withNoise) d += jag * noise(cx[i] * nf + k * 7.31, cy[i] * nf - k * 3.17, cz[i] * nf + k * 1.9);
        if (d < best) { best = d; bk = k; }
      }
      asg[i] = bk;
    }
  };
  for (let it = 0; it < 7; it++) {
    assign(false);
    sx.fill(0); sy.fill(0); sz.fill(0); sw.fill(0);
    for (let i = 0; i < nt; i++) { const k = asg[i], w = ar[i]; sx[k] += cx[i] * w; sy[k] += cy[i] * w; sz[k] += cz[i] * w; sw[k] += w; }
    for (let k = 0; k < K; k++) if (sw[k] > 0) { kx[k] = sx[k] / sw[k]; ky[k] = sy[k] / sw[k]; kz[k] = sz[k] / sw[k]; }
  }
  assign(true);
  // merge slivers into their nearest neighbour piece
  sw.fill(0);
  for (let i = 0; i < nt; i++) sw[asg[i]] += ar[i];
  const mean = total / K;
  const remap = new Int16Array(K); for (let k = 0; k < K; k++) remap[k] = k;
  for (let k = 0; k < K; k++) {
    if (sw[k] >= mean * 0.18) continue;
    let best = Infinity, bk = -1;
    for (let j = 0; j < K; j++) {
      if (j === k || sw[j] < mean * 0.18) continue;
      const d = (kx[j] - kx[k]) ** 2 + (ky[j] - ky[k]) ** 2 + (kz[j] - kz[k]) ** 2;
      if (d < best) { best = d; bk = j; }
    }
    if (bk >= 0) remap[k] = bk;
  }
  const dense = new Int16Array(K).fill(-1);
  let n = 0;
  for (let k = 0; k < K; k++) { const t = remap[k]; if (dense[t] < 0) dense[t] = n++; }
  for (let i = 0; i < nt; i++) asg[i] = dense[remap[asg[i]]];
  // per-piece pivots (area-weighted), radius, hot-engine flag
  const centers = new Float32Array(n * 3), radius = new Float32Array(n), area = new Float32Array(n), hot = new Uint8Array(n);
  const cnt = new Int32Array(n);
  for (let i = 0; i < nt; i++) {
    const k = asg[i], w = ar[i];
    centers[k * 3] += cx[i] * w; centers[k * 3 + 1] += cy[i] * w; centers[k * 3 + 2] += cz[i] * w; area[k] += w; cnt[k]++;
    if (i < nh && HC[i * 3] >= 6.5) hot[k] = 1;
  }
  for (let k = 0; k < n; k++) { centers[k * 3] /= area[k]; centers[k * 3 + 1] /= area[k]; centers[k * 3 + 2] /= area[k]; }
  // build the merged geometry (vertices grouped by piece)
  const pos = new Float32Array(nt * 9), nor = new Float32Array(nt * 9), chan = new Float32Array(nt * 3), piece = new Float32Array(nt * 12);
  const start = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) start[k + 1] = start[k] + cnt[k];
  const fill = new Int32Array(n);
  for (let i = 0; i < nt; i++) {
    const k = asg[i];
    const t = start[k] + fill[k]++;
    const P = tri(i), o = off(i);
    const N = i < nh ? HN : GN;
    for (let j = 0; j < 9; j++) { pos[t * 9 + j] = P[o + j]; nor[t * 9 + j] = N ? N[o + j] : 0; }
    // glass becomes dark recess (a charred, blown-out canopy frame)
    const ch = i < nh ? HC[i * 3] : 5;
    for (let v = 0; v < 3; v++) {
      chan[t * 3 + v] = ch;
      piece[(t * 3 + v) * 4] = centers[k * 3]; piece[(t * 3 + v) * 4 + 1] = centers[k * 3 + 1]; piece[(t * 3 + v) * 4 + 2] = centers[k * 3 + 2]; piece[(t * 3 + v) * 4 + 3] = k;
      const dx = P[o + v * 3] - centers[k * 3], dy = P[o + v * 3 + 1] - centers[k * 3 + 1], dz = P[o + v * 3 + 2] - centers[k * 3 + 2];
      radius[k] = Math.max(radius[k], Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('chan', new THREE.BufferAttribute(chan, 1));
  geo.setAttribute('aPiece', new THREE.BufferAttribute(piece, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return { geo, n, centers, radius, area, hot, tris: nt };
}

function getSplit(craft, pieces) {
  const { hull, glass } = findParts(craft);
  if (!hull) return null;
  const key = designKey(craft, hull) + '|' + pieces;
  let s = _splitCache.get(key);
  if (s) { _splitCache.delete(key); _splitCache.set(key, s); return s; }   // LRU touch
  s = splitHull(hull.geometry, glass?.geometry || null, pieces, hashSeed(key));
  s.key = key; s.users = 0;
  _splitCache.set(key, s);
  while (_splitCache.size > SPLIT_CACHE_MAX) {
    const [k0, old] = _splitCache.entries().next().value;
    if (old.users > 0) break;
    _splitCache.delete(k0); old.geo.dispose();
  }
  return s;
}

// ---------------------------------------------------------------- debris hull material
// The craft hull material (same palette channels, seams, rim light) + per-piece transforms,
// double-sided with a smouldering interior on the back faces, and a heat/char term.
const DEBRIS_VS_PARS = /* glsl */`
attribute vec4 aPiece;
uniform vec4 uPQ[${MAXP}];
uniform vec4 uPT[${MAXP}];
varying float vDbV;
vec3 db_rot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;
function debrisPatch(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + DEBRIS_VS_PARS)
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
int db_i = int(aPiece.w + 0.5);
objectNormal = db_rot(uPQ[db_i], objectNormal);
vDbV = fract(sin(aPiece.w * 12.9898 + 1.7) * 43758.5453);`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
{ vec4 db_t = uPT[db_i]; transformed = db_t.xyz + db_rot(uPQ[db_i], position - aPiece.xyz) * db_t.w; }`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uHeat, uChar, uTime;\nvarying float vDbV;')
    .replace('#include <opaque_fragment>', `{
  // scorched paint; glowing torn interior on the back faces, pulsing like embers
  float db_fl = 0.75 + 0.25 * sin(uTime * (9.0 + vDbV * 7.0) + vDbV * 30.0);
  if (!gl_FrontFacing) {
    outgoingLight = outgoingLight * 0.18 + vec3(1.0, 0.3, 0.05) * uHeat * (0.25 + 0.4 * vDbV) * db_fl;
  } else {
    outgoingLight *= 1.0 - uChar * (0.35 + 0.3 * vDbV);
    outgoingLight += vec3(1.0, 0.35, 0.08) * uHeat * uHeat * 0.06 * db_fl;
  }
}
#include <opaque_fragment>`);
}

function makeDebrisMaterial() {
  const m = makeHullMaterial({ primary: new THREE.Color(1, 1, 1), secondary: new THREE.Color(0.5, 0.5, 0.5), glow: new THREE.Color(0.3, 0.9, 1) });
  m.side = THREE.DoubleSide;
  const u = m.userData.uniforms;
  u.uPQ = { value: Array.from({ length: MAXP }, () => new THREE.Vector4(0, 0, 0, 1)) };
  u.uPT = { value: Array.from({ length: MAXP }, () => new THREE.Vector4(0, 0, 0, 0)) };
  u.uHeat = { value: 0 }; u.uChar = { value: 0 }; u.uTime = { value: 0 };
  const base = m.onBeforeCompile;
  m.onBeforeCompile = function (shader, renderer) { base.call(this, shader, renderer); debrisPatch(shader); };
  m.customProgramCacheKey = () => 'sw-debris-hull';
  return m;
}

// ================================================================ rock / plate chunks
const KINDS = ['rock', 'ice', 'crystal', 'metal'];
let _chunkGeos = null;
function facetted(g) { const f = g.index ? g.toNonIndexed() : g.clone(); f.computeVertexNormals(); f.computeBoundingSphere(); return f; }
function chunkGeometries() {
  if (_chunkGeos) return _chunkGeos;
  // fresh fracture surfaces: many flat cut planes on a lumpy base -> a broken-off piece, not a pebble
  const rockBig = [0, 1, 2].map((i) => makeRockGeometry(4101 + i * 13, { detail: 2, roughness: 0.42, facets: 5 + i, craters: i === 0, stretch: [1.25 - i * 0.1, 0.72 + i * 0.08, 1] }));
  const rockSmall = [0, 1].map((i) => makeRockGeometry(4201 + i * 7, { detail: 1, roughness: 0.55, facets: 6, craters: false, stretch: [1.3, 0.7 + i * 0.15, 0.95] }));
  const iceBig = [0, 1].map((i) => facetted(makeRockGeometry(4301 + i * 11, { detail: 2, roughness: 0.32, facets: 7 + i, craters: false, stretch: [1.35, 0.7, 0.9 + i * 0.1], tone: 0.5 })));
  const iceSmall = [facetted(makeRockGeometry(4401, { detail: 1, roughness: 0.45, facets: 7, craters: false, stretch: [1.4, 0.65, 0.9], tone: 0.5 }))];
  const shard = new THREE.OctahedronGeometry(1, 0); shard.scale(0.42, 1.25, 0.42);
  const shard2 = new THREE.OctahedronGeometry(1, 0); shard2.scale(0.3, 1.6, 0.5); shard2.rotateY(0.6);
  const plate = new THREE.BoxGeometry(1, 0.1, 0.75, 4, 1, 2);
  const P = plate.attributes.position;
  for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i); P.setY(i, P.getY(i) + x * x * 0.4 - z * 0.15); }
  plate.computeVertexNormals();
  const strip = new THREE.BoxGeometry(1.4, 0.08, 0.28, 5, 1, 1);
  const S = strip.attributes.position;
  for (let i = 0; i < S.count; i++) { const x = S.getX(i); S.setY(i, S.getY(i) + Math.sin(x * 2.4) * 0.18); S.setZ(i, S.getZ(i) + x * x * 0.12); }
  strip.computeVertexNormals();
  for (const g of [shard, shard2, plate, strip]) { g.computeBoundingSphere(); }
  _chunkGeos = { rockBig, rockSmall, iceBig, iceSmall, shard: [shard, shard2], metal: [plate, strip] };
  return _chunkGeos;
}
let _mats = null;
function chunkMaterials() {
  if (_mats) return _mats;
  const metal = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.7, roughness: 0.4, envMapIntensity: 1.2 });
  // hot shrapnel: emissive follows instance colour brightness above 1 (we push colour > 1 when hot)
  metal.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_INSTANCING_COLOR
  { vec3 db_hot = max(vColor.rgb - 1.0, 0.0); totalEmissiveRadiance += db_hot * vec3(1.0, 0.45, 0.15) * 2.0; diffuseColor.rgb = min(diffuseColor.rgb, vec3(1.0)); }
#endif`);
  };
  metal.customProgramCacheKey = () => 'sw-debris-metal';
  const crystal = new THREE.MeshPhysicalMaterial({ color: '#203040', emissive: '#ffffff', emissiveIntensity: 1.2, roughness: 0.1, metalness: 0, clearcoat: 1, flatShading: true });
  crystal.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#if defined( USE_COLOR )
  totalEmissiveRadiance *= vColor.rgb;
#endif
{ float nv = clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0); totalEmissiveRadiance *= 0.35 + 1.6 * pow(1.0 - nv, 2.0); }`);
  };
  crystal.customProgramCacheKey = () => 'sw-debris-shard';
  _mats = { rock: rockMaterial('rock'), ice: rockMaterial('ice'), crystal, metal };
  return _mats;
}

/** One instanced chunk mesh: tumbling, drag, optional wall bounce, shrink-out at end of life. */
class ChunkPool {
  constructor(scene, geo, mat, max, kind) {
    this.kind = kind; this.max = max; this.n = 0; this._rr = 0;
    this.tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.visible = false;
    scene.add(this.mesh);
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.q = new Float32Array(max * 4);
    this.ax = new Float32Array(max * 3); this.w = new Float32Array(max); this.sc = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.heat = new Float32Array(max); this.drag = new Float32Array(max); this.rad = new Float32Array(max);
  }
  spawn(px, py, pz, vx, vy, vz, sx, sy, sz, cr, cg, cb, life, spin, heat, drag, r) {
    let i;
    if (this.n < this.max) i = this.n++; else { i = this._rr; this._rr = (this._rr + 1) % this.max; }
    const i3 = i * 3;
    this.p[i3] = px; this.p[i3 + 1] = py; this.p[i3 + 2] = pz;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.sc[i3] = sx; this.sc[i3 + 1] = sy; this.sc[i3 + 2] = sz;
    this.col[i3] = cr; this.col[i3 + 1] = cg; this.col[i3 + 2] = cb;
    randUnit(r, _ax);
    this.ax[i3] = _ax.x; this.ax[i3 + 1] = _ax.y; this.ax[i3 + 2] = _ax.z;
    this.w[i] = spin * (r() < 0.5 ? -1 : 1);
    randUnit(r, _ax); _q.setFromAxisAngle(_ax, r() * 6.28);
    this.q[i * 4] = _q.x; this.q[i * 4 + 1] = _q.y; this.q[i * 4 + 2] = _q.z; this.q[i * 4 + 3] = _q.w;
    this.life[i] = 0; this.maxLife[i] = life; this.heat[i] = heat; this.drag[i] = drag;
    this.rad[i] = Math.max(sx, sy, sz);
    return i;
  }
  _move(d, s) {
    const A3 = this._a3 || (this._a3 = [this.p, this.v, this.ax, this.sc, this.col]);
    for (let j = 0; j < 5; j++) { const a = A3[j]; a[d * 3] = a[s * 3]; a[d * 3 + 1] = a[s * 3 + 1]; a[d * 3 + 2] = a[s * 3 + 2]; }
    for (let k = 0; k < 4; k++) this.q[d * 4 + k] = this.q[s * 4 + k];
    this.w[d] = this.w[s]; this.life[d] = this.life[s]; this.maxLife[d] = this.maxLife[s];
    this.heat[d] = this.heat[s]; this.drag[d] = this.drag[s]; this.rad[d] = this.rad[s];
  }
  update(dt, owner, bounds, slotBase) {
    let i = 0;
    const glow = this.kind === 'crystal';
    const ic = this.mesh.instanceColor.array;
    while (i < this.n) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) { this.n--; if (i !== this.n) this._move(i, this.n); continue; }
      const i3 = i * 3, i4 = i * 4;
      const t = this.life[i] / this.maxLife[i];
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i3] *= k; this.v[i3 + 1] *= k; this.v[i3 + 2] *= k;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      if (bounds) owner._bounce(this, i, bounds, slotBase + i);
      _q.set(this.q[i4], this.q[i4 + 1], this.q[i4 + 2], this.q[i4 + 3]);
      _ax.set(this.ax[i3], this.ax[i3 + 1], this.ax[i3 + 2]);
      _q2.setFromAxisAngle(_ax, this.w[i] * dt);
      _q.multiply(_q2);
      this.q[i4] = _q.x; this.q[i4 + 1] = _q.y; this.q[i4 + 2] = _q.z; this.q[i4 + 3] = _q.w;
      // hold full size, then shrink out over the last 30% (reads as drifting off / burning up)
      const f = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const ff = f * f * (3 - 2 * f);
      _s.set(this.sc[i3] * ff, this.sc[i3 + 1] * ff, this.sc[i3 + 2] * ff);
      _p.set(this.p[i3], this.p[i3 + 1], this.p[i3 + 2]);
      _m4.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m4);
      const h = this.heat[i] * Math.exp(-this.life[i] * 1.6);
      const g = glow ? Math.max(0.15, 1 - t * 0.9) : 1;
      ic[i3] = this.col[i3] * g + h * 1.6; ic[i3 + 1] = this.col[i3 + 1] * g + h * 0.7; ic[i3 + 2] = this.col[i3 + 2] * g + h * 0.25;
      i++;
    }
    this.mesh.count = this.n;
    if (this.n) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; }
    this.mesh.visible = this.n > 0;
  }
  dispose(scene) { scene.remove(this.mesh); this.mesh.dispose(); }
}

const DUST = { rock: new THREE.Color(0.30, 0.27, 0.24), ice: new THREE.Color(0.40, 0.50, 0.60), metal: new THREE.Color(0.20, 0.20, 0.22), crystal: new THREE.Color(0.22, 0.22, 0.30) };
const C_WHITE = new THREE.Color(1, 1, 1);
const C_SPARK0 = new THREE.Color(1.0, 0.66, 0.30);
const C_SPARK1 = new THREE.Color(1.0, 0.25, 0.05);
const C_FIRE0 = new THREE.Color(1.0, 0.5, 0.16);
const C_FIRE1 = new THREE.Color(0.55, 0.10, 0.02);
const C_SMOKE0 = new THREE.Color(0.10, 0.095, 0.09);
const C_SMOKE1 = new THREE.Color(0.045, 0.045, 0.05);
const C_CRYSTAL = new THREE.Color(0.2, 1, 0.9);
const C_TRIM = new THREE.Color('#2c3142');

// ================================================================ Debris
export class Debris {
  /**
   * @param {THREE.Scene} scene
   * @param {{max?:number, quality?:'high'|'medium'|'low', reduceMotion?:boolean, onImpact?:(pos:THREE.Vector3, speed:number, kind:string)=>void}} o
   *   max: live rock/shrapnel chunk budget. reduceMotion: calmer wreck fling/spin. onImpact: called when a chunk hits the `bounds` wall hard
   *   (for 'debris' clank audio); rate-limited to ~12/s.
   */
  constructor(scene, { max = 160, quality = 'high', reduceMotion = false, onImpact = null } = {}) {
    this.scene = scene;
    this.q = QUALITY[quality] || QUALITY.high;
    this.max = max;
    this.reduceMotion = reduceMotion;
    this.onImpact = onImpact;
    this._r = rng(4242);
    this._spec = makeSpec();
    this._time = 0;
    this._impactT = 0;
    // ship wreck slots: one mesh (one draw call) each
    this.slots = [];
    for (let s = 0; s < this.q.slots; s++) {
      const mat = makeDebrisMaterial();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.frustumCulled = false; mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.slots.push({
        mesh, mat, u: mat.userData.uniforms, split: null, active: false, t: 0, life: SHIP_LIFE, n: 0,
        p: new Float32Array(MAXP * 3), v: new Float32Array(MAXP * 3), q: new Float32Array(MAXP * 4),
        ax: new Float32Array(MAXP * 3), w: new Float32Array(MAXP), life0: new Float32Array(MAXP), burn: new Float32Array(MAXP),
        emit: new Float32Array(MAXP), rad: new Float32Array(MAXP), glow: new THREE.Color(), order: 0,
      });
    }
    this._order = 0;
    // rock / shrapnel chunks: few instanced meshes per kind
    const G = chunkGeometries(), M = chunkMaterials();
    const bigMax = Math.max(6, Math.round(max * 0.12)), smallMax = Math.max(16, Math.round(max * 0.55));
    this.pools = {
      rock: { big: G.rockBig.map((g) => new ChunkPool(scene, g, M.rock, Math.ceil(bigMax / 3), 'rock')), small: G.rockSmall.map((g) => new ChunkPool(scene, g, M.rock, Math.ceil(smallMax / 2), 'rock')) },
      ice: { big: G.iceBig.map((g) => new ChunkPool(scene, g, M.ice, Math.ceil(bigMax / 2), 'ice')), small: G.iceSmall.map((g) => new ChunkPool(scene, g, M.ice, smallMax, 'ice')) },
      crystal: { big: [new ChunkPool(scene, G.shard[1], M.crystal, bigMax, 'crystal')], small: [new ChunkPool(scene, G.shard[0], M.crystal, smallMax, 'crystal')] },
      metal: { big: [new ChunkPool(scene, G.metal[0], M.metal, bigMax, 'metal')], small: [new ChunkPool(scene, G.metal[1], M.metal, smallMax, 'metal')] },
    };
    this._poolList = [];
    for (const k of KINDS) for (const p of this.pools[k].big.concat(this.pools[k].small)) this._poolList.push(p);
    // particles: fire / sparks / glints (additive) and dust / smoke (alpha)
    this.add = new BillboardPool(scene, this.q.add, THREE.AdditiveBlending, 22);
    this.alpha = new BillboardPool(scene, this.q.alpha, THREE.NormalBlending, 18);
  }

  /** Pre-split a craft's hull (do it at race start for every design so the first death doesn't hitch). */
  prepare(craft) { if (craft) getSplit(craft, this.q.pieces); }

  /** Compile every debris program up front (optional): call once with the game renderer + camera. */
  prewarm(renderer, camera) {
    const vis = [];
    const dummy = new THREE.BufferGeometry();
    dummy.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    dummy.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
    dummy.setAttribute('chan', new THREE.BufferAttribute(new Float32Array(3), 1));
    dummy.setAttribute('aPiece', new THREE.BufferAttribute(new Float32Array(12), 4));
    const s0 = this.slots[0];
    const g0 = s0.mesh.geometry;
    s0.mesh.geometry = dummy;
    const objs = [s0.mesh, ...this._poolList.map((p) => p.mesh), this.add.mesh, this.alpha.mesh];
    for (const o of objs) { vis.push(o.visible); o.visible = true; }
    try { renderer.compile(this.scene, camera); } finally {
      objs.forEach((o, i) => { o.visible = vis[i]; });
      s0.mesh.geometry = g0; dummy.dispose();
    }
  }

  // ---------------------------------------------------------------- ships
  /**
   * Break a craft into chunks of its own hull. Call before/after hiding craft.root; uses its
   * current world transform (pass position/quaternion to override).
   * opts: velocity (ship velocity, world), color (fire/ember tint override; default warm),
   *       intensity (0.5..2: fling speed, fire, shrapnel; 1 = normal death, ~1.6 demolition),
   *       impulse (optional world vector: direction+speed of the hit, e.g. the rammer's velocity),
   *       position, quaternion (optional overrides).
   */
  shipBreak(craft, { velocity = null, color = null, intensity = 1, impulse = null, position = null, quaternion = null } = {}) {
    const split = getSplit(craft, this.q.pieces);
    if (!split) return;
    const r = this._r;
    // free slot, else the oldest
    let slot = null;
    for (const s of this.slots) if (!s.active) { slot = s; break; }
    if (!slot) { slot = this.slots[0]; for (const s of this.slots) if (s.order < slot.order) slot = s; }
    if (slot.split) slot.split.users--;
    slot.split = split; split.users++;
    slot.mesh.geometry = split.geo;
    slot.active = true; slot.t = 0; slot.n = Math.min(split.n, MAXP); slot.order = ++this._order;
    slot.intensity = intensity;
    // palette from the live craft material (keeps team / rim colours), else the design colours
    const { hull } = findParts(craft);
    const src = hull?.material?.userData?.uniforms;
    const u = slot.u;
    if (src?.uPal) {
      for (let i = 0; i < 8; i++) u.uPal.value[i].copy(src.uPal.value[i]);
      u.uRim.value.copy(src.uRim.value);
    } else if (craft.design?.colors) {
      const c = craft.design.colors;
      u.uPal.value[0].set(c.primary); u.uPal.value[1].set(c.secondary); u.uPal.value[2].set(c.glow).multiplyScalar(0.8);
      u.uPal.value[6].set(c.glow); u.uPal.value[7].set(c.glow).lerp(C_WHITE, 0.55); u.uRim.value.set(c.glow);
    }
    slot.glow.copy(u.uPal.value[6]);
    u.uRimK.value = 0.25;
    // world transform of the ship
    craft.root.updateMatrixWorld(true);
    const mw = craft.root.matrixWorld;
    const sp = _p, sq = _q3;
    if (position) sp.copy(position); else sp.setFromMatrixPosition(mw);
    if (quaternion) sq.copy(quaternion); else { mw.decompose(_v, sq, _s); }
    const vx0 = velocity ? velocity.x : 0, vy0 = velocity ? velocity.y : 0, vz0 = velocity ? velocity.z : 0;
    const ix = impulse ? impulse.x : 0, iy = impulse ? impulse.y : 0, iz = impulse ? impulse.z : 0;
    const I = Math.max(0.3, intensity) * (this.reduceMotion ? 0.7 : 1);   // reduceMotion: calmer fling + spin
    // which pieces burn: the biggest few + anything with engine cores
    let maxA = 0; for (let k = 0; k < slot.n; k++) maxA = Math.max(maxA, split.area[k]);
    for (let k = 0; k < slot.n; k++) {
      const k3 = k * 3, k4 = k * 4;
      _v.set(split.centers[k3], split.centers[k3 + 1], split.centers[k3 + 2]);
      const lc = _v.length();
      _v2.copy(_v).applyQuaternion(sq);                 // pivot offset in world orientation
      const dir = lc > 0.05 ? _ax.copy(_v2).divideScalar(lc) : randUnit(r, _ax);
      const sizeK = Math.sqrt(split.area[k] / maxA);    // 0..1, big pieces are slower
      const kick = (5 + r() * 9) * I * (1.25 - 0.6 * sizeK);
      slot.p[k3] = sp.x + _v2.x + dir.x * 0.25; slot.p[k3 + 1] = sp.y + _v2.y + dir.y * 0.25; slot.p[k3 + 2] = sp.z + _v2.z + dir.z * 0.25;
      // keep most of the ship's momentum: the wreck tumbles on down the track with you
      const carry = 0.62 + r() * 0.25;
      slot.v[k3] = vx0 * carry + dir.x * kick + (r() - 0.5) * 4 * I + ix * 0.35 * (0.6 + r() * 0.6);
      slot.v[k3 + 1] = vy0 * carry + dir.y * kick + (r() - 0.5) * 4 * I + iy * 0.35 * (0.6 + r() * 0.6);
      slot.v[k3 + 2] = vz0 * carry + dir.z * kick + (r() - 0.5) * 4 * I + iz * 0.35 * (0.6 + r() * 0.6);
      randUnit(r, _ax);
      slot.ax[k3] = _ax.x; slot.ax[k3 + 1] = _ax.y; slot.ax[k3 + 2] = _ax.z;
      slot.w[k] = (1.2 + r() * 3.5) * (1.4 - 0.7 * sizeK) * Math.sqrt(I) * (r() < 0.5 ? -1 : 1);
      slot.q[k4] = sq.x; slot.q[k4 + 1] = sq.y; slot.q[k4 + 2] = sq.z; slot.q[k4 + 3] = sq.w;
      slot.life0[k] = SHIP_LIFE * (0.75 + r() * 0.4) * (0.85 + 0.3 * sizeK);
      slot.burn[k] = (split.hot[k] || sizeK > 0.55 || r() < 0.25) ? (0.6 + 0.4 * r()) * this.q.fire * Math.min(1.5, I) : 0;
      slot.emit[k] = r() * 0.05;
      slot.rad[k] = split.radius[k];
    }
    slot.life = 0; for (let k = 0; k < slot.n; k++) slot.life = Math.max(slot.life, slot.life0[k]);
    this._writeSlot(slot);
    slot.mesh.visible = true;

    // shrapnel: hot bent plates and strips in the ship's paint, flung fast
    const pal = u.uPal.value;
    const nShrap = Math.round((10 + 8 * r()) * Math.min(1.6, I) * (this.q.fire > 0.6 ? 1 : 0.6));
    for (let i = 0; i < nShrap; i++) {
      randUnit(r, _ax);
      const fast = (14 + r() * 26) * I;
      const big = r() < 0.3;
      const pool = big ? this.pools.metal.big[0] : this.pools.metal.small[0];
      const s = big ? 0.35 + r() * 0.45 : 0.25 + r() * 0.4;
      const c = r() < 0.45 ? pal[0] : r() < 0.6 ? pal[1] : C_TRIM;
      pool.spawn(sp.x + _ax.x * 1.2, sp.y + _ax.y * 1.2, sp.z + _ax.z * 1.2,
        vx0 * 0.7 + _ax.x * fast + ix * 0.3, vy0 * 0.7 + _ax.y * fast + iy * 0.3, vz0 * 0.7 + _ax.z * fast + iz * 0.3,
        s, s, s, c.r, c.g, c.b, 2.2 + r() * 2.2, 3 + r() * 9, 0.7 + r() * 0.6, 0.35, r);
    }
    // burning sparks + embers fanning out, and a dense smoke core that the wreck flies out of
    const o = this._spec;
    const fireTint = color ? _c.set(color) : null;
    const nSparks = Math.round(46 * Math.min(1.8, I) * (this.q.fire > 0.6 ? 1 : 0.6));
    for (let i = 0; i < nSparks; i++) {
      resetSpec(o); randUnit(r, _ax);
      o.shape = 3; o.px = sp.x; o.py = sp.y; o.pz = sp.z;
      const v = (25 + r() * 70) * I;
      o.vx = vx0 * 0.8 + _ax.x * v; o.vy = vy0 * 0.8 + _ax.y * v; o.vz = vz0 * 0.8 + _ax.z * v;
      o.drag = 1.2 + r(); o.life = 0.5 + r() * 1.1; o.s0 = o.s1 = 0.09 + r() * 0.08; o.streak = 0.045; o.fadePow = 1.1;
      setCol(o, fireTint || C_SPARK0, 3.4, C_SPARK1, 1.4);
      this.add.spawn(o);
    }
    for (let i = 0; i < 8; i++) {
      resetSpec(o); randUnit(r, _ax);
      o.shape = 0; o.variant = Math.floor(r() * 4);
      o.px = sp.x + _ax.x * 2; o.py = sp.y + _ax.y * 2; o.pz = sp.z + _ax.z * 2;
      const v = 3 + r() * 6;
      o.vx = vx0 * 0.55 + _ax.x * v; o.vy = vy0 * 0.55 + _ax.y * v; o.vz = vz0 * 0.55 + _ax.z * v;
      o.drag = 0.9; o.life = 2.6 + r() * 1.8; o.s0 = 4 + r() * 3; o.s1 = 12 + r() * 8;
      o.rot = r() * 6.28; o.rotV = (r() - 0.5) * 0.5; o.alpha = 0.6; o.fadeIn = 0.06; o.fadePow = 1.4; o.ease = 2.5; o.delay = 0.05 + r() * 0.1;
      setCol(o, C_SMOKE0, 1, C_SMOKE1, 1);
      this.alpha.spawn(o);
    }
  }

  _writeSlot(slot) {
    const PQ = slot.u.uPQ.value, PT = slot.u.uPT.value;
    for (let k = 0; k < slot.n; k++) {
      const k3 = k * 3, k4 = k * 4;
      PQ[k].set(slot.q[k4], slot.q[k4 + 1], slot.q[k4 + 2], slot.q[k4 + 3]);
      const lt = slot.t / slot.life0[k];
      const f = lt < 0.72 ? 1 : Math.max(0, 1 - (lt - 0.72) / 0.28);
      PT[k].set(slot.p[k3], slot.p[k3 + 1], slot.p[k3 + 2], f * f * (3 - 2 * f));
    }
    for (let k = slot.n; k < MAXP; k++) PT[k].w = 0;
  }

  _updateSlot(slot, dt, bounds, slotIdx) {
    slot.t += dt;
    const t = slot.t;
    if (t >= slot.life) {
      slot.active = false; slot.mesh.visible = false;
      if (slot.split) { slot.split.users--; slot.split = null; }
      return;
    }
    const u = slot.u;
    u.uTime.value = this._time;
    // glow strips sputter and die, interior embers cool, paint scorches
    const pw = Math.max(0, 1 - t * 1.1);
    const sput = pw > 0 ? (0.55 + 0.45 * Math.sin(t * 37 + Math.sin(t * 13) * 3)) * pw : 0;
    u.uEm.value[6] = 1.0 * sput; u.uEm.value[7] = 1.25 * sput;
    u.uHot.value = sput;
    u.uHeat.value = Math.min(1, 1.4 * Math.exp(-t * 0.8)) * Math.min(1.2, slot.intensity);
    u.uChar.value = Math.min(1, t * 1.8) * 0.55;
    const linDrag = Math.exp(-0.22 * dt), angDrag = Math.exp(-0.15 * dt);
    const r = this._r, o = this._spec;
    for (let k = 0; k < slot.n; k++) {
      const k3 = k * 3, k4 = k * 4;
      slot.v[k3] *= linDrag; slot.v[k3 + 1] *= linDrag; slot.v[k3 + 2] *= linDrag;
      slot.p[k3] += slot.v[k3] * dt; slot.p[k3 + 1] += slot.v[k3 + 1] * dt; slot.p[k3 + 2] += slot.v[k3 + 2] * dt;
      slot.w[k] *= angDrag;
      if (bounds) this._bounceSlot(slot, k, bounds, 4096 + slotIdx * MAXP + k);
      _q.set(slot.q[k4], slot.q[k4 + 1], slot.q[k4 + 2], slot.q[k4 + 3]);
      _ax.set(slot.ax[k3], slot.ax[k3 + 1], slot.ax[k3 + 2]);
      _q2.setFromAxisAngle(_ax, slot.w[k] * dt);
      _q.premultiply(_q2);
      slot.q[k4] = _q.x; slot.q[k4 + 1] = _q.y; slot.q[k4 + 2] = _q.z; slot.q[k4 + 3] = _q.w;
      // fire + smoke trails from burning pieces (rate falls as they cool)
      const burn = slot.burn[k] * Math.exp(-t * 0.42) * (t < slot.life0[k] * 0.8 ? 1 : 0);
      if (burn > 0.04) {
        slot.emit[k] -= dt;
        const rad = slot.rad[k];
        while (slot.emit[k] <= 0) {
          slot.emit[k] += 0.028 / burn;
          resetSpec(o);
          o.shape = 4; o.variant = Math.floor(r() * 4);
          o.px = slot.p[k3] + (r() - 0.5) * rad * 0.6; o.py = slot.p[k3 + 1] + (r() - 0.5) * rad * 0.6; o.pz = slot.p[k3 + 2] + (r() - 0.5) * rad * 0.6;
          o.vx = slot.v[k3] * 0.35 + (r() - 0.5) * 3; o.vy = slot.v[k3 + 1] * 0.35 + (r() - 0.5) * 3; o.vz = slot.v[k3 + 2] * 0.35 + (r() - 0.5) * 3;
          o.drag = 1.8; o.life = 0.3 + r() * 0.4; o.s0 = rad * (0.3 + r() * 0.25) * Math.min(1, burn + 0.3); o.s1 = rad * (0.75 + r() * 0.45);
          o.rot = r() * 6.28; o.rotV = (r() - 0.5) * 3; o.alpha = 0.65 * Math.min(1, burn * 1.4); o.fadePow = 1.4; o.ease = 2.4; o.colPow = 0.5;
          setCol(o, C_FIRE0, 1.15, C_FIRE1, 0.6);
          this.add.spawn(o);
          if (r() < 0.6) {    // smoke trail behind the fire
            resetSpec(o);
            o.shape = 0; o.variant = Math.floor(r() * 4);
            o.px = slot.p[k3]; o.py = slot.p[k3 + 1]; o.pz = slot.p[k3 + 2];
            o.vx = slot.v[k3] * 0.15 + (r() - 0.5) * 2; o.vy = slot.v[k3 + 1] * 0.15 + (r() - 0.5) * 2; o.vz = slot.v[k3 + 2] * 0.15 + (r() - 0.5) * 2;
            o.drag = 1.1; o.life = 1.3 + r() * 1.2; o.s0 = rad * 0.6; o.s1 = rad * (2.2 + r()); o.rot = r() * 6.28; o.rotV = (r() - 0.5) * 0.8;
            o.alpha = 0.55; o.fadeIn = 0.1; o.fadePow = 1.3; o.ease = 2.2; o.delay = 0.06;
            setCol(o, C_SMOKE0, 1, C_SMOKE1, 1);
            this.alpha.spawn(o);
          }
          if (r() < 0.3) {    // a stray ember
            resetSpec(o); randUnit(r, _ax);
            o.shape = 1; o.px = slot.p[k3]; o.py = slot.p[k3 + 1]; o.pz = slot.p[k3 + 2];
            const v = 4 + r() * 10;
            o.vx = slot.v[k3] * 0.5 + _ax.x * v; o.vy = slot.v[k3 + 1] * 0.5 + _ax.y * v; o.vz = slot.v[k3 + 2] * 0.5 + _ax.z * v;
            o.drag = 0.8; o.life = 0.8 + r() * 1.0; o.s0 = o.s1 = 0.16 + r() * 0.12; o.fadePow = 1.4;
            setCol(o, C_FIRE0, 3, C_SPARK1, 1);
            this.add.spawn(o);
          }
        }
      }
    }
    this._writeSlot(slot);
  }

  // ---------------------------------------------------------------- rocks
  /**
   * Break a rock / ice boulder / crystal / cargo pod into tumbling chunks.
   * kind: 'rock' | 'ice' | 'crystal' | 'metal' (anything else -> rock). velocity: e.g. the
   * rammer's or the rock's velocity (chunks inherit ~40%). color: tint (crystal glow / pod paint).
   */
  rockBreak(pos, radius, { kind = 'rock', velocity = null, color = null } = {}) {
    const k = this.pools[kind] ? kind : 'rock';
    const P = this.pools[k];
    const r = this._r, o = this._spec;
    const R = Math.max(0.4, radius);
    const vx0 = velocity ? velocity.x * 0.4 : 0, vy0 = velocity ? velocity.y * 0.4 : 0, vz0 = velocity ? velocity.z * 0.4 : 0;
    const tint = color ? _c2.set(color) : null;
    let cr = 1, cg = 1, cb = 1;
    if (tint) { cr = tint.r; cg = tint.g; cb = tint.b; } else if (k === 'crystal') { cr = C_CRYSTAL.r; cg = C_CRYSTAL.g; cb = C_CRYSTAL.b; }
    const live = this.liveChunks;
    const room = Math.max(0, this.max - live);
    // big pieces: a few slabs that keep most of the mass and drift apart slowly
    const nb = Math.min(R < 2.5 ? 2 : R < 7 ? 4 : R < 20 ? 5 : 6, Math.max(1, room));
    const sb = R * Math.cbrt(0.55 / nb);
    const speedK = 2.5 + Math.sqrt(R) * 1.6;
    const ga = Math.PI * (3 - Math.sqrt(5)), rot0 = r() * 6.28;
    for (let i = 0; i < nb; i++) {
      // fibonacci directions so the slabs fan out evenly
      const y = 1 - (i + 0.5) / nb * 2, rr = Math.sqrt(1 - y * y), a = rot0 + i * ga;
      _ax.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
      const pool = P.big[i % P.big.length];
      const s = sb * (0.8 + r() * 0.4);
      const sp = speedK * (0.6 + r() * 0.8);
      const shade = k === 'crystal' ? 1 : 0.85 + r() * 0.25;
      pool.spawn(pos.x + _ax.x * R * 0.42, pos.y + _ax.y * R * 0.42, pos.z + _ax.z * R * 0.42,
        vx0 + _ax.x * sp, vy0 + _ax.y * sp, vz0 + _ax.z * sp,
        s * (0.9 + r() * 0.3), s * (0.7 + r() * 0.3), s * (0.9 + r() * 0.3), cr * shade, cg * shade, cb * shade,
        4.5 + r() * 2.5, (0.3 + r() * 1.1) * Math.sqrt(6 / Math.max(3, R)), k === 'metal' ? 0.5 : 0, 0.12, r);
    }
    // medium + gravel
    const nm = Math.min(Math.round(Math.min(26, 8 + R * 1.3) * (this.q.fire > 0.6 ? 1 : 0.65)), Math.max(0, room - nb));
    for (let i = 0; i < nm; i++) {
      randUnit(r, _ax);
      const pool = P.small[i % P.small.length];
      const gravel = i > nm * 0.55;
      const s = R * (gravel ? 0.04 + r() * 0.05 : 0.1 + Math.pow(r(), 1.5) * 0.16);
      const sp = speedK * (gravel ? 2.2 + r() * 2.5 : 1.0 + r() * 1.6);
      const shade = k === 'crystal' ? 1 : 0.8 + r() * 0.3;
      pool.spawn(pos.x + _ax.x * R * 0.5 * r(), pos.y + _ax.y * R * 0.5 * r(), pos.z + _ax.z * R * 0.5 * r(),
        vx0 + _ax.x * sp, vy0 + _ax.y * sp, vz0 + _ax.z * sp,
        s * (0.8 + r() * 0.5), s * (0.6 + r() * 0.5), s * (0.8 + r() * 0.5), cr * shade, cg * shade, cb * shade,
        (gravel ? 1.8 : 2.8) + r() * 1.6, 1 + r() * 5, k === 'metal' ? 0.8 : 0, 0.25, r);
    }
    // dust: a thick puff that billows out and hangs (rock), a frost mist (ice)
    const dust = DUST[k];
    const nd = k === 'metal' ? 4 : k === 'crystal' ? 4 : 9;
    for (let i = 0; i < nd; i++) {
      resetSpec(o); randUnit(r, _ax);
      o.shape = 0; o.variant = Math.floor(r() * 4);
      o.px = pos.x + _ax.x * R * 0.35; o.py = pos.y + _ax.y * R * 0.35; o.pz = pos.z + _ax.z * R * 0.35;
      const sp = R * (0.5 + r() * 0.9);
      o.vx = vx0 * 0.6 + _ax.x * sp; o.vy = vy0 * 0.6 + _ax.y * sp; o.vz = vz0 * 0.6 + _ax.z * sp;
      o.drag = 1.0; o.life = 2.4 + r() * 1.8; o.s0 = R * (0.7 + r() * 0.5); o.s1 = R * (2.0 + r() * 1.4);
      o.rot = r() * 6.28; o.rotV = (r() - 0.5) * 0.5; o.alpha = k === 'ice' ? 0.3 : k === 'rock' ? 0.7 : 0.4; o.fadeIn = 0.04; o.fadePow = 1.5; o.ease = 3;
      const sh = 0.8 + r() * 0.4;
      setCol(o, dust, sh, dust, sh * 0.7);
      this.alpha.spawn(o);
    }
    // streaks: gravel (rock), glints (ice / crystal), sparks (metal)
    const ns = k === 'metal' ? 26 : 16;
    for (let i = 0; i < ns; i++) {
      resetSpec(o); randUnit(r, _ax);
      o.shape = 3; o.px = pos.x; o.py = pos.y; o.pz = pos.z;
      const sp = speedK * (2 + r() * 3.5) + 6;
      o.vx = vx0 + _ax.x * sp; o.vy = vy0 + _ax.y * sp; o.vz = vz0 + _ax.z * sp;
      o.drag = 1.3; o.life = 0.5 + r() * 0.8; o.s0 = o.s1 = R * 0.03 + 0.06; o.streak = 0.06; o.fadePow = 1.2;
      if (k === 'metal') { setCol(o, C_SPARK0, 3.2, C_SPARK1, 1.4); this.add.spawn(o); }
      else if (k === 'crystal') { const c = tint || C_CRYSTAL; setCol(o, c, 3, c, 1); this.add.spawn(o); }
      else if (k === 'ice') { setCol(o, C_WHITE, 1.5, DUST.ice, 0.8); o.alpha = 0.6; this.add.spawn(o); }
      else { setCol(o, DUST.rock, 1.1, DUST.rock, 0.6); o.alpha = 0.85; o.life += 0.5; this.alpha.spawn(o); }
    }
    // impact flash
    resetSpec(o);
    o.shape = 1; o.px = pos.x; o.py = pos.y; o.pz = pos.z; o.vx = vx0; o.vy = vy0; o.vz = vz0;
    o.life = k === 'crystal' ? 0.45 : 0.2; o.s0 = R * 1.3; o.s1 = R * (k === 'crystal' ? 4.2 : 2.4); o.fadePow = 2;
    if (k === 'ice') setCol(o, DUST.ice, 2.4, DUST.ice, 1);
    else if (k === 'crystal') { const c = tint || C_CRYSTAL; setCol(o, c, 3.5, c, 1.5); }
    else setCol(o, C_SPARK0, k === 'metal' ? 4 : 1.6, C_SPARK1, 0.6);
    this.add.spawn(o);
    if (k === 'crystal' || k === 'ice') {   // shimmer motes
      for (let i = 0; i < 12; i++) {
        resetSpec(o); randUnit(r, _ax);
        o.shape = 1; o.px = pos.x + _ax.x * R * 0.5; o.py = pos.y + _ax.y * R * 0.5; o.pz = pos.z + _ax.z * R * 0.5;
        const sp = speedK * (0.4 + r() * 1.0);
        o.vx = vx0 + _ax.x * sp; o.vy = vy0 + _ax.y * sp; o.vz = vz0 + _ax.z * sp; o.drag = 0.8;
        o.life = 1.2 + r() * 1.3; o.s0 = o.s1 = R * 0.06 + 0.15; o.fadePow = 1.5;
        const c = k === 'ice' ? DUST.ice : (tint || C_CRYSTAL); setCol(o, c, k === 'ice' ? 1.6 : 2.5, c, 1);
        this.add.spawn(o);
      }
    }
  }

  // ---------------------------------------------------------------- wall bounce
  _bounce(pool, i, bounds, slot) {
    const i3 = i * 3;
    _v.set(pool.p[i3], pool.p[i3 + 1], pool.p[i3 + 2]);
    const hit = bounds(_v, pool.rad[i], slot);
    if (!hit || !(hit.depth > 0)) return;
    const n = hit.normal;
    pool.p[i3] += n.x * hit.depth; pool.p[i3 + 1] += n.y * hit.depth; pool.p[i3 + 2] += n.z * hit.depth;
    const vn = pool.v[i3] * n.x + pool.v[i3 + 1] * n.y + pool.v[i3 + 2] * n.z;
    if (vn >= 0) return;
    const e = 1.35;   // restitution 0.35, plus 15% tangential friction
    pool.v[i3] = (pool.v[i3] - vn * e * n.x) * 0.85; pool.v[i3 + 1] = (pool.v[i3 + 1] - vn * e * n.y) * 0.85; pool.v[i3 + 2] = (pool.v[i3 + 2] - vn * e * n.z) * 0.85;
    pool.w[i] = pool.w[i] * 0.6 + (this._r() - 0.5) * Math.min(8, -vn * 0.4);
    if (-vn > 6) this._impact(_v, -vn, pool.kind, pool.rad[i]);
  }
  _bounceSlot(slot, k, bounds, id) {
    const k3 = k * 3;
    _v.set(slot.p[k3], slot.p[k3 + 1], slot.p[k3 + 2]);
    const hit = bounds(_v, slot.rad[k] * 0.6, id);
    if (!hit || !(hit.depth > 0)) return;
    const n = hit.normal;
    slot.p[k3] += n.x * hit.depth; slot.p[k3 + 1] += n.y * hit.depth; slot.p[k3 + 2] += n.z * hit.depth;
    const vn = slot.v[k3] * n.x + slot.v[k3 + 1] * n.y + slot.v[k3 + 2] * n.z;
    if (vn >= 0) return;
    slot.v[k3] = (slot.v[k3] - vn * 1.3 * n.x) * 0.8; slot.v[k3 + 1] = (slot.v[k3 + 1] - vn * 1.3 * n.y) * 0.8; slot.v[k3 + 2] = (slot.v[k3 + 2] - vn * 1.3 * n.z) * 0.8;
    slot.w[k] = slot.w[k] * 0.5 + (this._r() - 0.5) * Math.min(6, -vn * 0.3);
    if (-vn > 5) this._impact(_v, -vn, 'metal', slot.rad[k]);
  }
  _impact(p, speed, kind, rad) {
    const r = this._r, o = this._spec;
    // grinding sparks off the wall (metal) / grit (rock)
    const n = Math.min(14, 3 + Math.round(speed * 0.25));
    for (let i = 0; i < n; i++) {
      resetSpec(o); randUnit(r, _ax);
      o.shape = 3; o.px = p.x; o.py = p.y; o.pz = p.z;
      const v = speed * (0.4 + r() * 0.9) + 5;
      o.vx = _ax.x * v; o.vy = _ax.y * v; o.vz = _ax.z * v;
      o.drag = 2; o.life = 0.25 + r() * 0.4; o.s0 = o.s1 = 0.06 + rad * 0.02; o.streak = 0.05; o.fadePow = 1.2;
      if (kind === 'metal') setCol(o, C_SPARK0, 3, C_SPARK1, 1.2); else setCol(o, DUST.rock, 1.6, DUST.rock, 0.8);
      this.add.spawn(o);
    }
    if (this.onImpact && this._impactT <= 0) { this._impactT = 0.08; this.onImpact(p, speed, kind); }
  }

  // ---------------------------------------------------------------- frame
  /**
   * @param {number} dt
   * @param {THREE.Camera} camera (unused for now; kept for API symmetry / future LOD)
   * @param {{bounds?: (pos:THREE.Vector3, radius:number, id:number)=>({normal:THREE.Vector3, depth:number}|null)}} [o]
   *   bounds: wall test. `normal` = unit vector pointing back INTO the play space, `depth` = how far
   *   the (radius-inflated) point is past the wall (> 0 = penetrating). `id` is a stable per-chunk
   *   index you can use to cache a hint (e.g. a course sample index). Return null when clear.
   */
  update(dt, camera, { bounds = null } = {}) {
    void camera;
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    this._time += dt;
    this._impactT -= dt;
    for (let s = 0; s < this.slots.length; s++) if (this.slots[s].active) this._updateSlot(this.slots[s], dt, bounds, s);
    let base = 0;
    for (const p of this._poolList) { p.update(dt, this, bounds, base); base += p.max; }
    this.add.update(dt);
    this.alpha.update(dt);
  }

  get liveChunks() { let n = 0; for (const p of this._poolList) n += p.n; return n; }
  get activeShips() { let n = 0; for (const s of this.slots) if (s.active) n++; return n; }

  /** Live counts for the perf HUD: draw calls (non-empty meshes) and triangles. */
  stats() {
    let calls = 0, tris = 0;
    for (const s of this.slots) if (s.active) { calls++; tris += s.split.tris; }
    for (const p of this._poolList) if (p.n) { calls++; tris += p.n * p.tris; }
    if (this.add.n) { calls++; tris += this.add.n * 2; }
    if (this.alpha.n) { calls++; tris += this.alpha.n * 2; }
    return { calls, tris, ships: this.activeShips, chunks: this.liveChunks, particles: this.add.n + this.alpha.n };
  }

  clear() {
    for (const s of this.slots) { s.active = false; s.mesh.visible = false; if (s.split) { s.split.users--; s.split = null; } }
    for (const p of this._poolList) { p.n = 0; p.mesh.count = 0; p.mesh.visible = false; }
    this.add.clear(); this.alpha.clear();
  }

  dispose() {
    this.clear();
    for (const s of this.slots) { this.scene.remove(s.mesh); s.mat.dispose(); }
    for (const p of this._poolList) p.dispose(this.scene);
    this.add.dispose(); this.alpha.dispose();
  }
}

/**
 * Ready-made `bounds` for a wormhole Course (js/flight/course.js): keeps chunks inside the tube.
 * Uses Course.locate with a per-chunk hint, so each test is a few hill-climb steps. Allocation-free.
 */
export function tunnelBounds(course) {
  const hints = new Int32Array(8192);
  const out = { i: 0, u: 0, c: new THREE.Vector3(), t: new THREE.Vector3() };
  const res = { normal: new THREE.Vector3(), depth: 0 };
  const d = new THREE.Vector3();
  return (pos, radius = 0, id = 0) => {
    const h = id & 8191;
    course.locate(pos, hints[h], out);
    // A stale hint can settle on another stretch of tube passing close by (crossovers):
    // anything that far off the line is re-found from scratch.
    const far = course.tunnelRadiusAt(out.u) * 1.6 + radius;
    if (out.c.distanceToSquared(pos) > far * far) course.locate(pos, Math.round(course.nearestU(pos).u * course.sampleCount), out);
    hints[h] = out.i;
    d.subVectors(pos, out.c);
    d.addScaledVector(out.t, -d.dot(out.t));
    const dist = d.length();
    const R = course.tunnelRadiusAt(out.u) - radius;
    if (dist <= R || dist < 1e-4) return null;
    res.normal.copy(d).multiplyScalar(-1 / dist);
    res.depth = dist - R;
    return res;
  };
}
