// Materials for the procedural craft.
//
// - A small HDR "studio in space" environment (equirect, generated once and shared). The
//   renderer turns it into a PMREM on first use, so no renderer handle is needed here.
//   Long soft strip lights give paint and metal readable highlights on every side.
// - Hull: one MeshStandardMaterial for the whole opaque craft. A per-vertex paint channel
//   picks colour / metalness / roughness / emission from small uniform arrays, so the
//   design's colours change without touching geometry. Adds a Fresnel rim light in the
//   craft's glow (or team) colour and faint panel seams.
// - Glass: glossy, tinted, more opaque at grazing angles.
// - Flames: every nozzle's plume + hot core merged into one mesh, sized in the shader.
// - Lights: nav lights, tail strobe and the long-range beacon as camera-facing sprites in
//   one draw call; blinking and distance scaling happen in the vertex shader.

import * as THREE from 'three';

export const CH = { PRIMARY: 0, SECONDARY: 1, ACCENT: 2, TRIM: 3, METAL: 4, RECESS: 5, GLOW: 6, HOT: 7 };

// ---------------------------------------------------------------- environment
let _env = null;
export function craftEnvironment() {
  if (_env) return _env;
  const W = 256, H = 128;
  const data = new Uint16Array(W * H * 4);
  const toH = THREE.DataUtils.toHalfFloat;
  const d = new THREE.Vector3();
  const strips = [
    // centre dir, long axis, half-length (rad), half-width (rad), colour * intensity
    { c: [0.2, 1, 0.1], a: [0, 0, 1], L: 0.75, w: 0.13, col: [1.7, 1.65, 1.55] },    // overhead key
    { c: [1, 0.18, 0], a: [0, 0, 1], L: 0.95, w: 0.045, col: [0.75, 0.95, 1.2] },    // side strips
    { c: [-1, 0.18, 0], a: [0, 0, 1], L: 0.95, w: 0.045, col: [0.75, 0.95, 1.2] },
    { c: [0, -0.25, 1], a: [1, 0, 0], L: 0.8, w: 0.06, col: [0.7, 0.55, 1.1] },      // low rear rim
    { c: [0, 0.3, -1], a: [1, 0, 0], L: 0.7, w: 0.05, col: [0.9, 0.85, 0.8] },       // front
    { c: [0.6, -0.75, -0.3], a: [0, 0, 1], L: 0.5, w: 0.05, col: [0.3, 0.33, 0.55] }, // belly fill
  ].map((s) => {
    const c = new THREE.Vector3(...s.c).normalize();
    const a = new THREE.Vector3(...s.a); a.addScaledVector(c, -a.dot(c)).normalize();
    return { c, a, b: new THREE.Vector3().crossVectors(c, a), L: s.L, w: s.w, col: s.col };
  });
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let j = 0; j < H; j++) {
    const lat = ((j + 0.5) / H - 0.5) * Math.PI;
    for (let i = 0; i < W; i++) {
      const lon = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      d.set(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat));
      const y = d.y;
      // space gradient: dark below, cool blue horizon, brighter blue-violet above
      let r, g, b;
      if (y < 0) { const t = -y; r = 0.05 * (1 - t) + 0.01 * t; g = 0.06 * (1 - t) + 0.012 * t; b = 0.11 * (1 - t) + 0.03 * t; }
      else { const t = Math.pow(y, 0.8); r = 0.05 + 0.1 * t; g = 0.06 + 0.12 * t; b = 0.11 + 0.2 * t; }
      // faint warm/cool nebula lobes so reflections are not monochrome
      const neb1 = Math.max(0, d.x * 0.7 + d.z * 0.7) ** 4 * 0.12, neb2 = Math.max(0, -d.x * 0.6 + d.z * -0.8) ** 4 * 0.1;
      r += neb1 * 1.0 + neb2 * 0.5; g += neb1 * 0.35 + neb2 * 0.2; b += neb1 * 0.6 + neb2 * 1.0;
      for (const s of strips) {
        const z = d.dot(s.c);
        if (z <= 0.05) continue;
        const u = Math.atan2(d.dot(s.a), z), v = Math.atan2(d.dot(s.b), z);
        const m = ss(s.L, s.L - 0.08, Math.abs(u)) * ss(s.w, s.w * 0.55, Math.abs(v));
        if (m <= 0) continue;
        r += s.col[0] * m; g += s.col[1] * m; b += s.col[2] * m;
      }
      const k = (j * W + i) * 4;
      data[k] = toH(r); data[k + 1] = toH(g); data[k + 2] = toH(b); data[k + 3] = toH(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _env = tex;
  return tex;
}

// ---------------------------------------------------------------- hull
const MR = [[0.15, 0.42], [0.2, 0.46], [0.12, 0.38], [0.78, 0.42], [0.95, 0.32], [0.3, 0.72], [0, 1], [0, 1]];
const EM = [0, 0, 0, 0, 0, 0, 1.0, 1.25];
// Paint finishes (design.finish): metalness/roughness for the primary, secondary and accent
// channels, plus an iridescent hue shift by view angle. 'standard' is the original look.
const FINISH = {
  standard: { mr: [MR[0], MR[1], MR[2]], iri: 0 },
  metallic: { mr: [[0.72, 0.28], [0.66, 0.32], [0.6, 0.3]], iri: 0 },
  pearl: { mr: [[0.35, 0.2], [0.3, 0.24], [0.3, 0.24]], iri: 0.3 },
  chrome: { mr: [[1, 0.06], [0.95, 0.1], [0.9, 0.1]], iri: 0 },
  iridescent: { mr: [[0.6, 0.18], [0.55, 0.22], [0.5, 0.22]], iri: 1 },
};

// A plain function (not an arrow) so every hull material shares one program: three keys
// programs by onBeforeCompile.toString(), while the uniforms stay per material.
function hullCompile(shader) {
  Object.assign(shader.uniforms, this.userData.uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float chan;\nvarying float vChan;\nvarying vec3 vLocal;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChan = chan;\nvLocal = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform vec3 uPal[8];
uniform vec2 uMR[8];
uniform float uEm[8];
uniform vec3 uRim;
uniform float uRimK, uHot, uPanel, uIri;
varying float vChan;
varying vec3 vLocal;
float sw_seam(float x, float period, float width) {
  float d = abs(fract(x / period + 0.5) - 0.5) * period;
  float fw = fwidth(x);
  return (1.0 - smoothstep(width, width + fw * 1.2, d)) * clamp(1.4 - fw * 14.0, 0.0, 1.0);
}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
int ci = int(vChan + 0.5);
vec3 pc = uPal[ci];
if (ci <= 2) {
  // faint lateral panel seams every 1.3 units
  float seam = sw_seam(vLocal.z + 0.35, 1.3, 0.012);
  pc *= 1.0 - seam * uPanel;
  if (uIri > 0.0 && ci <= 1) {
    // thin-film style hue shift: grazing angles and position along the hull rotate the hue
    float iNV = saturate(dot(normal, normalize(vViewPosition)));
    vec3 film = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + (1.0 - iNV) * 1.3 + vLocal.z * 0.07));
    pc = mix(pc, pc * 0.3 + film * 0.8, uIri * (0.3 + 0.7 * (1.0 - iNV)));
  }
}
diffuseColor.rgb = pc;
metalnessFactor = uMR[ci].x;
roughnessFactor = uMR[ci].y;
float em = uEm[ci] * (ci == 7 ? uHot : 1.0);
if (em > 0.0) { totalEmissiveRadiance = pc * em; diffuseColor.rgb = pc * 0.04; }`)
    .replace('#include <opaque_fragment>', `float swNV = saturate(dot(normal, normalize(vViewPosition)));
float swRim = pow(1.0 - swNV, 2.6);
if (ci < 6) {
  outgoingLight += uRim * (swRim * uRimK);
  // soft highlight knee: sun glints on flat facets stay crisp but under the bloom threshold
  float pk = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b);
  if (pk > 0.68) outgoingLight *= (0.68 + 0.18 * (1.0 - exp(-(pk - 0.68) / 0.18))) / pk;
}
#include <opaque_fragment>`);
}

