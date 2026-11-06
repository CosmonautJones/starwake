// Pooled space effects: breakable-object shatter (instanced chunks + dust + flash),
// explosions (flash, fireball, shockwave ring, sparks, lingering smoke, optional light),
// and camera-relative speed dust. Everything is preallocated; update() does no allocation.

import * as THREE from 'three';
import { rng, makeNoise3, fbm3 } from './util.js';
import { makeRockGeometry, rockMaterial } from './rocks.js';

// ---------------------------------------------------------------- puff atlas (2x2 noisy blobs)
let puffTex = null;
export function getPuffTex() {
  if (puffTex) return puffTex;
  const S = 128, W = S * 2;
  const data = new Uint8Array(W * W * 4);
  const noise = makeNoise3(4242);
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * S, oy = Math.floor(t / 2) * S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      const n = fbm3(noise, u * 2.2 + t * 7.1, v * 2.2 - t * 3.3, t * 1.7, 5) * 0.5 + 0.5;
      const n2 = fbm3(noise, u * 5 + 11, v * 5 + t, 3.3 + t, 3) * 0.5 + 0.5;
      let a = Math.max(0, 1 - r * (1.05 + 0.6 * (n - 0.5)));
      a = Math.pow(a, 1.3) * (0.55 + 0.6 * n + 0.25 * (n2 - 0.5));
      a = Math.max(0, Math.min(1, a * 1.25)) * Math.min(1, Math.max(0, (0.98 - r) / 0.25));   // hard zero before the tile edge
      const i = ((oy + y) * W + ox + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(a * 255); data[i + 3] = 255;
    }
  }
  puffTex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  puffTex.magFilter = THREE.LinearFilter;
  puffTex.minFilter = THREE.LinearMipmapLinearFilter;
  puffTex.generateMipmaps = true;
  puffTex.needsUpdate = true;
  return puffTex;
}

// ---------------------------------------------------------------- billboard pool
export const SHAPE = { SMOKE: 0, GLOW: 1, RING: 2, SPARK: 3, FIRE: 4 };
const BB_VS = /* glsl */`
attribute vec3 aPos; attribute vec3 aVel; attribute vec4 aP; attribute vec4 aCol;
varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vVar;
void main(){
  vUv = uv; vCol = aCol; vShape = aP.w; vVar = aP.z;
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  vec2 q = position.xy;
  float size = aP.x;
  if (aP.w > 2.5 && aP.w < 3.5) {
    vec3 vv = (viewMatrix * vec4(aVel, 0.0)).xyz;
    float L = length(vv.xy);
    vec2 dir = L > 1e-5 ? vv.xy / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float len = max(L, size * 2.0);
    mv.xy += dir * (q.x - 0.5) * len + nrm * q.y * size;
  } else {
    float c = cos(aP.y), s = sin(aP.y);
    mv.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y) * size;
  }
  // fade billboards that would swallow the camera
  vCol.a *= clamp((-mv.z - 0.5) / max(size * 0.5, 0.5), 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const BB_FS = /* glsl */`
