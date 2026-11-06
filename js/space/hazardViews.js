// Rendering for js/flight/hazards.js: plasmoids and the Vesk swarm.
//
// Five draw calls in total, all pooled/instanced, no per-frame allocation:
//   1. plasmoid bodies   instanced icosphere, animated plasma shader (domain-warped swirl,
//                        crackling veins, pulsing white-hot core, violet limb), additive;
//   2. glow billboards   one instanced quad pool for every soft light: plasmoid coronas and
//                        danger rings, drone eyes/tails/wind-up flares and converging rings,
//                        bolt heads and streaks, and all burst particles (pops, kills, impacts);
//   3. arcs              line segments: plasma tendrils crackling off each plasmoid, and
//                        arcs reaching toward a ship that gets too close (the telegraph);
//   4. skitter bodies    instanced crystalline chitin (lit), emissive claws/eyes/rim;
//   5. warden bodies     same material, bigger geometry.
//
// Colour language: magenta / white-hot plasma = environment hazard; toxic green on
// black-violet glass = the Vesk (enemy). Bodies stay below the bloom threshold; cores,
// eyes, bolts and wind-ups are hot enough to bloom.
//
// Usage:
//   const views = new HazardViews(scene, hazards, { quality });
//   for (const ev of hazards.events) views.onEvent(ev);   // bursts, muzzle flashes, zaps
//   views.update(dt, camera);

import * as THREE from 'three';
import { GLSL_NOISE } from './util.js';
import { mulberry32 } from '../core/util.js';

const MAX_PLASMOIDS = 40;
const MAX_SKITTERS = 32;
const MAX_WARDENS = 8;
const ARC_SEG = 7;

// Billboard shapes.
const GLOW = 0, CORONA = 1, RING = 2, STREAK = 3, FLARE = 4, SHARD = 5, ARC = 6;

// Palette (linear, HDR where it should bloom).
const C = {
  plCore: new THREE.Color(1.7, 1.25, 1.8), plBody: new THREE.Color(0.95, 0.08, 0.6), plRim: new THREE.Color(0.38, 0.08, 0.95),
  plHot: new THREE.Color(1.3, 0.3, 1.35), plCorona: new THREE.Color(0.55, 0.06, 0.45), plArc: new THREE.Color(1.6, 0.7, 1.9),
  plDanger: new THREE.Color(2.0, 0.9, 1.9),
  vkGlow: new THREE.Color(0.42, 1.0, 0.1), vkEye: new THREE.Color(0.38, 1.9, 0.12), vkHot: new THREE.Color(1.2, 2.4, 0.7),
  vkTail: new THREE.Color(0.14, 0.55, 0.06), vkGlass: new THREE.Color(0.2, 0.08, 0.42), vkChitin: new THREE.Color(0.035, 0.018, 0.06),
  bolt: new THREE.Color(0.5, 2.2, 0.2), boltCore: new THREE.Color(1.7, 2.6, 1.3), orb: new THREE.Color(0.85, 2.2, 0.25), orbRing: new THREE.Color(0.45, 0.2, 1.1),
  white: new THREE.Color(2, 2, 2),
};

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _cam = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

// ============================================================================ billboards
const BB_VS = /* glsl */`
attribute vec3 aPos; attribute vec4 aCol; attribute vec4 aP; attribute vec4 aV;
varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vSeed;
void main(){
  vUv = uv; vCol = aCol; vShape = aP.z; vSeed = aP.w;
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float size = max(aP.x, -mv.z * aV.w);
  vec2 q = position.xy;
  if ((aP.z > 2.5 && aP.z < 3.5) || aP.z > 5.5) {
    // streak / arc segment: from the head (aPos) back along aV.xyz (world units)
    vec3 tail = mv.xyz - (viewMatrix * vec4(aV.xyz, 0.0)).xyz;
    vec2 d = mv.xy - tail.xy;
    float L = length(d);
    vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    vec3 p = mix(tail, mv.xyz, q.x + 0.5);
    p.xy += nrm * q.y * size;
    mv = vec4(p, 1.0);
    vCol.a *= clamp((-p.z - 4.0) / 22.0, 0.0, 1.0);
  } else {
    float c = cos(aP.y), s = sin(aP.y);
    mv.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y) * size;
  }
  vCol.a *= clamp((-mv.z - 0.6) / max(size * 0.6, 0.6), 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const BB_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vSeed;
void main(){
  vec2 c = vUv * 2.0 - 1.0; float r2 = dot(c, c); float r = sqrt(r2);
  float a;
  if (vShape < 0.5) {                 // glow: soft halo + hot core
    a = max(exp(-r2 * 5.0) - 0.007, 0.0) + exp(-r2 * 30.0) * 0.8;
  } else if (vShape < 1.5) {          // corona: ray-modulated halo, hollow-ish centre
    float ang = atan(c.y, c.x);
    float rays = 0.55 + 0.45 * sin(ang * 7.0 + vSeed * 13.0 + uTime * 1.6) * sin(ang * 3.0 - uTime * 1.1 + vSeed * 5.0);
    float edge = 0.58 + 0.42 * rays;
    a = pow(clamp(1.0 - r / edge, 0.0, 1.0), 2.4) * (0.35 + 0.65 * smoothstep(0.18, 0.42, r));
  } else if (vShape < 2.5) {          // ring
    a = (exp(-pow((r - 0.88) / 0.035, 2.0)) + exp(-pow((r - 0.84) / 0.12, 2.0)) * 0.18) * step(r, 1.0);
  } else if (vShape < 3.5) {          // streak (uv.x: 0 tail .. 1 head)
    float y = vUv.y * 2.0 - 1.0;
    a = exp(-y * y * 6.0) * pow(vUv.x, 1.6) * smoothstep(1.0, 0.92, vUv.x) + exp(-y * y * 18.0) * smoothstep(0.75, 1.0, vUv.x) * 0.6;
  } else if (vShape < 4.5) {          // flare: star with a hot core
    a = exp(-r2 * 10.0) + (exp(-abs(c.x) * 28.0) * exp(-c.y * c.y * 2.5) + exp(-abs(c.y) * 28.0) * exp(-c.x * c.x * 2.5)) * 0.9;
  } else if (vShape < 5.5) {          // shard: a sharp crystal sliver
    float d = abs(c.x) * 0.9 + abs(c.y) * 2.6;
    a = smoothstep(1.0, 0.7, d) * (0.6 + 0.4 * (1.0 - abs(c.x)));
  } else {                            // arc segment: even along its length, hot thin core
    float y = vUv.y * 2.0 - 1.0;
    a = (exp(-y * y * 9.0) * 0.55 + exp(-y * y * 60.0)) * smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
  }
  a *= vCol.a;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb, a);
}`;