export function makeHullMaterial(colors, finish = 'standard') {
  const fin = FINISH[finish] || FINISH.standard;
  const u = {
    uPal: { value: Array.from({ length: 8 }, () => new THREE.Color()) },
    uMR: { value: MR.map(([m, r], i) => (i < 3 ? new THREE.Vector2(...fin.mr[i]) : new THREE.Vector2(m, r))) },
    uEm: { value: EM.slice() },
    uRim: { value: new THREE.Color() },
    uRimK: { value: 0.5 },
    uHot: { value: 1 },
    uPanel: { value: 0.32 },
    uIri: { value: fin.iri },
  };
  setPalette(u, colors);
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.4, envMap: craftEnvironment(), envMapIntensity: 1.0 });
  m.userData.uniforms = u;
  m.onBeforeCompile = hullCompile;
  return m;
}

export function setPalette(u, { primary, secondary, glow }) {
  const P = u.uPal.value;
  P[0].copy(primary);
  P[1].copy(secondary);
  P[2].copy(glow).multiplyScalar(0.8);
  P[3].set('#2c3142');
  P[4].set('#aeb6c4');
  P[5].set('#08090f');
  P[6].copy(glow);
  P[7].copy(glow).lerp(new THREE.Color(1, 1, 1), 0.55);
  u.uRim.value.copy(glow);
}