uniform sampler2D uTex;
varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vVar;
void main(){
  vec2 c = vUv * 2.0 - 1.0; float r2 = dot(c, c);
  float a; vec3 col = vCol.rgb;
  if (vShape < 0.5 || vShape > 3.5) {
    vec2 tuv = (vUv + vec2(mod(vVar, 2.0), floor(vVar / 2.0))) * 0.5;
    float t = texture2D(uTex, tuv).r;
    a = t;
    if (vShape > 3.5) col *= 0.35 + 1.9 * t * t;
  } else if (vShape < 1.5) {
    a = max(exp(-r2 * 6.0) - 0.0025, 0.0) + exp(-r2 * 30.0) * 0.6;
  } else if (vShape < 2.5) {
    float r = sqrt(r2);
    a = (exp(-pow((r - 0.9) / 0.022, 2.0)) * 0.8 + exp(-pow((r - 0.84) / 0.09, 2.0)) * 0.12) * step(r, 1.0);
  } else {
    a = exp(-c.y * c.y * 7.0) * smoothstep(0.0, 0.7, vUv.x) * (0.4 + 0.6 * vUv.x);
  }
  a *= vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}`;

// per-particle fields (struct of arrays)
const F1 = ['life', 'maxLife', 'drag', 's0', 's1', 'rot', 'rotV', 'a0', 'shape', 'variant', 'streak', 'fadeIn', 'fadePow', 'ease', 'colPow', 'delay'];
const F3 = ['p', 'v', 'c0', 'c1'];

/** Pooled camera-facing billboards (one draw call). Exported for js/space/debris.js + speedfx.js. */
export class BillboardPool {
  constructor(scene, max, blending, renderOrder = 20) {
    this.scene = scene; this.max = max; this.n = 0; this._rr = 0;
    for (const f of F1) this[f] = new Float32Array(max);
    for (const f of F3) this[f] = new Float32Array(max * 3);
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    const mk = (n) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(3); this.aVel = mk(3); this.aP = mk(4); this.aCol = mk(4);
    geo.setAttribute('aPos', this.aPos); geo.setAttribute('aVel', this.aVel); geo.setAttribute('aP', this.aP); geo.setAttribute('aCol', this.aCol);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: getPuffTex() } }, vertexShader: BB_VS, fragmentShader: BB_FS,
      transparent: true, depthWrite: false, blending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    scene.add(this.mesh);
  }
  /** o: reusable spec object (see SPEC). */
  spawn(o) {
    let i;
    if (this.n < this.max) i = this.n++;
    else { i = this._rr; this._rr = (this._rr + 1) % this.max; }
    this.life[i] = -o.delay; this.maxLife[i] = o.life; this.drag[i] = o.drag; this.s0[i] = o.s0; this.s1[i] = o.s1;
    this.rot[i] = o.rot; this.rotV[i] = o.rotV; this.a0[i] = o.alpha; this.shape[i] = o.shape; this.variant[i] = o.variant;
    this.streak[i] = o.streak; this.fadeIn[i] = o.fadeIn; this.fadePow[i] = o.fadePow; this.ease[i] = o.ease; this.colPow[i] = o.colPow; this.delay[i] = o.delay;
    this.p[i * 3] = o.px; this.p[i * 3 + 1] = o.py; this.p[i * 3 + 2] = o.pz;
    this.v[i * 3] = o.vx; this.v[i * 3 + 1] = o.vy; this.v[i * 3 + 2] = o.vz;
    this.c0[i * 3] = o.r0; this.c0[i * 3 + 1] = o.g0; this.c0[i * 3 + 2] = o.b0;
    this.c1[i * 3] = o.r1; this.c1[i * 3 + 1] = o.g1; this.c1[i * 3 + 2] = o.b1;
  }
  _move(d, s) {
    for (let j = 0; j < F1.length; j++) { const a = this[F1[j]]; a[d] = a[s]; }
    for (let j = 0; j < F3.length; j++) { const a = this[F3[j]]; a[d * 3] = a[s * 3]; a[d * 3 + 1] = a[s * 3 + 1]; a[d * 3 + 2] = a[s * 3 + 2]; }
  }
  update(dt) {
    const P = this.aPos.array, V = this.aVel.array, A = this.aP.array, C = this.aCol.array;
    let i = 0;
    while (i < this.n) {
      this.life[i] += dt;
      const life = this.life[i];
      if (life >= this.maxLife[i]) { this.n--; if (i !== this.n) this._move(i, this.n); continue; }
      const i3 = i * 3, i4 = i * 4;
      if (life < 0) { A[i4] = 0; C[i4 + 3] = 0; i++; continue; }   // delayed
      const t = life / this.maxLife[i];
      const k = Math.exp(-this.drag[i] * dt);
      const v = this.v, p = this.p;
      v[i3] *= k; v[i3 + 1] *= k; v[i3 + 2] *= k;
      p[i3] += v[i3] * dt; p[i3 + 1] += v[i3 + 1] * dt; p[i3 + 2] += v[i3 + 2] * dt;
      this.rot[i] += this.rotV[i] * dt;
      const e = 1 - Math.pow(1 - t, this.ease[i]);
      const ct = Math.pow(t, this.colPow[i]);
      const fi = this.fadeIn[i] > 0 ? Math.min(1, t / this.fadeIn[i]) : 1;
      const alpha = this.a0[i] * fi * Math.pow(1 - t, this.fadePow[i]);
      P[i3] = p[i3]; P[i3 + 1] = p[i3 + 1]; P[i3 + 2] = p[i3 + 2];
      const st = this.streak[i];
      V[i3] = v[i3] * st; V[i3 + 1] = v[i3 + 1] * st; V[i3 + 2] = v[i3 + 2] * st;
      A[i4] = this.s0[i] + (this.s1[i] - this.s0[i]) * e; A[i4 + 1] = this.rot[i]; A[i4 + 2] = this.variant[i]; A[i4 + 3] = this.shape[i];
      const c0 = this.c0, c1 = this.c1;
      C[i4] = c0[i3] + (c1[i3] - c0[i3]) * ct; C[i4 + 1] = c0[i3 + 1] + (c1[i3 + 1] - c0[i3 + 1]) * ct; C[i4 + 2] = c0[i3 + 2] + (c1[i3 + 2] - c0[i3 + 2]) * ct;
      C[i4 + 3] = alpha;
      i++;
    }
    this.geo.instanceCount = this.n;
    if (this.n) { this.aPos.needsUpdate = true; this.aVel.needsUpdate = true; this.aP.needsUpdate = true; this.aCol.needsUpdate = true; }
    this.mesh.visible = this.n > 0;
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; }
  dispose() { this.scene.remove(this.mesh); this.geo.dispose(); this.mat.dispose(); }
}

// reusable spawn spec (avoids per-particle object allocation)
export function makeSpec() {
  return { shape: 1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, life: 1, drag: 0, s0: 1, s1: 1, rot: 0, rotV: 0, alpha: 1, variant: 0, streak: 0, fadeIn: 0, fadePow: 1, ease: 2, colPow: 1, delay: 0, r0: 1, g0: 1, b0: 1, r1: 1, g1: 1, b1: 1 };
}
export function resetSpec(o) {
  o.vx = o.vy = o.vz = 0; o.drag = 0; o.rot = 0; o.rotV = 0; o.alpha = 1; o.variant = 0; o.streak = 0; o.fadeIn = 0; o.fadePow = 1; o.ease = 2; o.colPow = 1; o.delay = 0;
  return o;
}
const _dir = new THREE.Vector3();
function randUnit(r, out) {
  const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
}
function setCol(o, c0, k0, c1, k1) { o.r0 = c0.r * k0; o.g0 = c0.g * k0; o.b0 = c0.b * k0; o.r1 = c1.r * k1; o.g1 = c1.g * k1; o.b1 = c1.b * k1; }

// ---------------------------------------------------------------- shatter chunks
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _c = new THREE.Color();

let chunkKinds = null;
function facetted(g) { const f = g.index ? g.toNonIndexed() : g.clone(); f.computeVertexNormals(); f.computeBoundingSphere(); return f; }
function getChunkKinds() {
  if (chunkKinds) return chunkKinds;
  // metal plate: bent, thin
  const plate = new THREE.BoxGeometry(1, 0.12, 0.75, 4, 1, 2);
  const P = plate.attributes.position;
  for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i); P.setY(i, P.getY(i) + x * x * 0.35 - z * 0.12); }
  plate.computeVertexNormals();
  const metalMat = new THREE.MeshStandardMaterial({ color: '#9aa1aa', metalness: 0.75, roughness: 0.42 });
  // crystal shard: elongated octahedron, faceted
  const shard = new THREE.OctahedronGeometry(1, 0);
  shard.scale(0.42, 1.25, 0.42);
  shard.computeVertexNormals();
  const crystalMatl = new THREE.MeshPhysicalMaterial({ color: '#203040', emissive: '#ffffff', emissiveIntensity: 1.2, roughness: 0.1, metalness: 0, clearcoat: 1, flatShading: true });
  crystalMatl.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#if defined( USE_COLOR )
  totalEmissiveRadiance *= vColor.rgb;
#endif
{ float nv = clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0); totalEmissiveRadiance *= 0.35 + 1.6 * pow(1.0 - nv, 2.0); }`);
  };
  crystalMatl.customProgramCacheKey = () => 'sw-shard';
  chunkKinds = {
    rock: { geo: makeRockGeometry(901, { detail: 1, roughness: 0.6, facets: 7, craters: false, stretch: [1.3, 0.75, 1] }), mat: rockMaterial('rock') },
    ice: { geo: facetted(makeRockGeometry(902, { detail: 1, roughness: 0.5, facets: 7, craters: false, stretch: [1.4, 0.65, 0.9] })), mat: rockMaterial('ice') },
    metal: { geo: plate, mat: metalMat },
    crystal: { geo: shard, mat: crystalMatl },
  };
  return chunkKinds;
}

