// Procedural asteroids: lumpy displaced geodesic spheres with craters, fracture facets and
// baked cavity/tonal vertex colours; shared materials with fine per-pixel surface detail;
// an instanced decorative belt with GPU tumbling.

import * as THREE from 'three';
import { rng, makeNoise3, fbm3, ridged3, GLSL_NOISE } from './util.js';

// ---------------------------------------------------------------- geodesic base (shared vertices)
const FREQ = [1, 2, 4, 6, 9, 12, 16];   // edge subdivisions by `detail` -> tris = 20*f^2
const baseCache = new Map();
function geodesic(detail) {
  const f = FREQ[Math.max(0, Math.min(FREQ.length - 1, detail | 0))];
  if (baseCache.has(f)) return baseCache.get(f);
  const t = (1 + Math.sqrt(5)) / 2;
  const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const pos = []; const idx = []; const map = new Map();
  const vid = (x, y, z) => {
    const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
    const k = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let i = map.get(k);
    if (i === undefined) { i = pos.length / 3; pos.push(x, y, z); map.set(k, i); }
    return i;
  };
  const tri = (a, b, c) => {
    // keep outward winding
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * ax + ny * ay + nz * az >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  for (const [ia, ib, ic] of F) {
    const A = V[ia], B = V[ib], C = V[ic];
    const ids = [];
    for (let i = 0; i <= f; i++) {
      ids[i] = [];
      for (let j = 0; j <= f - i; j++) {
        const u = i / f, v = j / f;
        ids[i][j] = vid(A[0] + (B[0] - A[0]) * u + (C[0] - A[0]) * v, A[1] + (B[1] - A[1]) * u + (C[1] - A[1]) * v, A[2] + (B[2] - A[2]) * u + (C[2] - A[2]) * v);
      }
    }
    for (let i = 0; i < f; i++) {
      for (let j = 0; j < f - i; j++) {
        tri(ids[i][j], ids[i + 1][j], ids[i][j + 1]);
        if (j < f - i - 1) tri(ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
      }
    }
  }
  const out = { pos: new Float32Array(pos), idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) };
  baseCache.set(f, out);
  return out;
}

function randDir(r, out = new THREE.Vector3()) {
  const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
}

// ---------------------------------------------------------------- rock geometry
const geoCache = new Map();
/**
 * Lumpy irregular asteroid. Max radius normalised to 1 (visual size == collision radius).
 * Extra (non-breaking) options: facets (fracture planes, default 2), tone (base tone variance).
 */
export function makeRockGeometry(seed, { detail = 3, roughness = 0.35, stretch = [1, 1, 1], craters = true, facets = 2, tone = 1 } = {}) {
  const key = `${seed}|${detail}|${roughness}|${stretch.join(',')}|${craters}|${facets}|${tone}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const r = rng(seed * 7919 + 13);
  const noise = makeNoise3(seed * 31 + 7);
  const base = geodesic(detail);
  const nv = base.pos.length / 3;
  const P = new Float32Array(base.pos.length);
  const crat = new Float32Array(nv);    // crater floor factor
  const rimF = new Float32Array(nv);

  // crater set: few large, more small
  const cr = [];
  if (craters) {
    const nc = 4 + Math.floor(r() * 6) + (detail >= 4 ? 4 : 0);
    for (let i = 0; i < nc; i++) {
      const big = i < 2;
      const rad = big ? 0.3 + r() * 0.28 : 0.14 + r() * r() * 0.2;
      cr.push({ d: randDir(r), r: rad, depth: rad * (0.3 + r() * 0.2) });
    }
  }
  // fracture planes -> flat chipped faces
  const planes = [];
  for (let i = 0; i < facets; i++) planes.push({ n: randDir(r), o: 0.62 + r() * 0.22 });
  const o1 = [r() * 50, r() * 50, r() * 50];
  const rough = roughness;
  const tmp = new THREE.Vector3();
  let maxR = 0;
  for (let i = 0; i < nv; i++) {
    const x = base.pos[i * 3], y = base.pos[i * 3 + 1], z = base.pos[i * 3 + 2];
    // large lumps + mid detail + sharp ridges
    let h = 0;
    h += 1.5 * rough * fbm3(noise, x * 0.85 + o1[0], y * 0.85 + o1[1], z * 0.85 + o1[2], 3);
    h += 0.55 * rough * fbm3(noise, x * 2.4 - o1[1], y * 2.4 + o1[2], z * 2.4 - o1[0], 4);
    h += 0.22 * rough * (ridged3(noise, x * 4.8, y * 4.8, z * 4.8, 3) - 0.55);
    let cf = 0, rf = 0;
    for (const c of cr) {
      const dx = x - c.d.x, dy = y - c.d.y, dz = z - c.d.z;
      const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / c.r;
      if (q < 1.7) {
        if (q < 1) { const b = 1 - q * q; h -= c.depth * b; cf = Math.max(cf, b); }
        const rim = Math.exp(-((q - 1) * (q - 1)) / 0.06);
        h += c.depth * 0.32 * rim; rf = Math.max(rf, rim);
      }
    }
    crat[i] = cf; rimF[i] = rf;
    const R = 1 + h;
    tmp.set(x * R * stretch[0], y * R * stretch[1], z * R * stretch[2]);
    for (const pl of planes) {
      const d = tmp.dot(pl.n) - pl.o;
      if (d > 0) tmp.addScaledVector(pl.n, -d * 0.9);
    }
    P[i * 3] = tmp.x; P[i * 3 + 1] = tmp.y; P[i * 3 + 2] = tmp.z;
    maxR = Math.max(maxR, tmp.length());
  }
  for (let i = 0; i < P.length; i++) P[i] /= maxR;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setIndex(new THREE.BufferAttribute(base.idx, 1));
  geo.computeVertexNormals();

  // cavity (concavity) from neighbour averages
  const idx = base.idx;
  const sum = new Float32Array(nv * 3), cnt = new Float32Array(nv);
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + (k + 1) % 3];
      sum[a * 3] += P[b * 3]; sum[a * 3 + 1] += P[b * 3 + 1]; sum[a * 3 + 2] += P[b * 3 + 2]; cnt[a]++;
      sum[b * 3] += P[a * 3]; sum[b * 3 + 1] += P[a * 3 + 1]; sum[b * 3 + 2] += P[a * 3 + 2]; cnt[b]++;
    }
  }
  const N = geo.attributes.normal.array;
  const edge = 3.2 / FREQ[Math.max(0, Math.min(FREQ.length - 1, detail | 0))];
  const cav = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const ax = sum[i * 3] / cnt[i] - P[i * 3], ay = sum[i * 3 + 1] / cnt[i] - P[i * 3 + 1], az = sum[i * 3 + 2] / cnt[i] - P[i * 3 + 2];
    cav[i] = (ax * N[i * 3] + ay * N[i * 3 + 1] + az * N[i * 3 + 2]) / (edge * edge) * 4;
  }
  const col = new Float32Array(nv * 3);
  const hueN = makeNoise3(seed * 13 + 3);
  const warm = 0.06 * tone;
  for (let i = 0; i < nv; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const c = Math.max(-1, Math.min(1, cav[i]));
    let ao = 1 - Math.max(0, c) * 0.55 + Math.max(0, -c) * 0.12;   // concave darker, ridges a bit brighter
    ao *= 1 - crat[i] * 0.28;                                         // crater floors darker
    ao += rimF[i] * 0.07;                                             // fresh rims slightly brighter
    const rad = Math.hypot(x, y, z);
    ao *= 0.78 + 0.22 * Math.min(1, Math.max(0, (rad - 0.55) / 0.45)); // low areas darker
    const v = fbm3(hueN, x * 1.6, y * 1.6, z * 1.6, 3);               // large tonal patches
    const s = fbm3(hueN, x * 6 + 9, y * 6, z * 6, 2);                 // small speckle
    const lum = Math.max(0.2, Math.min(1, ao * (0.86 + v * 0.35 * tone + s * 0.12 * tone)));
    col[i * 3] = Math.min(1, lum * (1 + v * warm));
    col[i * 3 + 1] = lum;
    col[i * 3 + 2] = Math.min(1, lum * (1 - v * warm));
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = 1;
  geo.boundingSphere.center.set(0, 0, 0);
  geo.userData.shared = true;
  geoCache.set(key, geo);
  return geo;
}

// ---------------------------------------------------------------- materials
const KIND = {
  rock: { color: '#7f7a74', roughness: 0.93, metalness: 0.0, bump: 0.07, mottle: 0.4, tone: 1 },
  dark: { color: '#4d4844', roughness: 0.96, metalness: 0.0, bump: 0.07, mottle: 0.35, tone: 0.8 },
  iron: { color: '#8f8a84', roughness: 0.46, metalness: 0.85, bump: 0.035, mottle: 0.35, tone: 1.2 },
  ice:  { color: '#a7c4d8', roughness: 0.34, metalness: 0.0, bump: 0.018, mottle: 0.12, tone: 0.5 },
};
const matCache = new Map();
const tumbleTime = { value: 0 };

const ROCK_PARS_V = /* glsl */`
varying vec3 vRockP;
varying float vRockS;
#ifdef ROCK_TUMBLE
  attribute vec4 aSpin;
  uniform float uTumbleT;
  vec3 sw_rotAxis(vec3 v, vec3 ax, float a){ float c = cos(a), s = sin(a); return v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c); }
#endif
`;
const ROCK_PARS_F = /* glsl */`
varying vec3 vRockP;
varying float vRockS;
uniform float uBump, uMottle;
${GLSL_NOISE}
vec3 sw_perturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir){
  vec3 sx = dFdx(surf_pos); vec3 sy = dFdy(surf_pos);
  vec3 R1 = cross(sy, surf_norm); vec3 R2 = cross(surf_norm, sx);
  float det = dot(sx, R1) * faceDir;
  vec3 g = sign(det) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(det) * surf_norm - g);
}
// band-limited detail height (octaves fade out when sub-pixel)
const mat3 SW_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
// gradient noise (no axis-aligned value-noise artefacts), ~[-0.5, 0.5]
float sw_gnoise(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  #define SW_G(o) dot(sw_hash33(i + o) * 2.0 - 1.0, f - o)
  float n = mix(mix(mix(SW_G(vec3(0,0,0)), SW_G(vec3(1,0,0)), u.x), mix(SW_G(vec3(0,1,0)), SW_G(vec3(1,1,0)), u.x), u.y),
                mix(mix(SW_G(vec3(0,0,1)), SW_G(vec3(1,0,1)), u.x), mix(SW_G(vec3(0,1,1)), SW_G(vec3(1,1,1)), u.x), u.y), u.z);
  #undef SW_G
  return n;
}
// procedural small craters: sphere stamps around jittered 3D cell points (2x2x2 nearest cells)
float sw_crater(vec3 p, float density){
  vec3 c = floor(p), f = fract(p);
  float h = 0.0;
  for (int k = 0; k < 8; k++){
    vec3 cc = c + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1)) - step(f, vec3(0.5));
    vec3 rnd = sw_hash33(cc + 17.0);
    if (rnd.x > density) continue;
    vec3 cp = cc + 0.2 + 0.6 * sw_hash33(cc + 3.1);
    float rad = 0.2 + 0.32 * rnd.y;
    float d = length(p - cp) / rad;
    if (d < 1.6) {
      float bowl = d < 1.0 ? (d * d - 1.0) : 0.0;
      float rim = exp(-(d - 1.0) * (d - 1.0) * 12.0) * 0.4;
      h += (bowl * 0.8 + rim) * rad;
    }
  }
  return h;
}
// band-limited detail height (features fade out when sub-pixel)
float sw_rockHeight(vec3 p, float fw){
  float h = 0.0;
  float w1 = clamp(1.5 - fw * 2.6 * 2.0, 0.0, 1.0);
  float w2 = clamp(1.5 - fw * 6.5 * 2.0, 0.0, 1.0);
  h += 0.9 * w1 * sw_crater(p * 2.6, 0.5);
  h += 0.45 * w2 * sw_crater(p * 6.5 + 11.0, 0.55);
  float a = 0.16, f = 4.5;
  vec3 q = p * f;
  for (int i = 0; i < 4; i++){
    float w = clamp(1.6 - fw * f * 2.2, 0.0, 1.0);
    h += a * w * sw_gnoise(q);
    q = SW_ROT * q * 2.13 + 3.7; f *= 2.13; a *= 0.47;
  }
  return h;
}
`;

function patchRock(mat, kind, tumble) {
  const cfg = KIND[kind];
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBump = { value: cfg.bump };
    shader.uniforms.uMottle = { value: cfg.mottle };
    if (tumble) shader.uniforms.uTumbleT = tumbleTime;
    if (tumble) shader.defines = Object.assign(shader.defines || {}, { ROCK_TUMBLE: '' });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + ROCK_PARS_V)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
#ifdef ROCK_TUMBLE
  float sw_ang = aSpin.w * uTumbleT;
  objectNormal = sw_rotAxis(objectNormal, aSpin.xyz, sw_ang);
#endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vRockP = position;
vRockS = length(modelMatrix[0].xyz);
#ifdef USE_INSTANCING
  vRockS *= length(instanceMatrix[0].xyz);
#endif
#ifdef ROCK_TUMBLE
  transformed = sw_rotAxis(transformed, aSpin.xyz, sw_ang);
#endif`);
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + ROCK_PARS_F);
    fs = fs.replace('#include <color_fragment>', `#include <color_fragment>
float sw_fw = length(fwidth(vRockP));
float sw_m = sw_fbm(vRockP * 3.1 + 4.0, 3);
float sw_s = sw_vnoise(vRockP * 23.0);
diffuseColor.rgb *= 1.0 + uMottle * ((sw_m - 0.5) * 1.6 + (sw_s - 0.5) * 0.5 * clamp(1.5 - sw_fw * 30.0, 0.0, 1.0));
${kind === 'iron' ? 'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 0.78, 0.55), smoothstep(0.5, 0.75, sw_m) * 0.6);' : ''}
${kind === 'ice' ? 'float sw_crack = pow(max(0.0, 1.0 - abs(sw_fbm(vRockP * 2.3 + 7.0, 4) * 2.0 - 1.0)), 24.0);\ndiffuseColor.rgb *= 1.0 - sw_crack * 0.25;' : ''}`);
    fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * (0.85 + 0.35 * sw_m), 0.04, 1.0);`);
    fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
${kind === 'iron' ? 'metalnessFactor *= 1.0 - smoothstep(0.5, 0.75, sw_m) * 0.7;' : ''}`);
    fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // 3-tap forward differences in object space: smooth per pixel (no 2x2 quad blockiness)
  vec3 sw_dx = dFdx(vRockP), sw_dy = dFdy(vRockP);
  float sw_k = uBump * vRockS;
  float sw_h0 = sw_rockHeight(vRockP, sw_fw);
  float sw_hx = sw_rockHeight(vRockP + sw_dx, sw_fw);
  float sw_hy = sw_rockHeight(vRockP + sw_dy, sw_fw);
  vec2 sw_dh = vec2(sw_hx - sw_h0, sw_hy - sw_h0);
  sw_dh = clamp(sw_dh, -0.08, 0.08);   // suppress spikes where a pixel quad straddles a triangle edge
  normal = sw_perturb(-vViewPosition, normal, sw_dh * sw_k, faceDirection);
}`);
    if (kind === 'ice') {
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float sw_nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  // fake translucency: faint cold glow in cracks and toward the rim
  totalEmissiveRadiance += vec3(0.06, 0.20, 0.36) * (0.12 + sw_crack * 0.25 + pow(1.0 - sw_nv, 3.0) * 0.25) * (0.4 + 0.6 * vColor.g);
}`);
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `sw-rock-${kind}-${tumble ? 't' : 's'}`;
}