// ---------------------------------------------------------------- glass
function glassCompile(shader) {
  Object.assign(shader.uniforms, this.userData.uniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uRim;\nuniform float uRimK;')
    .replace('#include <opaque_fragment>', `float gNV = saturate(dot(normal, normalize(vViewPosition)));
float gF = pow(1.0 - gNV, 2.0);
diffuseColor.a = mix(diffuseColor.a, 0.97, gF);
outgoingLight += uRim * (pow(1.0 - gNV, 3.0) * uRimK * 0.6);
float gk = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b);
if (gk > 0.6) outgoingLight *= (0.6 + 0.25 * (1.0 - exp(-(gk - 0.6) / 0.25))) / gk;
#include <opaque_fragment>`);
}

export function makeGlassMaterial(glow) {
  const m = new THREE.MeshStandardMaterial({
    color: 0x0c1a2e, metalness: 0.1, roughness: 0.1, transparent: true, opacity: 0.62,
    envMap: craftEnvironment(), envMapIntensity: 1.1, emissive: glow.clone(), emissiveIntensity: 0.05,
  });
  m.userData.uniforms = { uRim: { value: glow.clone() }, uRimK: { value: 0.5 } };
  m.onBeforeCompile = glassCompile;
  return m;
}

// ---------------------------------------------------------------- flames
/** One merged geometry: per nozzle an outer plume + a short hot core. */
export function makeFlameGeometry(nozzles, sides = 12) {
  const RINGS = [0, 0.07, 0.22, 0.45, 0.72, 1];
  const prof = (z) => 0.92 * Math.pow(1 - z, 0.55) + (z < 0.1 ? z * 0.6 : 0.06 * (1 - z));
  const pos = [], nor = [], noz = [], par = [], idx = [];
  let base = 0;
  nozzles.forEach((n, k) => {
    for (const core of [0, 1]) {
      for (let ri = 0; ri < RINGS.length; ri++) {
        const z = RINGS[ri], r = prof(z);
        for (let j = 0; j <= sides; j++) {
          const a = (j / sides) * Math.PI * 2;
          pos.push(Math.cos(a) * r, Math.sin(a) * r, z);
          nor.push(Math.cos(a), Math.sin(a), 0.6);
          noz.push(n.pos.x, n.pos.y, n.pos.z, n.r);
          par.push(k, core);
        }
      }
      for (let ri = 0; ri < RINGS.length - 1; ri++) {
        for (let j = 0; j < sides; j++) {
          const a = base + ri * (sides + 1) + j, b = a + sides + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      base += RINGS.length * (sides + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aNoz', new THREE.Float32BufferAttribute(noz, 4));
  g.setAttribute('aPar', new THREE.Float32BufferAttribute(par, 2));
  g.setIndex(idx);
  let zMax = 0;
  for (const n of nozzles) zMax = Math.max(zMax, n.pos.z);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, zMax + 3), 9);
  return g;
}

export function makeFlameMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: color }, uTime: { value: 0 }, uPower: { value: 0.5 }, uLen: { value: 2 }, uWidth: { value: 0.8 } },
    vertexShader: /* glsl */`
      attribute vec4 aNoz; attribute vec2 aPar;
      uniform float uTime, uLen, uWidth;
      varying float vT, vFace, vCore;
      void main(){
        float core = aPar.y;
        float jit = 0.93 + 0.12 * fract(sin(aPar.x * 17.31 + floor(uTime * 24.0) * 3.77) * 4375.85);
        float len = uLen * jit * (core > 0.5 ? 0.42 : 1.0);
        float wid = aNoz.w * uWidth * (core > 0.5 ? 0.5 : 1.0);
        vec3 p = aNoz.xyz + vec3(position.xy * wid, position.z * len);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFace = abs(dot(n, normalize(-mv.xyz)));
        vT = position.z; vCore = core;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uTime, uPower;
      varying float vT, vFace, vCore;
      void main(){
        float t = clamp(vT, 0.0, 1.0);
        float flick = 0.85 + 0.15 * sin(uTime * 61.0 + vT * 9.0);
        float edge = pow(vFace, vCore > 0.5 ? 1.5 : 2.2);
        float a = pow(1.0 - t, vCore > 0.5 ? 1.4 : 2.0) * edge * flick * uPower;
        vec3 hot = mix(vec3(1.0, 0.97, 0.92), uColor, smoothstep(0.0, vCore > 0.5 ? 0.8 : 0.3, t));
        float k = vCore > 0.5 ? 1.0 : 0.72;
        gl_FragColor = vec4(hot * k * a, 1.0);
      }`,
  });
}