class ChunkPool {
  constructor(scene, kind, max) {
    const k = getChunkKinds()[kind];
    this.kind = kind; this.max = max; this.n = 0; this._rr = 0;
    this.mesh = new THREE.InstancedMesh(k.geo, k.mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.q = new Float32Array(max * 4);
    this.ax = new Float32Array(max * 3); this.w = new Float32Array(max); this.sc = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
  }
  spawn(px, py, pz, vx, vy, vz, sx, sy, sz, r, g, b, life, r01) {
    let i;
    if (this.n < this.max) i = this.n++; else { i = this._rr; this._rr = (this._rr + 1) % this.max; }
    const i3 = i * 3;
    this.p[i3] = px; this.p[i3 + 1] = py; this.p[i3 + 2] = pz;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.sc[i3] = sx; this.sc[i3 + 1] = sy; this.sc[i3 + 2] = sz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    randUnit(r01, _ax);
    this.ax[i3] = _ax.x; this.ax[i3 + 1] = _ax.y; this.ax[i3 + 2] = _ax.z;
    this.w[i] = (1 + r01() * 5) * (r01() < 0.5 ? -1 : 1);
    randUnit(r01, _ax); _q.setFromAxisAngle(_ax, r01() * 6.28);
    this.q[i * 4] = _q.x; this.q[i * 4 + 1] = _q.y; this.q[i * 4 + 2] = _q.z; this.q[i * 4 + 3] = _q.w;
    this.life[i] = 0; this.maxLife[i] = life;
  }
  _move(d, s) {
    if (!this._a3) this._a3 = [this.p, this.v, this.ax, this.sc, this.col];
    for (let j = 0; j < 5; j++) { const a = this._a3[j]; a[d * 3] = a[s * 3]; a[d * 3 + 1] = a[s * 3 + 1]; a[d * 3 + 2] = a[s * 3 + 2]; }
    for (let k = 0; k < 4; k++) this.q[d * 4 + k] = this.q[s * 4 + k];
    this.w[d] = this.w[s]; this.life[d] = this.life[s]; this.maxLife[d] = this.maxLife[s];
  }
  update(dt) {
    let i = 0;
    const glow = this.kind === 'crystal';
    const ic = this.mesh.instanceColor.array;
    const drag = Math.exp(-0.25 * dt);
    while (i < this.n) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) { this.n--; if (i !== this.n) this._move(i, this.n); continue; }
      const i3 = i * 3, i4 = i * 4;
      const t = this.life[i] / this.maxLife[i];
      this.v[i3] *= drag; this.v[i3 + 1] *= drag; this.v[i3 + 2] *= drag;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      _q.set(this.q[i4], this.q[i4 + 1], this.q[i4 + 2], this.q[i4 + 3]);
      _ax.set(this.ax[i3], this.ax[i3 + 1], this.ax[i3 + 2]);
      _q2.setFromAxisAngle(_ax, this.w[i] * dt);
      _q.multiply(_q2);
      this.q[i4] = _q.x; this.q[i4 + 1] = _q.y; this.q[i4 + 2] = _q.z; this.q[i4 + 3] = _q.w;
      const f = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const ff = f * f * (3 - 2 * f);
      _s.set(this.sc[i3] * ff, this.sc[i3 + 1] * ff, this.sc[i3 + 2] * ff);
      _p.set(this.p[i3], this.p[i3 + 1], this.p[i3 + 2]);
      _m4.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m4);
      const g = glow ? Math.max(0.15, 1 - t * 0.9) : 1;
      ic[i3] = this.col[i3] * g; ic[i3 + 1] = this.col[i3 + 1] * g; ic[i3 + 2] = this.col[i3 + 2] * g;
      i++;
    }
    this.mesh.count = this.n;
    if (this.n) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; }
    this.mesh.visible = this.n > 0;
  }
  dispose(scene) { scene.remove(this.mesh); this.mesh.dispose(); }
}