function makeRockMat(kind, tumble) {
  const cfg = KIND[kind] || KIND.rock;
  let mat;
  if (kind === 'ice') {
    mat = new THREE.MeshPhysicalMaterial({
      color: cfg.color, roughness: cfg.roughness, metalness: 0, vertexColors: true,
      clearcoat: 0.8, clearcoatRoughness: 0.32, ior: 1.31, specularIntensity: 1, envMapIntensity: 1.4,
    });
  } else {
    mat = new THREE.MeshStandardMaterial({ color: cfg.color, roughness: cfg.roughness, metalness: cfg.metalness, vertexColors: true, envMapIntensity: kind === 'iron' ? 1.5 : 1 });
  }
  patchRock(mat, KIND[kind] ? kind : 'rock', tumble);
  mat.userData.shared = true;
  return mat;
}

/** Shared cached rock material: 'rock' | 'ice' | 'iron' | 'dark'. */
export function rockMaterial(kind = 'rock') {
  const k = KIND[kind] ? kind : 'rock';
  if (!matCache.has(k)) matCache.set(k, makeRockMat(k, false));
  return matCache.get(k);
}
function tumbleMaterial(kind) {
  const k = (KIND[kind] ? kind : 'rock') + ':t';
  if (!matCache.has(k)) matCache.set(k, makeRockMat(k.slice(0, -2), true));
  return matCache.get(k);
}