// ---------------------------------------------------------------- nav lights + beacon
export const LIGHT = { NAV: 0, STROBE: 1, BEACON: 2 };

/** lights: [{ pos: Vector3, color: [r,g,b], size, type, phase, minAng }] */
export function makeLightsGeometry(lights) {
  const pos = [], cor = [], col = [], par = [], idx = [];
  lights.forEach((l, i) => {
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(l.pos.x, l.pos.y, l.pos.z); cor.push(cx, cy); col.push(...l.color);
      par.push(l.size, l.type, l.phase || 0, l.minAng);
    }
    const b = i * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(cor, 2));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aPar', new THREE.Float32BufferAttribute(par, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  return g;
}

export function makeLightsMaterial(tint) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    // premultiplied: rgb adds light, alpha darkens what is behind (beacon backing only)
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    uniforms: {
      uTime: { value: 0 }, uPhase: { value: 0 }, uTint: { value: tint.clone() }, uHi: { value: 0 },
      uBeacon: { value: 1 }, uFade: { value: new THREE.Vector2(100, 280) }, uNav: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute vec2 aCorner; attribute vec3 aCol; attribute vec4 aPar;
      uniform float uTime, uPhase, uHi, uBeacon, uNav; uniform vec3 uTint; uniform vec2 uFade;
      varying vec3 vCol; varying vec2 vUv; varying float vCoreK; varying float vDark;
      void main(){
        vDark = 0.0;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = length(mv.xyz);
        float type = aPar.y;
        float size = max(aPar.x, dist * aPar.w);
        float k = 1.0; float pull = 0.22; vec3 col = aCol; vCoreK = 1.0;
        float t = uTime + uPhase + aPar.z;
        if (type < 0.5) {
          // port / starboard: steady with a soft 1 Hz breathe
          k = uNav * (0.6 + 0.4 * (0.5 + 0.5 * sin(t * 6.2832)));
        } else if (type < 1.5) {
          // white strobe: double flash every 1.3 s
          float f = fract(t / 1.3);
          k = uNav * (0.08 + 2.6 * (exp(-pow(f / 0.03, 2.0)) + exp(-pow((f - 0.14) / 0.03, 2.0))));
        } else {
          // long-range beacon: fades in with distance, constant screen size
          col = uTint;
          float fade = smoothstep(uFade.x, uFade.y, dist);
          k = fade * uBeacon * (1.0 + 0.6 * uHi);
          size = dist * aPar.w * (1.0 + 0.35 * uHi);
          pull = 4.0; vCoreK = 1.0; vDark = fade * 0.5;
        }
        mv.xyz += normalize(-mv.xyz) * min(pull, dist * 0.5);
        mv.xy += aCorner * size;
        vCol = col * k; vUv = aCorner;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying vec2 vUv; varying float vCoreK; varying float vDark;
      void main(){
        float r2 = dot(vUv, vUv);
        if (r2 > 1.0) discard;
        float core = exp(-r2 * 18.0) * vCoreK, halo = exp(-r2 * 4.0) * 0.38;
        vec3 c = vCol * (core + halo);
        if (vDark > 0.0) {
          // beacon: white-hot pip, tinted glow, soft dark backing so it reads on bright planets/nebulae
          float pip = exp(-r2 * 60.0);
          c = vCol * (exp(-r2 * 9.0) * 0.9 + halo * 0.6) + vec3(pip) * length(vCol) * 0.55;
        }
        float dark = vDark * smoothstep(1.0, 0.35, r2);
        gl_FragColor = vec4(c, dark);
      }`,
  });
}

// ---------------------------------------------------------------- hangar underglow
let _glowTex = null;
export function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}