const DUST_TINT = { rock: new THREE.Color(0.30, 0.27, 0.24), ice: new THREE.Color(0.38, 0.46, 0.55), metal: new THREE.Color(0.2, 0.2, 0.21), crystal: new THREE.Color(0.22, 0.22, 0.28) };
const C_WHITE = new THREE.Color(1, 1, 1);
const C_SPARK0 = new THREE.Color(1.0, 0.62, 0.28);
const C_SPARK1 = new THREE.Color(1.0, 0.25, 0.05);

export class Shatter {
  constructor(scene, { max = 500 } = {}) {
    this.scene = scene;
    this.pools = {};
    for (const k of ['rock', 'ice', 'metal', 'crystal']) this.pools[k] = new ChunkPool(scene, k, max);
    this.max = max;
    this.alpha = new BillboardPool(scene, 160, THREE.NormalBlending, 18);
    this.add = new BillboardPool(scene, 260, THREE.AdditiveBlending, 22);
    this._spec = makeSpec();
    this._r = rng(1234);
  }

  burst({ position, radius = 4, velocity = null, kind = 'rock', color = null, count = null }) {
    const r = this._r, o = this._spec;
    const k = this.pools[kind] ? kind : 'rock';
    const pool = this.pools[k];
    const vx0 = velocity ? velocity.x : 0, vy0 = velocity ? velocity.y : 0, vz0 = velocity ? velocity.z : 0;
    const R = Math.max(0.3, radius);
    const tint = color ? _c.set(color) : null;
    const n = Math.min(this.max, count ?? Math.round(Math.min(48, Math.max(10, 12 + R * 1.5)) * (k === 'crystal' ? 1.2 : k === 'metal' ? 0.8 : 1)));
    const speedK = 6 + Math.sqrt(R) * 5;
    for (let i = 0; i < n; i++) {
      randUnit(r, _dir);
      const off = R * (0.2 + 0.5 * r());
      const sp = speedK * (0.4 + r() * 1.1);
      const big = r() < 0.12;
      const s = R * (big ? 0.22 + r() * 0.14 : 0.04 + Math.pow(r(), 1.8) * 0.15);
      const sx = s * (0.7 + r() * 0.6), sy = s * (0.6 + r() * 0.5), sz = s * (0.7 + r() * 0.6);
      let cr = 1, cg = 1, cb = 1;
      if (tint) { cr = tint.r; cg = tint.g; cb = tint.b; }
      if (k === 'crystal' && !tint) { cr = 0.2; cg = 1.0; cb = 0.9; }
      const shade = k === 'crystal' ? 1 : 0.85 + r() * 0.25;
      pool.spawn(position.x + _dir.x * off, position.y + _dir.y * off, position.z + _dir.z * off,
        vx0 + _dir.x * sp * (big ? 0.5 : 1), vy0 + _dir.y * sp * (big ? 0.5 : 1), vz0 + _dir.z * sp * (big ? 0.5 : 1),
        sx, sy, sz, cr * shade, cg * shade, cb * shade, 1.6 + r() * 1.4 + (big ? 0.6 : 0), r);
    }
    // dust puff (alpha blended, lit-looking tint)
    const dust = DUST_TINT[k];
    const nd = k === 'metal' ? 4 : 7;
    for (let i = 0; i < nd; i++) {
      resetSpec(o);
      randUnit(r, _dir);
      o.shape = 0; o.variant = Math.floor(r() * 4);
      o.px = position.x + _dir.x * R * 0.3; o.py = position.y + _dir.y * R * 0.3; o.pz = position.z + _dir.z * R * 0.3;
      const sp = R * (0.5 + r() * 0.9);
      o.vx = vx0 * 0.7 + _dir.x * sp; o.vy = vy0 * 0.7 + _dir.y * sp; o.vz = vz0 * 0.7 + _dir.z * sp;
      o.drag = 1.2; o.life = 1.8 + r() * 1.4; o.s0 = R * (0.6 + r() * 0.5); o.s1 = R * (1.7 + r() * 1.2);
      o.rot = r() * 6.28; o.rotV = (r() - 0.5) * 0.6; o.alpha = k === 'ice' ? 0.22 : 0.75; o.fadeIn = 0.05; o.fadePow = 1.5; o.ease = 3;
      const sh = 0.8 + r() * 0.4;
      setCol(o, dust, sh, dust, sh * 0.7);
      this.alpha.spawn(o);
    }
    // gravel streaks (rock/ice) or sparks (metal) or glints (crystal/ice)
    const ns = k === 'metal' ? 18 : 10;
    for (let i = 0; i < ns; i++) {
      resetSpec(o);
      randUnit(r, _dir);
      o.shape = 3;
      o.px = position.x; o.py = position.y; o.pz = position.z;
      const sp = speedK * (1.2 + r() * 2.2);
      o.vx = vx0 + _dir.x * sp; o.vy = vy0 + _dir.y * sp; o.vz = vz0 + _dir.z * sp;
      o.drag = 1.4; o.life = 0.5 + r() * 0.7; o.s0 = o.s1 = R * 0.035 + 0.05; o.streak = 0.06; o.fadePow = 1.2;
      if (k === 'metal') { setCol(o, C_SPARK0, 3.2, C_SPARK1, 1.4); this.add.spawn(o); }
      else if (k === 'crystal') { const c = tint || _c.setRGB(0.2, 1, 0.9); setCol(o, c, 3, c, 1); this.add.spawn(o); }
      else if (k === 'ice') { setCol(o, C_WHITE, 1.4, DUST_TINT.ice, 0.8); o.alpha = 0.6; this.add.spawn(o); }
      else { setCol(o, DUST_TINT.rock, 1.1, DUST_TINT.rock, 0.6); o.alpha = 0.8; o.life += 0.5; this.alpha.spawn(o); }
    }
    // small warm impact flash for rock/ice
    if (k === 'rock' || k === 'ice') {
      resetSpec(o);
      o.shape = 1; o.px = position.x; o.py = position.y; o.pz = position.z; o.vx = vx0; o.vy = vy0; o.vz = vz0;
      o.life = 0.18; o.s0 = R * 1.2; o.s1 = R * 2.0; o.fadePow = 2;
      if (k === 'ice') setCol(o, DUST_TINT.ice, 2.2, DUST_TINT.ice, 1); else setCol(o, C_SPARK0, 1.6, C_SPARK1, 0.6);
      this.add.spawn(o);
    }
    // brief flash for crystal / metal
    if (k === 'crystal' || k === 'metal') {
      resetSpec(o);
      o.shape = 1; o.px = position.x; o.py = position.y; o.pz = position.z;
      o.vx = vx0; o.vy = vy0; o.vz = vz0;
      o.life = k === 'crystal' ? 0.45 : 0.22; o.s0 = R * 2.2; o.s1 = R * (k === 'crystal' ? 4.5 : 3.2); o.fadePow = 2; o.ease = 2;
      if (k === 'crystal') { const c = tint || _c.setRGB(0.2, 1, 0.9); setCol(o, c, 3.5, c, 1.5); }
      else setCol(o, C_SPARK0, 4, C_SPARK1, 1);
      this.add.spawn(o);
      if (k === 'crystal') {   // lingering shimmer motes
        for (let i = 0; i < 12; i++) {
          resetSpec(o); randUnit(r, _dir);
          o.shape = 1; o.px = position.x + _dir.x * R * 0.5; o.py = position.y + _dir.y * R * 0.5; o.pz = position.z + _dir.z * R * 0.5;
          const sp = speedK * (0.3 + r() * 0.8);
          o.vx = vx0 + _dir.x * sp; o.vy = vy0 + _dir.y * sp; o.vz = vz0 + _dir.z * sp; o.drag = 0.8;
          o.life = 1.2 + r() * 1.3; o.s0 = o.s1 = R * 0.08 + 0.15; o.fadePow = 1.5;
          const c = tint || _c.setRGB(0.2, 1, 0.9); setCol(o, c, 2.5, c, 1);
          this.add.spawn(o);
        }
      }
    }
  }