// per-kind shape presets
const SHAPE = {
  rock: (r) => ({ roughness: 0.32 + r() * 0.12, craters: true, facets: 1 + Math.floor(r() * 3), stretch: [1 + r() * 0.5, 0.75 + r() * 0.25, 0.85 + r() * 0.3] }),
  dark: (r) => ({ roughness: 0.38 + r() * 0.12, craters: true, facets: Math.floor(r() * 3), stretch: [1 + r() * 0.6, 0.7 + r() * 0.25, 0.9 + r() * 0.2], tone: 0.8 }),
  iron: (r) => ({ roughness: 0.22 + r() * 0.1, craters: r() < 0.5, facets: 2 + Math.floor(r() * 3), stretch: [1 + r() * 0.4, 0.8 + r() * 0.2, 0.85 + r() * 0.2], tone: 1.2 }),
  ice:  (r) => ({ roughness: 0.28 + r() * 0.12, craters: false, facets: 4 + Math.floor(r() * 4), stretch: [1 + r() * 0.5, 0.8 + r() * 0.3, 0.8 + r() * 0.25], tone: 0.5 }),
};
const variantCache = new Map();
function variants(kind, n, detail, seedBase = 1) {
  const k = `${kind}|${n}|${detail}|${seedBase}`;
  if (variantCache.has(k)) return variantCache.get(k);
  const shape = SHAPE[kind] || SHAPE.rock;
  const list = [];
  for (let i = 0; i < n; i++) {
    const seed = seedBase * 101 + i * 17 + (kind.charCodeAt(0) * 7);
    const r = rng(seed);
    const o = shape(r);
    const q = (v) => Math.round(v * 100) / 100;
    list.push(makeRockGeometry(seed, { detail, roughness: q(o.roughness), stretch: o.stretch.map(q), craters: o.craters, facets: o.facets, tone: o.tone ?? 1 }));
  }
  variantCache.set(k, list);
  return list;
}