class Billboards {
  constructor(scene, max) {
    this.max = max; this.n = 0;
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    const mk = (k) => new THREE.InstancedBufferAttribute(new Float32Array(max * k), k).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(3); this.aCol = mk(4); this.aP = mk(4); this.aV = mk(4);
    geo.setAttribute('aPos', this.aPos); geo.setAttribute('aCol', this.aCol); geo.setAttribute('aP', this.aP); geo.setAttribute('aV', this.aV);
    geo.instanceCount = 0;
    this.geo = geo;
    this.uniforms = { uTime: { value: 0 } };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: BB_VS, fragmentShader: BB_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 26;
    this.mesh.name = 'HazardGlows';
    scene.add(this.mesh);
  }
  begin() { this.n = 0; }
  /** pos: Vector3-like; col: Color; k: brightness; alpha; size; shape; rot; seed; v: streak vector or null; minAng */
  push(px, py, pz, cr, cg, cb, alpha, size, shape, rot = 0, seed = 0, vx = 0, vy = 0, vz = 0, minAng = 0) {
    if (this.n >= this.max || alpha <= 0.002 || size <= 0) return;
    const i = this.n++;
    const P = this.aPos.array, Cc = this.aCol.array, A = this.aP.array, V = this.aV.array;
    P[i * 3] = px; P[i * 3 + 1] = py; P[i * 3 + 2] = pz;
    Cc[i * 4] = cr; Cc[i * 4 + 1] = cg; Cc[i * 4 + 2] = cb; Cc[i * 4 + 3] = alpha;
    A[i * 4] = size; A[i * 4 + 1] = rot; A[i * 4 + 2] = shape; A[i * 4 + 3] = seed;
    V[i * 4] = vx; V[i * 4 + 1] = vy; V[i * 4 + 2] = vz; V[i * 4 + 3] = minAng;
  }
  end() {
    this.geo.instanceCount = this.n;
    if (this.n) { this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aP.needsUpdate = true; this.aV.needsUpdate = true; }
    this.mesh.visible = this.n > 0;
  }
  dispose(scene) { scene.remove(this.mesh); this.geo.dispose(); this.mat.dispose(); }
}

// ============================================================================ particles (CPU pool)
class Particles {
  constructor(max) {
    this.max = max; this.n = 0;
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f(); this.s0 = f(); this.s1 = f(); this.shape = f(); this.drag = f();
    this.r0 = f(); this.g0 = f(); this.b0 = f(); this.r1 = f(); this.g1 = f(); this.b1 = f(); this.a0 = f();
    this.rot = f(); this.rotV = f(); this.streak = f(); this.delay = f(); this.fadePow = f();
  }
  spawn(o) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.px[i] = o.px; this.py[i] = o.py; this.pz[i] = o.pz; this.vx[i] = o.vx; this.vy[i] = o.vy; this.vz[i] = o.vz;
    this.life[i] = -(o.delay || 0); this.maxLife[i] = o.life; this.s0[i] = o.s0; this.s1[i] = o.s1 ?? o.s0; this.shape[i] = o.shape; this.drag[i] = o.drag || 0;
    this.r0[i] = o.c0.r * o.k0; this.g0[i] = o.c0.g * o.k0; this.b0[i] = o.c0.b * o.k0;
    const c1 = o.c1 || o.c0, k1 = o.k1 ?? o.k0 * 0.4;
    this.r1[i] = c1.r * k1; this.g1[i] = c1.g * k1; this.b1[i] = c1.b * k1;
    this.a0[i] = o.alpha ?? 1; this.rot[i] = o.rot || 0; this.rotV[i] = o.rotV || 0; this.streak[i] = o.streak || 0; this.fadePow[i] = o.fadePow ?? 1.4;
  }
  _move(d, s) {
    for (const k of ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'life', 'maxLife', 's0', 's1', 'shape', 'drag', 'r0', 'g0', 'b0', 'r1', 'g1', 'b1', 'a0', 'rot', 'rotV', 'streak', 'fadePow']) this[k][d] = this[k][s];
  }
  update(dt, bb) {
    let i = 0;
    while (i < this.n) {
      this.life[i] += dt;
      const life = this.life[i];
      if (life >= this.maxLife[i]) { this.n--; if (i !== this.n) this._move(i, this.n); continue; }
      if (life < 0) { i++; continue; }
      const t = life / this.maxLife[i];
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotV[i] * dt;
      const e = 1 - (1 - t) * (1 - t);
      const a = this.a0[i] * Math.pow(1 - t, this.fadePow[i]);
      const st = this.streak[i];
      bb.push(this.px[i], this.py[i], this.pz[i],
        this.r0[i] + (this.r1[i] - this.r0[i]) * t, this.g0[i] + (this.g1[i] - this.g0[i]) * t, this.b0[i] + (this.b1[i] - this.b0[i]) * t,
        a, this.s0[i] + (this.s1[i] - this.s0[i]) * e, this.shape[i], this.rot[i], i * 0.37, this.vx[i] * st, this.vy[i] * st, this.vz[i] * st, 0);
      i++;
    }
  }
}