  update(dt) {
    for (const k in this.pools) this.pools[k].update(dt);
    this.alpha.update(dt); this.add.update(dt);
  }

  get active() { let n = 0; for (const k in this.pools) n += this.pools[k].n; return n; }

  dispose() {
    for (const k in this.pools) this.pools[k].dispose(this.scene);
    this.alpha.dispose(); this.add.dispose();
  }
}

// ---------------------------------------------------------------- explosions
const C_HOT = new THREE.Color(1.0, 0.86, 0.62);
const C_COOL = new THREE.Color(0.75, 0.85, 1.0);
const C_SMOKE0 = new THREE.Color(0.16, 0.145, 0.135);
const C_SMOKE1 = new THREE.Color(0.06, 0.06, 0.065);
const _ec = new THREE.Color();
const _ec2 = new THREE.Color();

export class Explosions {
  /** Extra option: lights (pooled PointLights for a flash on nearby surfaces; 0 disables). */
  constructor(scene, { max = 24, lights = 1 } = {}) {
    this.scene = scene;
    this.max = max;
    this.add = new BillboardPool(scene, max * 70, THREE.AdditiveBlending, 24);
    this.alpha = new BillboardPool(scene, max * 8, THREE.NormalBlending, 19);
    this._spec = makeSpec();
    this._r = rng(777);
    this.lights = [];
    for (let i = 0; i < lights; i++) {
      const l = new THREE.PointLight(0xffb36b, 0, 100, 2);
      l.userData = { t: 1, life: 0.6, peak: 0 };
      scene.add(l);
      this.lights.push(l);
    }
  }