/** n cached near-detail (detail 4, ~1.6k tris) geometries with different seeds. */
export function rockVariants(kind = 'rock', n = 6) { return variants(kind, n, 4); }
/** Internal/extra: lower-detail variants for belts and debris. */
export function rockVariantsLOD(kind = 'rock', n = 6, detail = 2) { return variants(kind, n, detail); }

// ---------------------------------------------------------------- belt
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

/**
 * Decorative instanced asteroids (no collision).
 * shape 'ring': torus-like belt around `center` at `radius` (radial spread ±thickness, or from
 *   `inner` to `radius` when inner > 0), vertical spread ±thickness/2.
 * shape 'cloud': ellipsoid of radius × thickness × radius (hollow inside `inner`).
 * Extra options: detail (2), variants (5), spin (rad/s group rotation, default 0), tumble (true),
 * lodSize (18: rocks smaller than this use detail-1 geometry).
 */
export class RockBelt {
  constructor(scene, {
    center = [0, 0, 0], radius = 2500, thickness = 300, count = 600, inner = 0, seed = 1, kind = 'rock',
    sizeRange = [4, 60], avoid = null, shape = 'ring', tilt = [0, 0, 0],
    detail = 2, variants: nVar = 5, spin = 0, tumble = true, lodSize = 18,
  } = {}) {
    this.scene = scene;
    this.spin = spin;
    this.group = new THREE.Group();
    this.group.name = 'RockBelt';
    this.group.position.set(...center);
    this.group.rotation.set(...tilt);
    this.group.updateMatrixWorld(true);
    const r = rng(seed * 977 + 3);
    // two LOD sets: small rocks (size < lodSize) use one detail level lower
    const hi = variants(kind, nVar, detail, seed);
    const lo = detail > 1 ? variants(kind, nVar, detail - 1, seed) : hi;
    const geos = lo === hi ? hi : hi.concat(lo);
    const mat = tumble ? tumbleMaterial(kind) : rockMaterial(kind);
    const per = geos.map(() => []);
    const world = new THREE.Vector3();
    const gauss = () => (r() + r() + r() - 1.5) / 1.5;
    const [smin, smax] = sizeRange;
    for (let i = 0; i < count; i++) {
      let ok = false, size = 0;
      for (let attempt = 0; attempt < 12 && !ok; attempt++) {
        size = smin * Math.pow(smax / smin, Math.pow(r(), 2.6));
        if (shape === 'cloud') {
          let x, y, z, l;
          do { x = r() * 2 - 1; y = r() * 2 - 1; z = r() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1);
          const rr = Math.sqrt(l);
          if (inner > 0 && rr * radius < inner) continue;
          _p.set(x * radius, y * thickness, z * radius);
        } else {
          const a = r() * Math.PI * 2;
          const rad = inner > 0 ? inner + (radius - inner) * Math.sqrt(r()) : radius + gauss() * thickness;
          _p.set(Math.cos(a) * rad, gauss() * thickness * 0.5, Math.sin(a) * rad);
        }
        world.copy(_p).applyMatrix4(this.group.matrixWorld);
        ok = !avoid || !avoid(world, size);
      }
      if (!ok) continue;
      const v = Math.floor(r() * nVar) + (lo !== hi && size < lodSize ? nVar : 0);
      per[v].push({ x: _p.x, y: _p.y, z: _p.z, s: size, rx: r() * 6.28, ry: r() * 6.28, rz: r() * 6.28, sy: 0.8 + r() * 0.4, ax: r(), ay: r(), az: r(), w: (0.04 + r() * 0.3) * Math.pow(10 / Math.max(size, 10), 0.6) * (r() < 0.5 ? -1 : 1) });
    }
    this.meshes = [];
    this.triangles = 0;
    geos.forEach((g, gi) => {
      const list = per[gi];
      if (!list.length) return;
      let geo = g;
      if (tumble) {
        // per-instance spin axis + rate, consumed in the vertex shader (no CPU work per frame)
        geo = new THREE.InstancedBufferGeometry();
        geo.index = g.index;
        for (const name of ['position', 'normal', 'color']) geo.setAttribute(name, g.attributes[name]);
        geo.boundingSphere = g.boundingSphere.clone();
        const spinArr = new Float32Array(list.length * 4);
        list.forEach((o, i) => {
          _p.set(o.ax - 0.5, o.ay - 0.5, o.az - 0.5).normalize();
          if (!Number.isFinite(_p.x)) _p.set(0, 1, 0);
          spinArr.set([_p.x, _p.y, _p.z, o.w], i * 4);
        });
        geo.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spinArr, 4));
        geo.userData.owned = true;
      }
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((o, i) => {
        _e.set(o.rx, o.ry, o.rz);
        _q.setFromEuler(_e);
        _s.set(o.s, o.s * o.sy, o.s);
        _p.set(o.x, o.y, o.z);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.triangles += (g.index.count / 3) * list.length;
      this.meshes.push(mesh);
      this.group.add(mesh);
    });
    this.count = this.meshes.reduce((a, m) => a + m.count, 0);
    scene.add(this.group);
  }

  update(dt) {
    // shared tumble clock: several belts may call update each frame; take the furthest one
    this._t = (this._t || 0) + dt;
    if (this._t > tumbleTime.value) tumbleTime.value = this._t;
    if (this.spin) { this.group.rotation.y += this.spin * dt; }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const m of this.meshes) {
      if (m.geometry.userData.owned) m.geometry.dispose();
      m.dispose();
    }
    this.meshes.length = 0;
  }
}
