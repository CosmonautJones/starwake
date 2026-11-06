// Shared helpers for the space visuals: seeded RNG, CPU gradient noise, GLSL noise snippets.
// No dependencies other than three (only for the colour helper).

import * as THREE from 'three';

/** Deterministic PRNG (mulberry32). Returns a function -> [0,1). */
export function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Seeded 3D Perlin gradient noise. Returns f(x,y,z) in ~[-1,1]. */
export function makeNoise3(seed) {
  const r = rng(seed);
  const p = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; const t = base[i]; base[i] = base[j]; base[j] = t; }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  const G = [1,1,0, -1,1,0, 1,-1,0, -1,-1,0, 1,0,1, -1,0,1, 1,0,-1, -1,0,-1, 0,1,1, 0,-1,1, 0,1,-1, 0,-1,-1];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y, z) => { const g = (h % 12) * 3; return G[g] * x + G[g + 1] * y + G[g + 2] * z; };
  return function (x, y, z) {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[xi] + yi, AA = p[A] + zi, AB = p[A + 1] + zi;
    const B = p[xi + 1] + yi, BA = p[B] + zi, BB = p[B + 1] + zi;
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u), l(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
      l(l(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u), l(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w) * 1.1;
  };
}

export function fbm3(noise, x, y, z, octaves = 4, lac = 2.03, gain = 0.5) {
  let a = 1, s = 0, n = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * noise(x, y, z); n += a;
    x = x * lac + 17.3; y = y * lac - 9.1; z = z * lac + 4.7; a *= gain;
  }
  return s / n;
}

export function ridged3(noise, x, y, z, octaves = 3) {
  let a = 1, s = 0, n = 0;
  for (let i = 0; i < octaves; i++) {
    const v = 1 - Math.abs(noise(x, y, z));
    s += a * v * v; n += a;
    x = x * 2.1 + 3.3; y = y * 2.1 + 1.7; z = z * 2.1 - 5.2; a *= 0.5;
  }
  return s / n;
}

export const linColor = (hex) => new THREE.Color(hex);

/** GLSL: cheap hash + value noise + fbm (no sin-hash, stable on mobile). */
export const GLSL_NOISE = /* glsl */`
float sw_hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 sw_hash33(vec3 p3){ p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float sw_vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = sw_hash13(i), b = sw_hash13(i + vec3(1,0,0)), c = sw_hash13(i + vec3(0,1,0)), d = sw_hash13(i + vec3(1,1,0));
  float e = sw_hash13(i + vec3(0,0,1)), f1 = sw_hash13(i + vec3(1,0,1)), g = sw_hash13(i + vec3(0,1,1)), h = sw_hash13(i + vec3(1,1,1));
  return mix(mix(mix(a,b,u.x), mix(c,d,u.x), u.y), mix(mix(e,f1,u.x), mix(g,h,u.x), u.y), u.z);
}
float sw_fbm(vec3 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++){ if (i >= oct) break; s += a * sw_vnoise(p); p = p * 2.02 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
`;