  spawn({ position, size = 1, color = new THREE.Color('#ffb36b'), velocity = null }) {
    const r = this._r, o = this._spec;
    const s = 8 * size;
    const col = _ec.set(color);
    const vx0 = velocity ? velocity.x : 0, vy0 = velocity ? velocity.y : 0, vz0 = velocity ? velocity.z : 0;
    const P = position;
    // 1) flash
    resetSpec(o);
    o.shape = 1; o.px = P.x; o.py = P.y; o.pz = P.z; o.vx = vx0 * 0.5; o.vy = vy0 * 0.5; o.vz = vz0 * 0.5;
    o.life = 0.22; o.s0 = s * 2.4; o.s1 = s * 3.6; o.fadePow = 2.4; o.ease = 2;
    _ec2.copy(col).lerp(C_WHITE, 0.5);
    setCol(o, _ec2, 4, col, 1.5);
    this.add.spawn(o);
    // 2) fireball puffs
    for (let i = 0; i < 14; i++) {
      resetSpec(o); randUnit(r, _dir);
      o.shape = 4; o.variant = Math.floor(r() * 4);
      const off = s * 0.5 * Math.sqrt(r());
      o.px = P.x + _dir.x * off; o.py = P.y + _dir.y * off; o.pz = P.z + _dir.z * off;
      const sp = s * (0.8 + r() * 2.0);
      o.vx = vx0 * 0.6 + _dir.x * sp; o.vy = vy0 * 0.6 + _dir.y * sp; o.vz = vz0 * 0.6 + _dir.z * sp;
      o.drag = 2.4; o.life = 0.55 + r() * 0.6; o.s0 = s * (0.45 + r() * 0.4); o.s1 = s * (1.3 + r() * 1.0);
      o.rot = r() * 6.28; o.rotV = (r() - 0.5) * 2; o.fadePow = 1.4; o.ease = 3; o.colPow = 0.7; o.delay = r() * 0.06;
      _ec2.copy(col).lerp(C_HOT, 0.5);
      o.r0 = _ec2.r * 2.4; o.g0 = _ec2.g * 1.45; o.b0 = _ec2.b * 0.75;
      o.r1 = col.r * 0.55; o.g1 = col.g * 0.14; o.b1 = col.b * 0.05; o.alpha = 0.85;
      this.add.spawn(o);
    }
    // 3) shockwave ring (thin, camera-facing)
    resetSpec(o);
    o.shape = 2; o.px = P.x; o.py = P.y; o.pz = P.z; o.vx = vx0 * 0.3; o.vy = vy0 * 0.3; o.vz = vz0 * 0.3;
    o.life = 0.55; o.s0 = s * 0.8; o.s1 = s * 5.5; o.ease = 2.6; o.fadePow = 1.6; o.rot = r() * 6.28;
    _ec2.copy(col).lerp(C_COOL, 0.35);
    setCol(o, _ec2, 1.3, col, 0.5);
    this.add.spawn(o);
    // 4) sparks
    for (let i = 0; i < 30; i++) {
      resetSpec(o); randUnit(r, _dir);
      o.shape = 3; o.px = P.x; o.py = P.y; o.pz = P.z;
      const sp = s * (5 + r() * 11);
      o.vx = vx0 + _dir.x * sp; o.vy = vy0 + _dir.y * sp; o.vz = vz0 + _dir.z * sp;
      o.drag = 1.6; o.life = 0.4 + r() * 0.8; o.s0 = o.s1 = s * 0.03 + 0.06; o.streak = 0.035; o.fadePow = 1.1;
      _ec2.copy(col).lerp(C_HOT, 0.4);
      o.r0 = _ec2.r * 2.2; o.g0 = _ec2.g * 1.5; o.b0 = _ec2.b * 0.9; o.r1 = col.r * 1.2; o.g1 = col.g * 0.4; o.b1 = col.b * 0.15;
      this.add.spawn(o);
    }
    // 5) embers drifting
    for (let i = 0; i < 10; i++) {
      resetSpec(o); randUnit(r, _dir);
      o.shape = 1; o.px = P.x; o.py = P.y; o.pz = P.z;
      const sp = s * (1.2 + r() * 2.5);
      o.vx = vx0 * 0.7 + _dir.x * sp; o.vy = vy0 * 0.7 + _dir.y * sp; o.vz = vz0 * 0.7 + _dir.z * sp;
      o.drag = 0.7; o.life = 1.2 + r() * 1.2; o.s0 = o.s1 = s * 0.12; o.fadePow = 1.5;
      setCol(o, col, 2.4, col, 0.6);
      this.add.spawn(o);
    }
    // 6) lingering smoke
    for (let i = 0; i < 6; i++) {
      resetSpec(o); randUnit(r, _dir);
      o.shape = 0; o.variant = Math.floor(r() * 4);
      o.px = P.x + _dir.x * s * 0.3; o.py = P.y + _dir.y * s * 0.3; o.pz = P.z + _dir.z * s * 0.3;
      const sp = s * (0.4 + r() * 0.6);
      o.vx = vx0 * 0.5 + _dir.x * sp; o.vy = vy0 * 0.5 + _dir.y * sp; o.vz = vz0 * 0.5 + _dir.z * sp;
      o.drag = 0.9; o.life = 2.6 + r() * 1.6; o.s0 = s * 1.0; o.s1 = s * (3.0 + r() * 1.5);
      o.rot = r() * 6.28; o.rotV = (r() - 0.5) * 0.4; o.alpha = 0.55; o.fadeIn = 0.12; o.fadePow = 1.3; o.ease = 2.5; o.delay = 0.08;
      setCol(o, C_SMOKE0, 1, C_SMOKE1, 1);
      this.alpha.spawn(o);
    }
    // 7) light flash
    if (this.lights.length) {
      let best = this.lights[0];
      for (const l of this.lights) if (l.userData.t > best.userData.t) best = l;
      best.position.copy(P);
      best.color.copy(col).lerp(C_HOT, 0.3);
      best.distance = s * 16;
      best.userData.t = 0; best.userData.life = 0.55; best.userData.peak = 2200 * size * size;
      best.intensity = best.userData.peak;
    }
  }