// ============================================================================ plasma body
const PLASMA_VS = /* glsl */`
attribute vec4 aPl; attribute vec4 aPl2;
varying vec3 vN; varying vec3 vV; varying vec3 vO; varying vec4 vPl; varying vec4 vPl2;
void main(){
  vO = position; vPl = aPl; vPl2 = aPl2;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 wn = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vN = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
  vec4 mv = viewMatrix * wp;
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const PLASMA_FS = /* glsl */`
uniform float uTime; uniform vec3 uCore, uBody, uRim, uHot;
varying vec3 vN; varying vec3 vV; varying vec3 vO; varying vec4 vPl; varying vec4 vPl2;
${GLSL_NOISE}
void main(){
  float seed = vPl.x, warn = vPl.y, flash = vPl.z, form = vPl.w;
  float pop = vPl2.y, flare = vPl2.z;
  vec3 n = normalize(vN), v = normalize(vV);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float t = uTime * 0.5 + seed * 17.0;
  vec3 p = vO * 1.7 + seed * 3.1;
  // swirling, domain-warped plasma
  vec3 w = vec3(sw_vnoise(p + vec3(t, 0.0, 0.0)), sw_vnoise(p + vec3(0.0, t * 0.8, 5.2)), sw_vnoise(p + vec3(2.1, 0.0, t * 0.6)));
  float sw = smoothstep(0.22, 0.72, sw_fbm(p * 1.25 + w * 1.9 + vec3(0.0, 0.0, t * 0.4), 3));
  // crackling veins: thin ridges that flicker
  float rv = 1.0 - abs(sw_vnoise(p * 3.0 + w * 2.2 + vec3(t * 1.6)) * 2.0 - 1.0);
  float veins = pow(rv, 12.0) * (0.55 + 0.45 * sin(uTime * 23.0 + seed * 40.0 + p.x * 3.0));
  float pulse = 0.8 + 0.2 * sin(uTime * (2.0 + seed * 1.3) + seed * 9.0);
  float core = pow(ndv, 16.0 - 6.0 * warn) * pulse;
  float limb = pow(1.0 - ndv, 2.2);
  vec3 col = uBody * (0.05 + 0.62 * sw) * (0.45 + 0.55 * ndv);
  col += uRim * limb * (0.35 + 0.5 * sw);
  col += uHot * veins * (0.45 + 1.1 * warn + 1.5 * flare) * (0.5 + 0.5 * ndv);
  col += uCore * core * (0.6 + 0.6 * warn + 0.8 * flare);
  col += uBody * pow(ndv, 3.0) * 0.35 * pulse;
  col *= 1.0 + flash * 1.6 + pop * 1.5;
  float alpha = clamp(form, 0.0, 1.0) * (1.0 - pop);
  gl_FragColor = vec4(col, alpha);
}`;

// ============================================================================ Vesk geometry
class GeoBuilder {
  constructor() { this.pos = []; this.col = []; this.emit = []; }
  tri(a, b, c, col, ea = 0, eb = ea, ec = ea) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) this.col.push(col.r, col.g, col.b);
    this.emit.push(ea, eb, ec);
  }
  /** Crystal bipyramid along z: front tip, back tip, ring of `n` points. emitFront tints the front tip. */
  bipyramid(cx, cy, cz, front, back, rx, ry, n, col, rng, { emitFront = 0, emitRing = 0, emitBack = 0, twist = 0, zRing = 0 } = {}) {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + twist;
      const j = 0.85 + rng() * 0.3;
      ring.push([cx + Math.cos(a) * rx * j, cy + Math.sin(a) * ry * j, cz + zRing + (rng() - 0.5) * 0.15 * rx]);
    }
    const F = [cx, cy, cz - front], B = [cx, cy, cz + back];
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const shade = 0.75 + rng() * 0.5;
      const cf = col.clone().multiplyScalar(shade), cb = col.clone().multiplyScalar(shade * 0.8);
      this.tri(F, b, a, cf, emitFront, emitRing, emitRing);
      this.tri(B, a, b, cb, emitBack, emitRing, emitRing);
    }
  }
  /** A tapered 3-sided shard through a polyline of points; emission ramps root -> tip. */
  shard(pts, width, col, emitRoot = 0, emitTip = 1) {
    const N = pts.length;
    for (let s = 0; s < N - 1; s++) {
      const a = pts[s], b = pts[s + 1];
      const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      const side = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? UPV : new THREE.Vector3(1, 0, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(side, d).normalize();
      const w0 = width * (1 - s / (N - 1)), w1 = s + 1 === N - 1 ? 0 : width * (1 - (s + 1) / (N - 1));
      const ring = (p, w) => [0, 1, 2].map((k) => {
        const ang = (k / 3) * Math.PI * 2;
        return [p[0] + (side.x * Math.cos(ang) + up.x * Math.sin(ang)) * w, p[1] + (side.y * Math.cos(ang) + up.y * Math.sin(ang)) * w * 0.55, p[2] + (side.z * Math.cos(ang) + up.z * Math.sin(ang)) * w];
      });
      const ra = ring(a, w0), rb = ring(b, w1);
      const ea = emitRoot + (emitTip - emitRoot) * Math.pow(s / (N - 1), 4), eb = emitRoot + (emitTip - emitRoot) * Math.pow((s + 1) / (N - 1), 4);
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        const cc = col.clone().multiplyScalar(0.8 + 0.25 * k);
        this.tri(ra[k], rb[k], rb[k2], cc, ea, eb, eb);
        this.tri(ra[k], rb[k2], ra[k2], cc, ea, eb, ea);
      }
    }
  }
  mirrorX(fn) { fn(1); fn(-1); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emit, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

function skitterGeometry() {
  const b = new GeoBuilder(), rng = mulberry32(77);
  const chitin = C.vkChitin, glass = C.vkGlass;
  // Thorax: a long faceted crystal, a little higher at the back.
  b.bipyramid(0, 0, 0, 2.5, 2.1, 0.95, 0.62, 6, chitin, rng, { emitFront: 0.15, twist: 0.5 });
  // Head: a glassy bead whose tip is the eye.
  b.bipyramid(0, 0.05, -1.9, 0.9, 0.45, 0.42, 0.34, 5, glass, rng, { emitFront: 1, emitRing: 0.25 });
  // Dorsal crest.
  b.shard([[0, 0.45, -0.6], [0, 1.0, 0.4], [0, 1.45, 1.6]], 0.32, glass, 0.05, 0.55);
  // Belly sac: a glowing gland.
  b.bipyramid(0, -0.5, 0.35, 0.6, 0.7, 0.42, 0.3, 5, glass, rng, { emitFront: 0.7, emitRing: 0.5, emitBack: 0.6 });
  b.mirrorX((s) => {
    // Mantis claws: root at the shoulder, elbow out and back, tip raking forward (glowing).
    b.shard([[s * 0.6, 0.15, -0.8], [s * 1.7, 0.75, 0.1], [s * 2.55, 0.55, -1.2], [s * 2.35, 0.2, -2.6]], 0.3, chitin, 0.0, 1.0);
    // Lower legs.
    b.shard([[s * 0.55, -0.25, -0.1], [s * 1.6, -0.75, 0.6], [s * 2.2, -1.0, -0.6]], 0.24, chitin, 0.0, 0.8);
    // Tail spines.
    b.shard([[s * 0.35, 0.15, 1.3], [s * 0.9, 0.55, 2.4], [s * 1.25, 0.95, 3.4]], 0.22, glass, 0.0, 0.45);
  });
  const g = b.build();
  g.scale(1.2, 1.2, 1.2);   // a touch larger than a racer: enemies must read at a distance
  return g;
}

function wardenGeometry() {
  const b = new GeoBuilder(), rng = mulberry32(911);
  const chitin = C.vkChitin, glass = C.vkGlass;
  // Bulbous carapace: two offset crystals for an organic, asymmetric hull.
  b.bipyramid(0, 0, 0, 5.6, 5.2, 4.0, 3.0, 8, chitin, rng, { twist: 0.2 });
  b.bipyramid(0, 0.9, 0.8, 3.6, 4.4, 3.0, 2.4, 7, glass.clone().multiplyScalar(0.6), rng, { twist: 0.6, emitRing: 0.05 });
  // Maw: a glowing gullet with crystal teeth round it.
  b.bipyramid(0, 0, -4.8, 1.6, 0.8, 1.3, 1.1, 6, glass, rng, { emitFront: 1, emitRing: 0.8 });
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const x = Math.cos(a) * 2.1, y = Math.sin(a) * 1.7;
    b.shard([[x, y, -4.2], [x * 1.05, y * 1.05, -5.8], [x * 0.55, y * 0.55, -7.0]], 0.36, glass, 0.15, 0.9);
  }
  // Spines radiating back.
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + 0.3;
    const x = Math.cos(a), y = Math.sin(a) * 0.8;
    const L = 4 + rng() * 3.5;
    b.shard([[x * 2.6, y * 2.2, 0.5], [x * 4.0, y * 3.4, 2.4], [x * (4.4 + L * 0.3), y * (3.7 + L * 0.25), 3.0 + L]], 0.5, chitin, 0.0, 0.7);
  }
  // Glowing side sacs.
  b.mirrorX((s) => b.bipyramid(s * 3.7, -0.6, 0.2, 1.3, 1.3, 1.0, 0.85, 6, glass, rng, { emitFront: 0.9, emitRing: 0.7, emitBack: 0.9 }));
  return b.build();
}

function veskMaterial(uTime) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.3, flatShading: true, envMapIntensity: 0.3 });
  const glow = new THREE.Color(0.16, 0.85, 0.03);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.uGlow = { value: glow };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmit; attribute vec4 aState; varying float vEmit; varying vec4 vState; varying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEmit = aEmit; vState = aState; vObj = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uGlow; varying float vEmit; varying vec4 vState; varying vec3 vObj;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        // Burrow / emerge: a crystalline dissolve.
        float dn = fract(sin(dot(floor(vObj * 2.5), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        if (dn > vState.z * 1.02) discard;`)
      // The sky's lifted environment would wash dark glass out: keep only a little of it
      // (scene.environmentIntensity overrides material.envMapIntensity, so scale here).
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n        iblIrradiance *= 0.15; radiance *= 0.6;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float pulse = 0.72 + 0.28 * sin(uTime * 5.0 + vState.w * 6.283 + vObj.z * 0.9);
        float rim = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.4);
        float edgeGlow = (1.0 - smoothstep(0.0, 0.12, vState.z - dn)) * step(vState.z, 0.999);
        totalEmissiveRadiance += uGlow * (vEmit * (1.3 + 1.6 * vState.y) * pulse + rim * (0.32 + 0.5 * vState.y) + edgeGlow * 2.5)
                               + vec3(0.035, 0.012, 0.07) * (1.0 - vEmit)
                               + vec3(0.9, 1.0, 0.85) * vState.x * 1.4;`);
  };
  mat.customProgramCacheKey = () => 'vesk-chitin-v2';
  return mat;
}

// ============================================================================ views
export class HazardViews {
  constructor(scene, hazards, { quality = 'high' } = {}) {
    this.scene = scene;
    this.hz = hazards;
    this.quality = quality;
    this.time = 0;
    this.rng = mulberry32(4711);
    this.uTime = { value: 0 };
    const lowQ = quality === 'low';

    // 1. plasmoids
    const sphere = new THREE.IcosahedronGeometry(1, lowQ ? 2 : 3);
    const pgeo = new THREE.BufferGeometry();
    pgeo.index = sphere.index;
    for (const k of ['position', 'normal']) pgeo.setAttribute(k, sphere.attributes[k]);
    this.aPl = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PLASMOIDS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aPl2 = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PLASMOIDS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    pgeo.setAttribute('aPl', this.aPl);
    pgeo.setAttribute('aPl2', this.aPl2);
    this.plasmaMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uCore: { value: C.plCore }, uBody: { value: C.plBody }, uRim: { value: C.plRim }, uHot: { value: C.plHot } },
      vertexShader: PLASMA_VS, fragmentShader: PLASMA_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.plasmoids = new THREE.InstancedMesh(pgeo, this.plasmaMat, MAX_PLASMOIDS);
    this.plasmoids.count = 0;
    this.plasmoids.frustumCulled = false;
    this.plasmoids.renderOrder = 22;
    this.plasmoids.name = 'Plasmoids';
    scene.add(this.plasmoids);
    this._sphere = sphere;

    // 2. billboards + particles
    this.bb = new Billboards(scene, lowQ ? 1200 : 2400);
    this.parts = new Particles(lowQ ? 700 : 1500);
    this._o = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, life: 1, s0: 1, s1: 1, shape: 0, drag: 0, c0: C.white, k0: 1, c1: null, k1: null, alpha: 1, rot: 0, rotV: 0, streak: 0, delay: 0, fadePow: 1.4 };

    // 3. arcs (thick glowing segments in the billboard pool)
    this.maxArcs = MAX_PLASMOIDS * 3 + 24;
    // Arc state: per plasmoid 2 ambient arcs + 1 reach arc, plus free burst arcs.
    this.arcState = Array.from({ length: this.maxArcs }, () => ({ t: 0, life: 0, next: 0, ax: 0, ay: 0, az: 0, len: 0, seed: 0, jit: 0 }));
    this.burstArcs = [];

    // 4/5. Vesk bodies
    this.veskMat = veskMaterial(this.uTime);
    const mkBody = (geo, max, name) => {
      const st = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aState', st);
      const m = new THREE.InstancedMesh(geo, this.veskMat, max);
      m.count = 0;
      m.frustumCulled = false;
      m.name = name;
      scene.add(m);
      return { mesh: m, state: st, max };
    };
    this.skitters = mkBody(skitterGeometry(), MAX_SKITTERS, 'VeskSkitters');
    this.wardens = mkBody(wardenGeometry(), MAX_WARDENS, 'VeskWardens');
  }

  // ------------------------------------------------------------------ events -> effects
  /** Feed every hazard event here (local and remote) for bursts and flashes. */
  onEvent(ev) {
    switch (ev.type) {
      case 'plasmoidPop': this.burst('plasmoid', ev.pos, { r: ev.r || this.hz.plasmoids[ev.id]?.r || 10 }); break;
      case 'droneDown': this.burst(ev.droneType === 'warden' ? 'warden' : 'drone', ev.pos, { vel: ev.vel }); break;
      case 'droneFire': this.burst(ev.kind === 'orb' ? 'muzzleOrb' : 'muzzle', ev.pos, { dir: ev.dir }); break;
      case 'boltImpact': this.burst(ev.kind === 'orb' ? 'orbImpact' : 'impact', ev.pos); break;
      case 'plasmoidZap': this.burst('zap', ev.point, { id: ev.id }); break;
      case 'plasmoidReform': this.burst('reform', ev.pos, { r: this.hz.plasmoids[ev.id]?.r || 10 }); break;
      case 'boltFizzle': this.burst('fizzle', ev.pos); break;
      default:
    }
  }

  /** Spawn an effect: 'plasmoid' | 'drone' | 'warden' | 'impact' | 'orbImpact' | 'muzzle' | 'muzzleOrb' | 'zap' | 'reform' | 'fizzle'. */
  burst(kind, pos, opts = {}) {
    const o = this._o, r = this.rng, P = this.parts;
    const at = (shape, life, s0, s1, c0, k0, c1, k1, alpha = 1) => {
      o.px = pos.x; o.py = pos.y; o.pz = pos.z; o.vx = o.vy = o.vz = 0; o.drag = 0; o.rot = r() * 6.28; o.rotV = 0; o.streak = 0; o.delay = 0; o.fadePow = 1.6;
      o.shape = shape; o.life = life; o.s0 = s0; o.s1 = s1; o.c0 = c0; o.k0 = k0; o.c1 = c1; o.k1 = k1; o.alpha = alpha;
      return o;
    };
    const spray = (n, shape, speed, life, size, c0, k0, c1, k1, { streak = 0, drag = 1.5, base = null, spin = 0, off = 0 } = {}) => {
      for (let i = 0; i < n; i++) {
        randUnit(r, _v);
        const sp = speed * (0.35 + r() * 0.9);
        at(shape, life * (0.6 + r() * 0.8), size * (0.6 + r() * 0.8), size * (0.2 + r() * 0.4), c0, k0, c1, k1);
        o.px += _v.x * off; o.py += _v.y * off; o.pz += _v.z * off;
        o.vx = _v.x * sp + (base ? base.x : 0); o.vy = _v.y * sp + (base ? base.y : 0); o.vz = _v.z * sp + (base ? base.z : 0);
        o.drag = drag; o.streak = streak; o.rotV = (r() - 0.5) * spin; o.fadePow = 1.2;
        P.spawn(o);
      }
    };
    switch (kind) {
      case 'plasmoid': {
        const R = opts.r || 10;
        P.spawn(at(GLOW, 0.32, R * 4, R * 7, C.plCore, 1.6, C.plBody, 0.6));
        P.spawn(at(RING, 0.55, R * 1.6, R * 6.5, C.plHot, 0.9, C.plRim, 0.3));
        P.spawn(at(CORONA, 0.7, R * 2.6, R * 5, C.plCorona, 1.4, C.plRim, 0.3));
        spray(46, STREAK, 70 + R * 6, 0.7, 0.7, C.plHot, 1.3, C.plRim, 0.4, { streak: 0.08, drag: 2.2, off: R * 0.6 });
        spray(22, GLOW, 18 + R * 2, 1.8, 1.6, C.plBody, 1.4, C.plRim, 0.3, { drag: 1.0, off: R * 0.5 });
        // Tendrils of lightning thrown out for a moment.
        for (let i = 0; i < 7; i++) this._burstArc(pos, randUnit(r, _v), R * (1.4 + r() * 1.6), 0.18 + r() * 0.12, R * 0.9);
        break;
      }
      case 'drone': case 'warden': {
        const big = kind === 'warden' ? 2.4 : 1;
        const base = opts.vel ? _w.copy(opts.vel).multiplyScalar(0.35) : null;
        P.spawn(at(GLOW, 0.28, 8 * big, 14 * big, C.vkHot, 1.4, C.vkGlow, 0.5));
        P.spawn(at(FLARE, 0.2, 10 * big, 16 * big, C.vkHot, 1.2, C.vkGlow, 0.4));
        P.spawn(at(RING, 0.5, 4 * big, 22 * big, C.vkEye, 0.7, C.vkGlow, 0.2));
        spray(Math.round(20 * big), SHARD, 30 * big, 1.6, 1.3 * big, C.vkGlass, 2.2, C.vkChitin, 1.0, { drag: 0.7, base, spin: 14 });
        spray(Math.round(8 * big), SHARD, 22 * big, 1.2, 0.9 * big, C.vkEye, 1.0, C.vkGlow, 0.3, { drag: 0.9, base, spin: 10 });
        spray(Math.round(30 * big), STREAK, 90 * big, 0.6, 0.45 * big, C.vkHot, 1.1, C.vkGlow, 0.5, { streak: 0.07, drag: 2.4, base });
        spray(Math.round(10 * big), GLOW, 12 * big, 1.6, 1.4 * big, C.vkGlow, 1.6, C.vkGlow, 0.2, { drag: 0.8, base });
        break;
      }
      case 'impact': case 'orbImpact': {
        const big = kind === 'orbImpact' ? 2 : 1;
        P.spawn(at(GLOW, 0.2, 3 * big, 7 * big, C.vkHot, 1.3, C.vkGlow, 0.4));
        P.spawn(at(RING, 0.3, 1.5 * big, 7 * big, C.vkEye, 0.6, C.vkGlow, 0.2));
        spray(10 * big, STREAK, 45, 0.35, 0.3, C.vkHot, 1.0, C.vkGlow, 0.4, { streak: 0.06, drag: 3 });
        break;
      }
      case 'muzzle': case 'muzzleOrb': {
        const big = kind === 'muzzleOrb' ? 2.2 : 1;
        P.spawn(at(FLARE, 0.14, 5 * big, 7 * big, C.vkHot, 1.2, C.vkGlow, 0.4));
        P.spawn(at(GLOW, 0.18, 3.5 * big, 5 * big, C.vkEye, 0.8, C.vkGlow, 0.3));
        break;
      }
      case 'zap': {
        P.spawn(at(GLOW, 0.25, 6, 12, C.plCore, 1.5, C.plBody, 0.5));
        P.spawn(at(FLARE, 0.18, 8, 14, C.plHot, 1.1, C.plRim, 0.4));
        const pl = opts.id != null ? this.hz.plasmoids[opts.id] : null;
        if (pl) {
          _v.subVectors(pos, pl.pos);
          const d = _v.length();
          if (d > 1e-3) for (let i = 0; i < 3; i++) this._burstArc(pl.pos, _v.clone().divideScalar(d), d * (1.0 + r() * 0.3), 0.22, pl.r * 0.95);
        }
        spray(16, STREAK, 60, 0.4, 0.35, C.plHot, 1.1, C.plRim, 0.4, { streak: 0.07, drag: 2.5 });
        break;
      }
      case 'reform': {
        const R = opts.r || 10;
        for (let i = 0; i < 26; i++) {
          randUnit(r, _v);
          const d = R * (2.2 + r() * 1.5), life = 1.1 + r() * 0.6;
          at(GLOW, life, 1.2 + r() * 1.2, 0.3, C.plHot, 0.9, C.plCore, 1.4);
          o.px += _v.x * d; o.py += _v.y * d; o.pz += _v.z * d;
          o.vx = -_v.x * d / life; o.vy = -_v.y * d / life; o.vz = -_v.z * d / life;
          o.fadePow = 0.6;
          P.spawn(o);
        }
        break;
      }
      case 'fizzle': P.spawn(at(GLOW, 0.3, 2, 4, C.vkGlow, 0.8, C.vkGlow, 0.1)); break;
      default:
    }
  }

  _burstArc(origin, dir, len, life, start) {
    if (this.burstArcs.length > 24) return;
    this.burstArcs.push({ x: origin.x + dir.x * start, y: origin.y + dir.y * start, z: origin.z + dir.z * start, dx: dir.x, dy: dir.y, dz: dir.z, len, life, t: 0, seed: this.rng() * 100 });
  }

  // ------------------------------------------------------------------ frame
  update(dt, camera) {
    this.time += dt;
    this.uTime.value = this.time;
    this.bb.uniforms.uTime.value = this.time;
    const hz = this.hz, T = this.time, bb = this.bb;
    camera.getWorldPosition(_cam);
    bb.begin();

    // --- plasmoids
    let n = 0, arcN = 0;
    const m = this.plasmoids, A1 = this.aPl.array, A2 = this.aPl2.array;
    const pls = hz.plasmoids;
    for (let i = 0; i < pls.length && n < MAX_PLASMOIDS; i++) {
      const p = pls[i];
      let scale = p.r, form = 1, pop = 0;
      if (p.state === 'popped') {
        pop = clamp((hz.time - p.popAt) / 0.3, 0, 1);
        if (pop >= 1) continue;
        scale *= 1 + pop * 0.6;
      } else if (p.state === 'forming') {
        form = p.form;
        scale *= easeOutBack(form);
      }
      const breathe = 1 + 0.035 * Math.sin(T * 2.6 + p.seed) + p.flare * 0.1;
      scale *= breathe;
      if (scale <= 0.01) continue;
      _q.identity();
      _m.compose(p.pos, _q, _s.setScalar(scale));
      m.setMatrixAt(n, _m);
      A1[n * 4] = (p.seed % 97) / 97; A1[n * 4 + 1] = p.warn; A1[n * 4 + 2] = p.flash; A1[n * 4 + 3] = form;
      A2[n * 4] = p.hp / p.maxHp; A2[n * 4 + 1] = pop; A2[n * 4 + 2] = p.flare; A2[n * 4 + 3] = p.r;
      n++;
      if (pop > 0) continue;
      // corona + danger ring
      const w = p.warn;
      const k = (0.65 + 1.0 * w + p.flare) * form;
      bb.push(p.pos.x, p.pos.y, p.pos.z, C.plCorona.r * k, C.plCorona.g * k, C.plCorona.b * k, 0.9, scale * (3.0 + 0.6 * w), CORONA, T * 0.1, p.seed);
      if (w > 0.12 && form >= 1) {
        const pulse = 0.65 + 0.35 * Math.sin(T * (8 + 10 * w));
        const ka = smooth(0.12, 0.7, w) * pulse;
        bb.push(p.pos.x, p.pos.y, p.pos.z, C.plDanger.r, C.plDanger.g, C.plDanger.b, ka * 0.75, scale * 2.25, RING, 0, 0);
      }
      // arcs (ambient crackle, and reaching for anyone too close)
      if (form >= 1) arcN = this._plasmoidArcs(i, p, scale, arcN, dt);
    }
    m.count = n;
    if (n) { m.instanceMatrix.needsUpdate = true; this.aPl.needsUpdate = true; this.aPl2.needsUpdate = true; }
    m.visible = n > 0;

    // burst arcs
    for (let k = this.burstArcs.length - 1; k >= 0; k--) {
      const a = this.burstArcs[k];
      a.t += dt;
      if (a.t >= a.life) { this.burstArcs.splice(k, 1); continue; }
      const f = 1 - a.t / a.life;
      _v.set(a.x, a.y, a.z);
      _w.set(a.dx, a.dy, a.dz);
      arcN = this._writeArc(arcN, _v, _w, a.len * (0.6 + 0.4 * (1 - f)), a.seed + Math.floor(T * 30), f * 1.4, 0.35);
    }

    // --- drones
    let ns = 0, nw = 0;
    const SK = this.skitters, WD = this.wardens;
    for (const d of hz.drones) {
      if (!d.alive || d.vis <= 0.01) continue;
      const war = d.type === 'warden';
      const body = war ? WD : SK;
      const idx = war ? nw : ns;
      if (idx >= body.max) continue;
      _m.compose(d.pos, d.quat, _s.setScalar(1 + d.flash * 0.06));
      body.mesh.setMatrixAt(idx, _m);
      const S = body.state.array;
      S[idx * 4] = d.flash; S[idx * 4 + 1] = d.charge; S[idx * 4 + 2] = d.vis; S[idx * 4 + 3] = (d.id * 0.618) % 1;
      if (war) nw++; else ns++;
      // eyes, tail, wind-up
      const fwd = d.fwd;
      const vis = d.vis;
      const eyeOff = war ? 6.0 : 3.3;
      _p.copy(d.pos).addScaledVector(fwd, eyeOff);
      const blink = 0.85 + 0.15 * Math.sin(T * 6 + d.id);
      const ek = (0.8 + d.charge * 0.8 + d.flash) * blink * vis;
      bb.push(_p.x, _p.y, _p.z, C.vkEye.r * ek, C.vkEye.g * ek, C.vkEye.b * ek, 1, war ? 2.4 : 0.95, GLOW, 0, 0, 0, 0, 0, war ? 0.011 : 0.0075);
      // a faint aura so silhouettes read against dark space at a distance
      bb.push(d.pos.x, d.pos.y, d.pos.z, C.vkGlow.r * 0.07 * vis, C.vkGlow.g * 0.07 * vis, C.vkGlow.b * 0.07 * vis, 1, war ? 22 : 8, GLOW, 0, 0, 0, 0, 0, war ? 0.03 : 0.02);
      const sp = d.vel.length();
      if (sp > 8 && vis > 0.5) {
        const L = Math.min(war ? 26 : 16, sp * 0.09);
        _w.copy(d.vel).multiplyScalar(L / sp);
        bb.push(d.pos.x, d.pos.y, d.pos.z, C.vkTail.r, C.vkTail.g, C.vkTail.b, 0.9 * vis, war ? 3.2 : 1.1, STREAK, 0, 0, _w.x, _w.y, _w.z, 0);
      }
      if (war) {
        // side sacs pulsing
        _r.set(1, 0, 0).applyQuaternion(d.quat);
        const pk = (0.6 + 0.4 * Math.sin(T * 3 + d.id)) * vis;
        for (const s of [-1, 1]) { _p.copy(d.pos).addScaledVector(_r, s * 3.9); bb.push(_p.x, _p.y, _p.z, C.vkGlow.r * pk, C.vkGlow.g * pk, C.vkGlow.b * pk, 0.8, 3.2, GLOW); }
      }
      if (d.charge > 0) {
        const c = d.charge, ce = c * c;
        _p.copy(d.pos).addScaledVector(fwd, eyeOff + (war ? 1.5 : 0.6));
        const fk = 0.3 + 0.6 * ce;
        bb.push(_p.x, _p.y, _p.z, C.vkHot.r * fk, C.vkHot.g * fk, C.vkHot.b * fk, 1, (war ? 2.6 : 0.9) + (war ? 4.5 : 1.6) * ce, FLARE, T * 2 + d.id, 0, 0, 0, 0, 0.003);
        bb.push(_p.x, _p.y, _p.z, C.vkEye.r * 0.5, C.vkEye.g * 0.5, C.vkEye.b * 0.5, 0.3 + 0.5 * c, (war ? 22 : 11) * (1 - c) + (war ? 4 : 2), RING, 0, 0, 0, 0, 0, 0.002);
        // motes sucked in
        if (this.rng() < dt * 30) {
          const o = this._o;
          randUnit(this.rng, _v);
          const dd = war ? 9 : 4.5;
          o.px = _p.x + _v.x * dd; o.py = _p.y + _v.y * dd; o.pz = _p.z + _v.z * dd;
          o.vx = -_v.x * dd / 0.25 + d.vel.x; o.vy = -_v.y * dd / 0.25 + d.vel.y; o.vz = -_v.z * dd / 0.25 + d.vel.z;
          o.life = 0.25; o.s0 = war ? 0.9 : 0.45; o.s1 = 0.1; o.shape = STREAK; o.streak = 0.04; o.drag = 0; o.c0 = C.vkHot; o.k0 = 1; o.c1 = C.vkGlow; o.k1 = 0.6; o.alpha = 1; o.rot = 0; o.rotV = 0; o.delay = 0; o.fadePow = 0.5;
          this.parts.spawn(o);
        }
      }
    }
    for (const [body, count] of [[SK, ns], [WD, nw]]) {
      body.mesh.count = count;
      if (count) { body.mesh.instanceMatrix.needsUpdate = true; body.state.needsUpdate = true; }
      body.mesh.visible = count > 0;
    }

    // --- bolts
    for (const b of hz.bolts) {
      if (!b.alive) continue;
      const orb = b.kind === 'orb';
      const sp = b.vel.length() || 1;
      const L = orb ? 12 : 16;
      _w.copy(b.vel).multiplyScalar(L / sp);
      const fl = 0.85 + 0.15 * Math.sin(T * 40 + b.id);
      const c = orb ? C.orb : C.bolt;
      bb.push(b.pos.x, b.pos.y, b.pos.z, c.r * 0.45, c.g * 0.45, c.b * 0.45, 1, orb ? 1.6 : 0.75, STREAK, 0, 0, _w.x, _w.y, _w.z, 0);
      bb.push(b.pos.x, b.pos.y, b.pos.z, c.r * fl * 0.7, c.g * fl * 0.7, c.b * fl * 0.7, 1, orb ? 5.5 : 2.6, GLOW, 0, 0, 0, 0, 0, 0.003);
      bb.push(b.pos.x, b.pos.y, b.pos.z, C.boltCore.r * 0.8, C.boltCore.g * 0.8, C.boltCore.b * 0.8, 1, orb ? 1.8 : 0.8, GLOW, 0, 0, 0, 0, 0, 0.0012);
      if (orb) bb.push(b.pos.x, b.pos.y, b.pos.z, C.orbRing.r * 1.2, C.orbRing.g * 1.2, C.orbRing.b * 1.2, 0.8, 5.5, RING, T * 3 + b.id, 0);
    }

    // --- particles last
    this.parts.update(dt, bb);
    bb.end();
  }

  _plasmoidArcs(i, p, scale, arcN, dt) {
    const r = this.rng;
    // Two ambient tendrils.
    for (let k = 0; k < 2; k++) {
      const a = this.arcState[i * 3 + k];
      if (a.t < a.life) {
        a.t += dt;
        _v.set(a.ax, a.ay, a.az);
        _p.copy(p.pos).addScaledVector(_v, scale * 0.92);
        const f = 1 - a.t / a.life;
        arcN = this._writeArc(arcN, _p, _v, a.len * scale * (0.5 + 0.5 * Math.min(1, a.t / (a.life * 0.3))), a.seed + Math.floor(this.time * 28), 0.9 * f + 0.25 * p.warn, 0.45);
      } else if (this.time >= a.next) {
        randUnit(r, _v);
        a.ax = _v.x; a.ay = _v.y; a.az = _v.z;
        a.t = 0; a.life = 0.1 + r() * 0.2; a.len = 0.5 + r() * 0.9; a.seed = r() * 1000;
        a.next = this.time + a.life + (0.3 + r() * 1.4) * (1 - 0.7 * p.warn);
      }
    }
    // Reaching for a ship that's too close: the telegraph.
    if (p.nearD < 55 && p.state === 'live') {
      _v.subVectors(p.near, p.pos);
      const d = _v.length();
      if (d > 1e-3) {
        _v.divideScalar(d);
        const reach = Math.max(0, d - scale) * (p.nearD < 10 ? 1 : 0.35 + 0.4 * (1 - p.nearD / 55));
        const fl = (0.5 + 0.5 * Math.sin(this.time * 47 + p.seed)) * (1 - p.nearD / 55);
        _p.copy(p.pos).addScaledVector(_v, scale * 0.9);
        arcN = this._writeArc(arcN, _p, _v, reach, Math.floor(this.time * 30) + p.seed, 0.6 + 1.2 * fl, 0.3);
      }
    }
    return arcN;
  }

  /** One jagged arc from `o` along unit `dir` for `len`, brightness k. */
  _writeArc(arcN, o, dir, len, seed, k, jag) {
    if (arcN >= this.maxArcs || len < 0.5 || k <= 0.01) return arcN;
    const rr = mulberryFast(seed);
    _u.crossVectors(dir, Math.abs(dir.y) < 0.9 ? UPV : _r.set(1, 0, 0)).normalize();
    _r.crossVectors(dir, _u).normalize();
    const bb = this.bb, width = Math.max(0.22, Math.min(0.6, len * 0.02));
    let x0 = o.x, y0 = o.y, z0 = o.z;
    for (let s = 1; s <= ARC_SEG; s++) {
      const t = s / ARC_SEG;
      const amp = len * jag * Math.sin(t * Math.PI) * 0.5;
      const ja = (rr() - 0.5) * 2 * amp, jb = (rr() - 0.5) * 2 * amp;
      const x1 = o.x + dir.x * len * t + _u.x * ja + _r.x * jb;
      const y1 = o.y + dir.y * len * t + _u.y * ja + _r.y * jb;
      const z1 = o.z + dir.z * len * t + _u.z * ja + _r.z * jb;
      const kk = k * (1 - (t - 0.5 / ARC_SEG) * 0.6);
      // overlap the joints a little so the bolt reads as one line
      const ex = (x1 - x0) * 0.08, ey = (y1 - y0) * 0.08, ez = (z1 - z0) * 0.08;
      bb.push(x1 + ex, y1 + ey, z1 + ez, C.plArc.r * kk, C.plArc.g * kk, C.plArc.b * kk, 1, width, ARC, 0, 0, x1 - x0 + 2 * ex, y1 - y0 + 2 * ey, z1 - z0 + 2 * ez, 0.0011);
      x0 = x1; y0 = y1; z0 = z1;
    }
    return arcN + 1;
  }

  /** Draw calls this module issues (for budgets). */
  get drawCalls() { return [this.plasmoids, this.bb.mesh, this.skitters.mesh, this.wardens.mesh].filter((o) => o.visible).length; }

  dispose() {
    const s = this.scene;
    s.remove(this.plasmoids); this.plasmoids.geometry.dispose(); this._sphere.dispose(); this.plasmaMat.dispose();
    this.bb.dispose(s);
    for (const b of [this.skitters, this.wardens]) { s.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.dispose(); }
    this.veskMat.dispose();
  }
}

// ------------------------------------------------------------------------------ helpers
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function smooth(a, b, v) { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
function randUnit(r, out) { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return out.set(s * Math.cos(a), s * Math.sin(a), z); }
/** Tiny seeded hash RNG for arc jitter (no allocation beyond the closure state). */
const _fr = { s: 0 };
const _frFn = () => { _fr.s = (_fr.s * 1664525 + 1013904223) >>> 0; return _fr.s / 4294967296; };
function mulberryFast(seed) { _fr.s = (Math.floor(seed * 2654435761) ^ 0x9e3779b9) >>> 0; return _frFn; }
