// Space sky: procedural backdrop baked ONCE into a cube render target (scene.background),
// a PMREM environment from a brightened variant of it, sun + rim + ambient lights,
// crisp camera-relative star points, a bloom-friendly sun disc/corona/glare, and planets
// (procedural surface, sun-lit terminator, Fresnel atmosphere, optional banded ring).

import * as THREE from 'three';
import { rng, hashSeed, GLSL_NOISE } from './util.js';

const STAR_DIST = 16000;   // inside a 20000 far plane
const SUN_DIST = 15000;
const QUALITY = {
  low:    { cube: 512,  env: 128, stars: 2600, planetSeg: [64, 40] },
  medium: { cube: 1024, env: 256, stars: 4800, planetSeg: [96, 64] },
  high:   { cube: 1024, env: 256, stars: 7200, planetSeg: [128, 80] },
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// ---------------------------------------------------------------- backdrop bake shader
const BACKDROP_VS = /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BACKDROP_FS = /* glsl */`
uniform vec3 uSpace, uNeb1, uNeb2, uBandN, uSunDir, uSunCol, uAmbient;
uniform float uNebStrength, uStarDensity, uSeed, uEnv;
varying vec3 vDir;
${GLSL_NOISE}
float starLayer(vec3 d, float scale, float density, float seed){
  vec3 p = d * scale; vec3 c = floor(p); vec3 f = fract(p);
  float acc = 0.0;
  // check the cell + nearest neighbours along the dominant axes for smooth discs
  for (int k = 0; k < 8; k++){
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1)) - step(f, vec3(0.5));
    vec3 cc = c + o;
    float h = sw_hash13(cc + seed);
    if (h > density) continue;
    vec3 jp = cc + 0.2 + 0.6 * sw_hash33(cc + seed * 1.7);
    float dd = length(p - jp);
    float b = pow(sw_hash13(cc + seed + 7.0), 3.0);
    acc += (0.25 + b) * exp(-dd * dd * 9.0);
  }
  return acc;
}
void main(){
  vec3 d = normalize(vDir);
  vec3 q = d * 2.0 + vec3(uSeed, uSeed * 0.37, -uSeed * 0.61);
  vec3 col = uSpace;

  // ---- faint galactic band (diffuse glow + dust lanes) ----
  float bh = dot(d, uBandN);
  float band = exp(-bh * bh * 22.0);
  float bandWide = exp(-bh * bh * 5.0);
  float bandTex = sw_fbm(q * 4.5 + 3.0, 6);
  float lanes = smoothstep(0.48, 0.66, sw_fbm(q * 7.0 + 11.0, 5)) * exp(-bh * bh * 70.0);
  vec3 bandCol = mix(vec3(0.95, 0.86, 0.74), uNeb1 * 3.0, 0.18);
  col += bandCol * (band * (0.25 + bandTex * bandTex * 1.6) * 0.016 + bandWide * 0.0035) * (1.0 - lanes * 0.9);

  // ---- nebulae: domain-warped fbm, confined to a few large regions ----
  vec3 w = vec3(sw_fbm(q * 1.2, 4), sw_fbm(q * 1.2 + 5.2, 4), sw_fbm(q * 1.2 + 9.7, 4)) - 0.5;
  float n1 = sw_fbm(q * 1.5 + w * 2.6, 7);
  float n2 = sw_fbm(q * 1.9 - w * 2.2 + 21.0, 7);
  float m1 = smoothstep(0.40, 0.68, sw_fbm(d * 1.1 + uSeed * 0.71, 4));
  float m2 = smoothstep(0.42, 0.70, sw_fbm(d * 1.25 + uSeed * 1.31 + 40.0, 4));
  float c1 = pow(smoothstep(0.30, 0.80, n1), 2.4) * m1;
  float c2 = pow(smoothstep(0.30, 0.80, n2), 2.4) * m2;
  float fil = 1.0 - abs(sw_fbm(q * 3.6 + w * 3.5, 6) * 2.0 - 1.0);
  fil = pow(fil, 7.0);
  float darkDust = smoothstep(0.52, 0.72, sw_fbm(q * 3.2 + 7.0 + w, 6));
  vec3 neb = uNeb1 * (c1 * 0.10 + fil * c1 * 0.12) + uNeb2 * (c2 * 0.085 + fil * c2 * 0.10);
  // bright hot cores where both overlap
  neb += mix(uNeb1, uNeb2, 0.5) * pow(c1 * c2, 1.5) * 0.25 + vec3(0.9, 0.85, 1.0) * pow(max(c1, c2) * fil, 3.0) * 0.03;
  neb *= 1.0 - darkDust * 0.75;
  col += neb * uNebStrength;
  col *= 1.0 - 0.55 * darkDust * max(max(c1, c2), band * 0.6);

  // ---- faint unresolved stars (crisp bright stars are drawn as points) ----
  float s1 = starLayer(d, 320.0, 0.055 * uStarDensity * (0.6 + 1.2 * bandWide), uSeed);
  float s2 = starLayer(d, 720.0, 0.10 * uStarDensity * (0.35 + 2.0 * band), uSeed + 3.1);
  float tint = sw_vnoise(d * 40.0);
  col += mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.78), tint) * (s1 * 0.035 + s2 * 0.016);

  if (uEnv > 0.5) {
    // environment variant: lifted so metals pick up the nebula, plus broad sun glow + ambient tint
    col = col * 3.0 + uAmbient * (0.035 + 0.02 * d.y);
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunCol * (pow(sd, 64.0) * 2.0 + pow(sd, 6.0) * 0.06);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- stars
const STAR_VS = /* glsl */`
attribute float aSize; attribute vec3 aColor; uniform float uPx; varying vec3 vC;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uPx; vC = aColor; }`;
const STAR_FS = /* glsl */`
varying vec3 vC;
void main(){ vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c); float a = exp(-r2 * 5.0) - 0.0067; if (a <= 0.0) discard; gl_FragColor = vec4(vC * a, 1.0); }`;

// ---------------------------------------------------------------- sun
const BILLBOARD_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SUN_FS = /* glsl */`
uniform vec3 uCol; uniform float uDisc, uI; varying vec2 vUv;
void main(){
  float r = length(vUv);
  float disc = smoothstep(uDisc, uDisc * 0.92, r);
  float limb = 1.0 - 0.35 * pow(clamp(r / uDisc, 0.0, 1.0), 3.0);
  float corona = exp(-max(r - uDisc, 0.0) * 22.0) * 1.3 + exp(-r * 6.0) * 0.4 + exp(-r * 2.4) * 0.09;
  float ang = atan(vUv.y, vUv.x);
  float rays = pow(abs(cos(ang * 3.0 + 0.4)), 60.0) * exp(-r * 5.0) * 0.18 + pow(abs(cos(ang * 2.0)), 300.0) * exp(-r * 2.4) * 0.12;
  vec3 hot = mix(uCol, vec3(1.0), 0.6);
  vec3 col = hot * disc * limb * 24.0 + uCol * (corona + rays) * 1.6;
  col *= smoothstep(1.0, 0.75, r) * uI;
  gl_FragColor = vec4(col, 1.0);
}`;
const GLARE_FS = /* glsl */`
uniform vec3 uCol; uniform float uI; uniform vec2 uAspect; varying vec2 vUv;
void main(){
  float r = length(vUv);
  float veil = exp(-r * 4.5) * 0.16 + exp(-r * 1.6) * 0.035;
  float streak = exp(-abs(vUv.y) * 160.0) * exp(-abs(vUv.x) * 3.2) * 0.22;
  vec3 col = uCol * (veil + streak) * smoothstep(1.0, 0.7, r) * uI;
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- planets
const RING_FN = /* glsl */`
float sw_ringDensity(float x, float seed){
  if (x < 0.0 || x > 1.0) return 0.0;
  float d = 0.55;
  d += 0.55 * (sw_vnoise(vec3(x * 9.0, seed, 0.5)) - 0.5);
  d += 0.45 * (sw_vnoise(vec3(x * 37.0, seed, 3.5)) - 0.5);
  d += 0.30 * (sw_vnoise(vec3(x * 140.0, seed, 7.5)) - 0.5);
  d += 0.18 * (sw_vnoise(vec3(x * 520.0, seed, 9.5)) - 0.5);
  d *= smoothstep(0.0, 0.08, x) * smoothstep(1.0, 0.8, x);
  d *= 1.0 - 0.95 * smoothstep(0.035, 0.0, abs(x - 0.64));
  d *= 1.0 - 0.6 * smoothstep(0.012, 0.0, abs(x - 0.3));
  d *= mix(0.35, 1.0, smoothstep(0.1, 0.34, x));
  return clamp(d, 0.0, 1.0);
}`;
const PLANET_VS = /* glsl */`
varying vec3 vN; varying vec3 vP; varying vec3 vO;
void main(){ vO = position; vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const PLANET_FS = /* glsl */`
uniform vec3 uSun, uSunCol, uC1, uC2, uAtmo, uCenter, uRingN;
uniform float uR, uType, uSeed, uSunI, uHasRing, uRingIn, uRingOut, uTime;
varying vec3 vN; varying vec3 vP; varying vec3 vO;
${GLSL_NOISE}
${RING_FN}
void main(){
  vec3 n = normalize(vN); vec3 v = normalize(cameraPosition - vP); vec3 o = normalize(vO);
  vec3 sd = vec3(uSeed, uSeed * 0.61, uSeed * 1.37);
  vec3 alb; float spec = 0.0;
  if (uType < 0.5) {
    // gas giant: latitudinal bands with turbulent edges and a storm
    float lat = o.y;
    float turb = sw_fbm(vec3(o.x * 2.0, lat * 7.0, o.z * 2.0) + sd, 5);
    float b = lat * 7.5 + (turb - 0.5) * 3.0;
    float bands = 0.5 + 0.5 * sin(b * 3.3 + sin(lat * 19.0 + sd.x) * 0.8);
    float fine = sw_fbm(vec3(o.x * 3.0 + turb, lat * 46.0, o.z * 3.0 + turb), 4);
    alb = mix(uC2, uC1, smoothstep(0.15, 0.85, bands));
    alb = mix(alb, mix(uC1, vec3(0.95, 0.9, 0.85), 0.4), smoothstep(0.55, 0.8, fine) * 0.45);
    alb *= 0.85 + 0.3 * fine;
    vec3 sc = normalize(vec3(0.7, -0.32, 0.64));
    float storm = smoothstep(0.16, 0.05, length((o - sc) * vec3(1.0, 1.8, 1.0)) + (turb - 0.5) * 0.06);
    alb = mix(alb, uC2 * 1.25 + vec3(0.05, 0.02, 0.0), storm * 0.85);
    alb *= 1.0 - 0.25 * smoothstep(0.75, 1.0, abs(lat));
  } else if (uType < 1.5) {
    // rocky / terran: continents, oceans, ice caps, clouds
    float h = sw_fbm(o * 2.1 + sd, 7);
    float land = smoothstep(0.495, 0.515, h);
    vec3 ocean = uC2 * (0.55 + 0.45 * smoothstep(0.30, 0.49, h));
    float lv = sw_fbm(o * 9.0 + sd * 2.0, 4);
    vec3 ground = mix(uC1, uC1 * vec3(0.75, 0.7, 0.62) + vec3(0.03), lv) * (0.75 + 0.5 * smoothstep(0.5, 0.7, h));
    alb = mix(ocean, ground, land);
    float cap = smoothstep(0.78, 0.86, abs(o.y) + (h - 0.5) * 0.4);
    alb = mix(alb, vec3(0.85, 0.88, 0.9), cap);
    float cl = sw_fbm(o * 3.5 + sd + vec3(uTime * 0.002, 0.0, 0.0) + sw_fbm(o * 6.0, 3) * 0.6, 6);
    float clouds = smoothstep(0.52, 0.7, cl);
    alb = mix(alb, vec3(0.86, 0.88, 0.9), clouds * 0.85);
    spec = (1.0 - land) * (1.0 - clouds) * (1.0 - cap);
  } else {
    // ice world: pale with dark crack lines
    float h = sw_fbm(o * 2.6 + sd, 6);
    float cr = 1.0 - abs(sw_fbm(o * 5.0 + sd + 3.0, 5) * 2.0 - 1.0);
    cr = pow(cr, 14.0);
    alb = mix(uC1, uC2, smoothstep(0.35, 0.65, h));
    alb = mix(alb, uC2 * 0.55, cr * 0.75);
    spec = 0.25;
  }
  float ndl = dot(n, uSun);
  float diff = clamp((ndl + 0.04) / 1.04, 0.0, 1.0);
  // ring shadow cast on the planet
  if (uHasRing > 0.5) {
    float dn = dot(uSun, uRingN);
    if (abs(dn) > 1e-3) {
      float t = dot(uCenter - vP, uRingN) / dn;
      if (t > 0.0) {
        float r = length(vP + uSun * t - uCenter) / uR;
        diff *= 1.0 - 0.75 * sw_ringDensity((r - uRingIn) / (uRingOut - uRingIn), uSeed);
      }
    }
  }
  vec3 col = alb * diff * uSunI * uSunCol;
  vec3 hv = normalize(uSun + v);
  col += uSunCol * uSunI * spec * pow(max(dot(n, hv), 0.0), 80.0) * 0.35 * step(0.0, ndl);
  // atmospheric scattering near the limb, lit side only
  float nv = max(dot(n, v), 0.0);
  float fres = pow(1.0 - nv, 3.0);
  float litA = smoothstep(-0.2, 0.55, ndl);
  col = mix(col, uAtmo * uSunI * 0.45, fres * litA * 0.75);
  col += uAtmo * uSunI * 0.06 * pow(1.0 - nv, 1.5) * litA;
  col += alb * 0.0025;
  gl_FragColor = vec4(col, 1.0);
}`;
const ATMO_VS = /* glsl */`varying vec3 vP; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const ATMO_FS = /* glsl */`
uniform vec3 uCenter, uSun, uAtmo; uniform float uR, uRs, uI; varying vec3 vP;
void main(){
  vec3 ro = cameraPosition; vec3 rd = normalize(vP - ro);
  float t = max(dot(uCenter - ro, rd), 0.0);
  vec3 cp = ro + rd * t; float b = length(cp - uCenter);
  float h = clamp((b - uR) / (uRs - uR), 0.0, 1.0);
  float dens = exp(-h * 5.5) * (1.0 - h);
  vec3 up = (cp - uCenter) / max(b, 1e-3);
  float mu = dot(up, uSun);
  float lit = smoothstep(-0.28, 0.55, mu);
  float fwd = pow(max(dot(rd, uSun), 0.0), 8.0) * smoothstep(-0.6, 0.1, mu);
  vec3 col = uAtmo * dens * (lit * 0.55 + fwd * 1.4) * uI;
  gl_FragColor = vec4(col, 1.0);
}`;
const RING_VS = /* glsl */`varying vec3 vP; varying vec3 vL; void main(){ vL = position; vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const RING_FS = /* glsl */`
uniform vec3 uCenter, uSun, uSunCol, uC, uN; uniform float uR, uIn, uOut, uSunI, uSeed; varying vec3 vP; varying vec3 vL;
${GLSL_NOISE}
${RING_FN}
void main(){
  float r = length(vL.xy) / uR;
  float x = (r - uIn) / (uOut - uIn);
  float dens = sw_ringDensity(x, uSeed);
  if (dens < 0.01) discard;
  vec3 oc = vP - uCenter; float bq = dot(oc, uSun); float c = dot(oc, oc) - uR * uR; float disc = bq * bq - c;
  float sh = (bq < 0.0 && disc > 0.0) ? smoothstep(0.0, uR * uR * 0.02, disc) : 0.0;
  float sunSide = sign(dot(uN, uSun)); float camSide = sign(dot(uN, cameraPosition - vP));
  float lit = (0.3 + 0.7 * abs(dot(uN, uSun))) * (sunSide == camSide ? 1.0 : 0.45);
  float tone = 0.7 + 0.45 * sw_vnoise(vec3(x * 23.0, uSeed, 2.0)) + 0.15 * sw_vnoise(vec3(x * 90.0, uSeed, 5.0));
  vec3 col = uC * tone * lit * uSunI * uSunCol * (1.0 - sh * 0.94);
  gl_FragColor = vec4(col, dens * 0.72);
}`;

function hexColor(h, fallback = '#000000') { return new THREE.Color(h ?? fallback); }

export class SpaceSky {
  constructor(renderer, scene, theme, { quality = 'high' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.theme = theme;
    this.q = QUALITY[quality] || QUALITY.high;
    this._sunDir = new THREE.Vector3(...(theme.sun?.dir || [0.4, 0.5, -0.7])).normalize();
    this._seed = theme.seed ?? hashSeed(theme.space, ...(theme.nebula || []));
    this._time = 0;
    this._disposables = [];
    this._planets = [];

    this.group = new THREE.Group();      // world-anchored: lights
    this.group.name = 'SpaceSky';
    this.planetGroup = new THREE.Group(); // follows the camera partially (parallax) -> reads as very far
    this.camGroup = new THREE.Group();    // follows the camera fully: stars, sun billboards
    scene.add(this.group, this.planetGroup, this.camGroup);
    this.planetFollow = theme.planetFollow ?? 0.9;

    this._bake();
    this._lights();
    this._stars();
    this._sun();
    for (const p of theme.planets || []) this._planet(p);
    if (theme.fog && theme.fog.density > 0) scene.fog = new THREE.FogExp2(hexColor(theme.fog.color, '#0a0f1f'), theme.fog.density);
  }

  get sunDirection() { return this._sunDir; }

  _track(o) { this._disposables.push(o); return o; }

  // ---------------------------------------------------------------- bake
  _bake() {
    const t = this.theme;
    const r = rng(this._seed);
    // galactic band plane: tilted, roughly not aligned with the sun
    const bandN = new THREE.Vector3(r() - 0.5, 1.6, r() - 0.5).normalize().applyAxisAngle(new THREE.Vector3(1, 0, 0), (r() - 0.5) * 1.4);
    this._bandN = bandN;
    const uniforms = {
      uSpace: { value: hexColor(t.space, '#04060d') },
      uNeb1: { value: hexColor(t.nebula?.[0], '#23408f') },
      uNeb2: { value: hexColor(t.nebula?.[1], '#8f2f5e') },
      uNebStrength: { value: t.nebulaStrength ?? 0.55 },
      uStarDensity: { value: t.starDensity ?? 1 },
      uSeed: { value: (this._seed % 997) / 31.7 },
      uBandN: { value: bandN },
      uSunDir: { value: this._sunDir },
      uSunCol: { value: hexColor(t.sun?.color, '#fff1dc') },
      uAmbient: { value: hexColor(t.ambient, '#33405f') },
      uEnv: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: BACKDROP_VS, fragmentShader: BACKDROP_FS, side: THREE.BackSide, depthWrite: false, depthTest: false });
    const geo = new THREE.SphereGeometry(10, 64, 32);
    const bakeScene = new THREE.Scene();
    bakeScene.add(new THREE.Mesh(geo, mat));

    const opts = { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter };
    this.cubeRT = new THREE.WebGLCubeRenderTarget(this.q.cube, opts);
    const cam = new THREE.CubeCamera(0.1, 100, this.cubeRT);
    const prevTarget = this.renderer.getRenderTarget();
    cam.update(this.renderer, bakeScene);

    // environment variant (small) -> PMREM
    uniforms.uEnv.value = 1;
    const envRT = new THREE.WebGLCubeRenderTarget(this.q.env, { type: THREE.HalfFloatType });
    const envCam = new THREE.CubeCamera(0.1, 100, envRT);
    envCam.update(this.renderer, bakeScene);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromCubemap(envRT.texture);
    pmrem.dispose();
    envRT.dispose();
    this.renderer.setRenderTarget(prevTarget);
    geo.dispose(); mat.dispose();

    this.scene.background = this.cubeRT.texture;
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = t.envIntensity ?? 1;
  }

  // ---------------------------------------------------------------- lights
  _lights() {
    const t = this.theme;
    const sun = new THREE.DirectionalLight(hexColor(t.sun?.color, '#fff1dc'), t.sun?.intensity ?? 3.2);
    sun.position.copy(this._sunDir).multiplyScalar(1000);
    sun.name = 'sun';
    this.sunLight = sun;
    const amb = hexColor(t.ambient, '#33405f');
    const hemi = new THREE.HemisphereLight(amb, amb.clone().multiplyScalar(0.35), t.ambientIntensity ?? 0.5);
    this.hemiLight = hemi;
    // cool rim/back light from roughly opposite the sun: keeps silhouettes readable on the night side
    const rimCol = t.rim?.color ? hexColor(t.rim.color) : hexColor(t.nebula?.[0], '#23408f').lerp(new THREE.Color('#9fb6ff'), 0.6);
    const rim = new THREE.DirectionalLight(rimCol, t.rim?.intensity ?? 0.9);
    const rd = t.rim?.dir ? new THREE.Vector3(...t.rim.dir) : new THREE.Vector3(-this._sunDir.x, 0.35 - this._sunDir.y * 0.4, -this._sunDir.z);
    rim.position.copy(rd.normalize()).multiplyScalar(1000);
    this.rimLight = rim;
    this.group.add(sun, hemi, rim);
  }

  // ---------------------------------------------------------------- stars
  _stars() {
    const t = this.theme;
    const r = rng(this._seed ^ 0x51ed);
    const n = Math.round(this.q.stars * (t.starDensity ?? 1));
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const palette = [
      [0.70, 0.80, 1.00], [0.80, 0.87, 1.00], [1.00, 1.00, 1.00], [1.00, 0.96, 0.88],
      [1.00, 0.90, 0.74], [1.00, 0.78, 0.56], [1.00, 0.62, 0.45],
    ];
    const weights = [0.10, 0.18, 0.24, 0.20, 0.14, 0.10, 0.04];
    const bn = this._bandN;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      // uniform sphere, with ~30% of stars pulled toward the galactic band
      tmp.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      while (tmp.lengthSq() > 1 || tmp.lengthSq() < 1e-4) tmp.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
      tmp.normalize();
      if (r() < 0.3) {
        const h = tmp.dot(bn);
        const g = (r() + r() + r() - 1.5) * 0.14;
        tmp.addScaledVector(bn, g - h).normalize();
      }
      tmp.multiplyScalar(STAR_DIST);
      pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z;
      const m = Math.pow(r(), 9);          // few bright, many faint
      let w = r(), k = 0;
      while (k < weights.length - 1 && w > weights[k]) { w -= weights[k]; k++; }
      const c = palette[k];
      const sat = m > 0.15 ? 1 : 0.55;     // faint stars nearly white, bright ones show colour
      const b = 0.16 + 0.55 * r() * r() + 3.2 * m;
      for (let j = 0; j < 3; j++) col[i * 3 + j] = (1 + (c[j] - 1) * sat) * b;
      size[i] = 1.25 + 0.6 * r() + 2.6 * Math.sqrt(m);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), STAR_DIST * 1.01);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: this.renderer.getPixelRatio() } },
      vertexShader: STAR_VS, fragmentShader: STAR_FS,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -10;
    this.stars = pts;
    this._track(geo); this._track(mat);
    this.camGroup.add(pts);
  }

  // ---------------------------------------------------------------- sun
  _sun() {
    const t = this.theme;
    const size = t.sun?.size ?? 1;
    const col = hexColor(t.sun?.color, '#fff1dc');
    const discAng = 0.0085 * size;             // angular radius (rad)
    const half = SUN_DIST * Math.tan(discAng) * 7;
    const quad = this._track(new THREE.PlaneGeometry(2, 2));
    const sunMat = this._track(new THREE.ShaderMaterial({
      uniforms: { uCol: { value: col }, uDisc: { value: 1 / 7 }, uI: { value: 1 } },
      vertexShader: BILLBOARD_VS, fragmentShader: SUN_FS,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    const sun = new THREE.Mesh(quad, sunMat);
    sun.scale.setScalar(half);
    sun.frustumCulled = false;
    sun.renderOrder = -5;
    const glareMat = this._track(new THREE.ShaderMaterial({
      uniforms: { uCol: { value: col }, uI: { value: 1 }, uAspect: { value: new THREE.Vector2(1, 1) } },
      vertexShader: BILLBOARD_VS, fragmentShader: GLARE_FS,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
    }));
    const glare = new THREE.Mesh(quad, glareMat);
    glare.scale.setScalar(SUN_DIST * Math.tan(discAng) * 70);
    glare.frustumCulled = false;
    glare.renderOrder = 50;
    this.sunMesh = sun; this.glareMesh = glare;
    this._sunAng = discAng;
    this._glare = 1;
    this.camGroup.add(sun, glare);
  }

  // ---------------------------------------------------------------- planets
  _planet(p) {
    const t = this.theme;
    const seed = hashSeed(p.pos.join(','), p.radius, p.type);
    const r = rng(seed);
    const R = p.radius;
    const typeId = p.type === 'rocky' ? 1 : p.type === 'ice' ? 2 : 0;
    const sunCol = hexColor(t.sun?.color, '#fff1dc');
    const sunI = (t.sun?.intensity ?? 3.2) / Math.PI;
    const pivot = new THREE.Group();
    pivot.position.set(...p.pos);
    if (p.ring?.tilt) pivot.rotation.set(...p.ring.tilt);
    else pivot.rotation.set((r() - 0.5) * 0.7, r() * 6.28, (r() - 0.5) * 0.7);
    this.planetGroup.add(pivot);
    const center = new THREE.Vector3();
    const ringN = new THREE.Vector3(0, 1, 0);
    const atmoCol = hexColor(p.atmosphere, '#9fc4ff');

    const [ws, hs] = this.q.planetSeg;
    const geo = this._track(new THREE.SphereGeometry(1, ws, hs));
    const mat = this._track(new THREE.ShaderMaterial({
      uniforms: {
        uSun: { value: this._sunDir }, uSunCol: { value: sunCol }, uSunI: { value: sunI },
        uC1: { value: hexColor(p.color, '#c98a52') }, uC2: { value: hexColor(p.color2 ?? p.color, '#7a4a2a') },
        uAtmo: { value: atmoCol }, uCenter: { value: center }, uR: { value: R },
        uType: { value: typeId }, uSeed: { value: (seed % 1000) / 13.7 }, uTime: { value: 0 },
        uHasRing: { value: p.ring ? 1 : 0 }, uRingIn: { value: p.ring?.inner ?? 1.4 }, uRingOut: { value: p.ring?.outer ?? 2.2 }, uRingN: { value: ringN },
      },
      vertexShader: PLANET_VS, fragmentShader: PLANET_FS,
    }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(R);
    mesh.renderOrder = -8;
    pivot.add(mesh);

    // atmosphere shell
    const Rs = R * (p.atmosphereScale ?? 1.07);
    const ageo = this._track(new THREE.SphereGeometry(1, 72, 48));
    const amat = this._track(new THREE.ShaderMaterial({
      uniforms: { uCenter: { value: center }, uSun: { value: this._sunDir }, uAtmo: { value: atmoCol }, uR: { value: R }, uRs: { value: Rs }, uI: { value: (p.atmosphereIntensity ?? 1) * sunI } },
      vertexShader: ATMO_VS, fragmentShader: ATMO_FS, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    const atmo = new THREE.Mesh(ageo, amat);
    atmo.scale.setScalar(Rs);
    pivot.add(atmo);

    let ring = null;
    if (p.ring) {
      const rgeo = this._track(new THREE.RingGeometry(R * p.ring.inner, R * p.ring.outer, 160, 1));
      const rmat = this._track(new THREE.ShaderMaterial({
        uniforms: {
          uCenter: { value: center }, uSun: { value: this._sunDir }, uSunCol: { value: sunCol }, uC: { value: hexColor(p.ring.color, '#d9b48a') },
          uN: { value: ringN }, uR: { value: R }, uIn: { value: p.ring.inner }, uOut: { value: p.ring.outer }, uSunI: { value: sunI }, uSeed: { value: (seed % 1000) / 13.7 },
        },
        vertexShader: RING_VS, fragmentShader: RING_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      }));
      ring = new THREE.Mesh(rgeo, rmat);
      ring.rotation.x = -Math.PI / 2;     // XY ring -> equatorial plane (normal = pivot Y)
      pivot.add(ring);
    }
    this._planets.push({ pivot, mesh, atmo, ring, center, ringN, R, mat, spin: (r() * 0.5 + 0.5) * 0.004 });
  }

  // ---------------------------------------------------------------- per frame
  update(camera, dt = 0) {
    this._time += dt;
    const cp = camera.position;
    this.camGroup.position.copy(cp);
    this.planetGroup.position.copy(cp).multiplyScalar(this.planetFollow);
    this.stars.material.uniforms.uPx.value = this.renderer.getPixelRatio();

    this.sunMesh.position.copy(this._sunDir).multiplyScalar(SUN_DIST);
    this.sunMesh.quaternion.copy(camera.quaternion);
    this.glareMesh.position.copy(this.sunMesh.position);
    this.glareMesh.quaternion.copy(camera.quaternion);

    // planets: world centre + ring normal for shaders, slow spin
    let occl = 1;
    for (const p of this._planets) {
      p.mesh.rotation.y += p.spin * dt;
      p.pivot.updateMatrixWorld(true);
      p.center.setFromMatrixPosition(p.pivot.matrixWorld);
      p.ringN.set(0, 1, 0).transformDirection(p.pivot.matrixWorld);
      p.mat.uniforms.uTime.value = this._time;
      // analytic sun occlusion (glare fade)
      _v.copy(p.center).sub(cp);
      const dist = _v.length();
      const ang = Math.acos(Math.min(1, Math.max(-1, _v.dot(this._sunDir) / dist)));
      const pr = Math.asin(Math.min(1, p.R / dist));
      occl = Math.min(occl, THREE.MathUtils.smoothstep(ang, pr - this._sunAng * 0.5, pr + this._sunAng * 2.5));
    }
    camera.getWorldDirection(_fwd);
    const facing = THREE.MathUtils.smoothstep(_fwd.dot(this._sunDir), -0.1, 0.75);
    const target = occl * facing;
    this._glare += (target - this._glare) * Math.min(1, dt * 8 || 1);
    this.glareMesh.material.uniforms.uI.value = this._glare;
    this.glareMesh.visible = this._glare > 0.003;
    this.sunMesh.material.uniforms.uI.value = 0.15 + 0.85 * occl;
  }

  dispose() {
    for (const g of [this.group, this.planetGroup, this.camGroup]) this.scene.remove(g);
    for (const d of this._disposables) d.dispose();
    this._disposables.length = 0;
    this.cubeRT?.dispose(); this.envRT?.dispose();
    this.sunLight?.dispose?.(); this.rimLight?.dispose?.(); this.hemiLight?.dispose?.();
    if (this.scene.background === this.cubeRT?.texture) this.scene.background = null;
    this.scene.background = null;
    this.scene.environment = null;
    this.scene.fog = null;
    this._planets.length = 0;
  }
}