  update(dt, camera) {
    this.add.update(dt);
    this.alpha.update(dt);
    for (const l of this.lights) {
      const u = l.userData;
      if (u.t >= 1) { if (l.intensity !== 0) l.intensity = 0; continue; }
      u.t = Math.min(1, u.t + dt / u.life);
      l.intensity = u.peak * Math.pow(1 - u.t, 2);
    }
    void camera;
  }

  dispose() {
    this.add.dispose(); this.alpha.dispose();
    for (const l of this.lights) { this.scene.remove(l); l.dispose(); }
  }
}

// ---------------------------------------------------------------- speed dust
const DUST_VS = /* glsl */`
attribute vec3 aSeed; attribute float aEnd;
uniform vec3 uCam, uVel; uniform float uBox, uStreak, uBright;
varying float vA;
void main(){
  vec3 rel = mod(aSeed - uCam, uBox) - uBox * 0.5;
  float d = length(rel);
  vec3 wp = uCam + rel - uVel * uStreak * aEnd;
  float fade = smoothstep(uBox * 0.5, uBox * 0.3, d) * smoothstep(1.5, 6.0, d);
  vA = fade * uBright * (1.0 - aEnd * 0.85);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const DUST_FS = /* glsl */`
uniform vec3 uColor; varying float vA;
void main(){ if (vA < 0.002) discard; gl_FragColor = vec4(uColor * vA, 1.0); }`;

export class SpaceDust {
  /** Extra options: box (wrap size, 160), color. */
  constructor(scene, { count = 600, box = 160, color = '#cfe0ff' } = {}) {
    this.scene = scene;
    const r = rng(99);
    const seed = new Float32Array(count * 2 * 3), end = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = r() * box, y = r() * box, z = r() * box;
      seed.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.uniforms = {
      uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uBox: { value: box },
      uStreak: { value: 0.045 }, uBright: { value: 0 }, uColor: { value: new THREE.Color(color) },
    };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: DUST_VS, fragmentShader: DUST_FS, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    this.lines = new THREE.LineSegments(geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 15;
    this.geo = geo;
    this.enabled = true;
    scene.add(this.lines);
  }

  update(dt, cameraPosition, shipVelocity) {
    const u = this.uniforms;
    u.uCam.value.copy(cameraPosition);
    if (shipVelocity) u.uVel.value.copy(shipVelocity); else u.uVel.value.set(0, 0, 0);
    const sp = u.uVel.value.length();
    // keep streaks a sensible length at any speed
    u.uStreak.value = sp > 1 ? Math.min(0.06, 14 / sp) : 0;
    const target = Math.min(1, sp / 160) * 0.35;
    u.uBright.value += (target - u.uBright.value) * Math.min(1, dt * 4);
    this.lines.visible = this.enabled && u.uBright.value > 0.004;
  }

  dispose() { this.scene.remove(this.lines); this.geo.dispose(); this.mat.dispose(); }
}
