// Space props: breakable asteroids/ice/crystals/cargo/satellites and large indestructible
// structures (wreck, ring station, beacon, monolith). Geometry is merged per material and
// cached per (type, seed, colour); materials and canvas textures are shared. Navigation lights
// are one Points object per prop whose blinking is evaluated on the GPU from a shared clock.

import * as THREE from 'three';
import { rng, hashSeed, GLSL_NOISE } from './util.js';
import { makeRockGeometry, rockMaterial, rockVariants, rockVariantsLOD } from './rocks.js';

export const PROP_TYPES = ['asteroid', 'ice', 'crystal', 'cargo', 'satellite', 'wreck', 'station', 'beacon', 'monolith'];

// ---------------------------------------------------------------- shared clock + registry
const propTime = { value: 0 };
const viewH = { value: 1080 };
const registry = new Set();
const pulseMats = [];     // { mat, base, speed, amp }

export function updateProps(dt) {
  propTime.value += dt;
  const t = propTime.value;
  for (const p of pulseMats) p.mat.emissiveIntensity = p.base * (1 + p.amp * Math.sin(t * p.speed));
  for (const e of registry) {
    if (!e.spinners) continue;
    for (const s of e.spinners) s.obj.rotateOnAxis(s.axis, s.speed * dt);
  }
}

export function disposeProp(prop) {
  if (!prop) return;
  registry.delete(prop._entry);
  prop.object?.parent?.remove(prop.object);
  // geometries/materials/textures are shared caches; nothing per-instance to free
}

// ---------------------------------------------------------------- canvas textures
const texCache = new Map();
function canvasTex(key, w, h, draw, { srgb = true, repeat = true } = {}) {
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  texCache.set(key, t);
  return t;
}

function drawPanels(g, x0, y0, W, H, r, { base = 150, spread = 34, seam = 58, rivets = true, minSize = 56 } = {}) {
  const rects = [];
  const split = (x, y, w, h, d) => {
    if (d > 5 || (w < minSize && h < minSize) || (d > 1 && r() < 0.16)) { rects.push([x, y, w, h]); return; }
    const vertical = w > h ? r() < 0.8 : r() < 0.2;
    if (vertical && w >= minSize) { const k = Math.max(16, Math.round(((0.25 + 0.5 * r()) * w) / 16) * 16); if (k >= w) { rects.push([x, y, w, h]); return; } split(x, y, k, h, d + 1); split(x + k, y, w - k, h, d + 1); }
    else if (h >= minSize) { const k = Math.max(16, Math.round(((0.25 + 0.5 * r()) * h) / 16) * 16); if (k >= h) { rects.push([x, y, w, h]); return; } split(x, y, w, k, d + 1); split(x, y + k, w, h - k, d + 1); }
    else rects.push([x, y, w, h]);
  };
  split(x0, y0, W, H, 0);
  for (const [x, y, w, h] of rects) {
    const v = Math.round(base + (r() - 0.5) * spread);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, w, h);
    // soft inner gradient for subtle panel curvature
    const gr = g.createLinearGradient(x, y, x, y + h);
    gr.addColorStop(0, 'rgba(255,255,255,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0.07)');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    if (r() < 0.1 && w > 40 && h > 30) {   // vent slits
      g.fillStyle = `rgb(${seam},${seam},${seam})`;
      const n = 3 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) g.fillRect(x + 8, y + 8 + i * 6, Math.min(w - 16, 40), 2);
    }
    if (r() < 0.12 && w > 30 && h > 30) {  // access hatch
      g.strokeStyle = `rgba(${seam},${seam},${seam},0.9)`; g.lineWidth = 1;
      g.strokeRect(x + w * 0.3, y + h * 0.3, w * 0.4, h * 0.4);
    }
    g.strokeStyle = `rgb(${seam},${seam},${seam})`; g.lineWidth = 2;
    g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + 3, y + h - 3); g.lineTo(x + 3, y + 3); g.lineTo(x + w - 3, y + 3); g.stroke();
    if (rivets && r() < 0.35) {
      g.fillStyle = `rgba(${seam},${seam},${seam},0.8)`;
      for (let i = x + 8; i < x + w - 4; i += 12) { g.fillRect(i, y + 5, 2, 2); g.fillRect(i, y + h - 7, 2, 2); }
    }
  }
}
function grime(g, w, h, r, amount = 1) {
  for (let i = 0; i < 2600 * amount; i++) {
    const a = r() * 0.08;
    g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a * 0.5})`;
    const s = 1 + r() * 3;
    g.fillRect(r() * w, r() * h, s, s);
  }
  for (let i = 0; i < 18 * amount; i++) {   // streaks
    const x = r() * w, y = r() * h, len = 30 + r() * 120;
    const gr = g.createLinearGradient(x, y, x, y + len);
    gr.addColorStop(0, `rgba(0,0,0,${0.06 + r() * 0.08})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x, y, 2 + r() * 6, len);
  }
}
const panelTex = () => canvasTex('panel', 512, 512, (g, w, h) => { const r = rng(11); drawPanels(g, 0, 0, w, h, r); grime(g, w, h, r); });
const panelBump = () => canvasTex('panelBump', 512, 512, (g, w, h) => { const r = rng(11); drawPanels(g, 0, 0, w, h, r, { spread: 10 }); }, { srgb: false });
const solarTex = () => canvasTex('solar', 256, 256, (g, w, h) => {
  g.fillStyle = '#b8bcc4'; g.fillRect(0, 0, w, h);
  const n = 4, cs = w / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const gr = g.createLinearGradient(i * cs, j * cs, (i + 1) * cs, (j + 1) * cs);
    gr.addColorStop(0, '#1d3a78'); gr.addColorStop(1, '#0e1f47');
    g.fillStyle = gr; g.fillRect(i * cs + 3, j * cs + 3, cs - 6, cs - 6);
    g.fillStyle = 'rgba(190,200,220,0.35)';
    for (let k = 1; k < 4; k++) g.fillRect(i * cs + 3, j * cs + k * cs / 4, cs - 6, 1);
  }
});
const foilBump = () => canvasTex('foil', 256, 256, (g, w, h) => {
  const r = rng(5);
  g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    const v = Math.round(80 + r() * 100);
    g.strokeStyle = `rgba(${v},${v},${v},0.6)`; g.lineWidth = 1 + r() * 2;
    const x = r() * w, y = r() * h, a = r() * 6.28, l = 6 + r() * 28;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
}, { srgb: false });
// habitat ring: u = along the ring (tile = 12 units), v = around the tube (whole circumference)
const HAB_TILE = 12;
function habDraw(emissive) {
  return (g, w, h) => {
    const r = rng(23);
    if (emissive) { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); } else { drawPanels(g, 0, 0, w, h, r, { base: 156, minSize: 48 }); grime(g, w, h, r, 0.7); }
    const r2 = rng(77);
    const rows = [0.04, 0.96, 0.19, 0.235, 0.28, 0.72, 0.765, 0.81, 0.5];
    for (const rv of rows) {
      const y = rv * h;
      for (let x = 6; x < w - 10; x += 21) {
        const lit = r2();
        if (emissive) {
          if (lit < 0.72) { const k = 0.55 + r2() * 0.45; const warm = r2() < 0.85; g.fillStyle = warm ? `rgba(255,${Math.round(205 + 30 * k)},${Math.round(150 + 40 * k)},${k})` : `rgba(170,215,255,${k})`; g.fillRect(x, y - 5, 13, 10); }
        } else { g.fillStyle = '#22262c'; g.fillRect(x - 1, y - 6, 15, 12); }
      }
    }
  };
}
const habTex = () => canvasTex('hab', 256, 1024, habDraw(false));
const habEmit = () => canvasTex('habE', 256, 1024, habDraw(true));
const CARGO_COLORS = { missile: '#c4552b', shield: '#2c78b4', olive: '#6d7744', white: '#c9ccc8' };
function cargoTex(hex, label) {
  return canvasTex(`cargo:${hex}:${label}`, 512, 256, (g, w, h) => {
    const r = rng(hashSeed(hex, label));
    g.fillStyle = hex; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 12) {      // corrugation
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(x, 0, 4, h);
      g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x + 7, 0, 3, h);
    }
    g.fillStyle = 'rgba(235,235,230,0.92)'; g.fillRect(0, h * 0.70, w, h * 0.09);   // stripe
    g.fillStyle = 'rgba(25,25,28,0.9)';
    for (let x = -40; x < w; x += 36) { g.beginPath(); g.moveTo(x, h * 0.70); g.lineTo(x + 16, h * 0.70); g.lineTo(x + 30, h * 0.79); g.lineTo(x + 14, h * 0.79); g.fill(); }
    g.font = '800 50px "Unbounded", "Arial Narrow", Arial, sans-serif';
    g.fillStyle = 'rgba(240,240,236,0.9)';
    g.fillText(label, 34, 92);
    g.font = 'bold 20px Arial, sans-serif';
    g.fillText('STARWAKE FREIGHT  ·  MAX GROSS 32.5T', 36, 124);
    g.strokeStyle = 'rgba(240,240,236,0.8)'; g.lineWidth = 3; g.strokeRect(w - 120, 40, 80, 80);
    g.beginPath(); g.moveTo(w - 80, 52); g.lineTo(w - 52, 104); g.lineTo(w - 108, 104); g.closePath(); g.stroke();
    grime(g, w, h, r, 0.8);
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 6; g.strokeRect(0, 0, w, h);
  });
}
const glyphTex = () => canvasTex('glyph', 256, 1024, (g, w, h) => {
  const r = rng(404);
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round';
  // border inlay
  g.lineWidth = 2; g.globalAlpha = 0.55; g.strokeRect(14, 14, w - 28, h - 28); g.globalAlpha = 1;
  const cols = 2, cw = (w - 60) / cols;
  for (let c = 0; c < cols; c++) {
    let y = 46;
    while (y < h - 70) {
      const x = 30 + c * cw + cw / 2, s = cw * 0.22;
      g.lineWidth = 2 + (r() < 0.3 ? 1 : 0);
      g.globalAlpha = 0.6 + r() * 0.4;
      g.beginPath();
      const k = Math.floor(r() * 5);
      if (k === 0) { g.arc(x, y, s * 0.8, r() * 3, 3 + r() * 3); }
      else if (k === 1) { g.moveTo(x - s, y - s); g.lineTo(x, y + s); g.lineTo(x + s, y - s); }
      else if (k === 2) { g.moveTo(x - s, y); g.lineTo(x + s, y); g.moveTo(x, y - s); g.lineTo(x, y + s * 0.4); }
      else if (k === 3) { g.rect(x - s * 0.6, y - s * 0.6, s * 1.2, s * 1.2); }
      else { g.arc(x, y, s * 0.35, 0, 6.29); g.moveTo(x - s, y + s); g.lineTo(x + s, y + s); }
      g.stroke();
      if (r() < 0.4) { g.beginPath(); g.arc(x + s * 1.1, y - s * 0.9, 2, 0, 6.29); g.fill(); }
      y += s * 2 + 22 + r() * 16 + (r() < 0.4 ? 50 + r() * 110 : 0);
    }
  }
  g.globalAlpha = 0.8; g.lineWidth = 2;
  g.beginPath(); g.moveTo(w / 2, h - 50); g.lineTo(w / 2, h - 20); g.stroke();
  g.globalAlpha = 1;
}, { srgb: true, repeat: false });

// ---------------------------------------------------------------- materials
const matCache = new Map();
function cachedMat(key, make) { if (!matCache.has(key)) { const m = make(); m.userData.shared = true; matCache.set(key, m); } return matCache.get(key); }
function hullMat(key, color, { metal = 0.55, rough = 0.55, bump = 0.6 } = {}) {
  return cachedMat(`hull:${key}`, () => new THREE.MeshStandardMaterial({ color, map: panelTex(), bumpMap: panelBump(), bumpScale: bump, metalness: metal, roughness: rough }));
}
const M = {
  hull: () => hullMat('light', '#c4c8ce', { metal: 0.3, rough: 0.55 }),
  hullDark: () => hullMat('dark', '#79808a', { metal: 0.4, rough: 0.58 }),
  rust: () => hullMat('rust', '#8b7867', { metal: 0.35, rough: 0.78 }),
  scorched: () => hullMat('scorch', '#4a4642', { metal: 0.3, rough: 0.85 }),
  paint: (hex) => hullMat(`paint${hex}`, hex, { metal: 0.25, rough: 0.6 }),
  frame: () => cachedMat('frame', () => new THREE.MeshStandardMaterial({ color: '#5a5f67', metalness: 0.55, roughness: 0.48 })),
  white: () => cachedMat('white', () => new THREE.MeshStandardMaterial({ color: '#b9bdc2', metalness: 0.15, roughness: 0.55 })),
  foil: () => cachedMat('foil', () => new THREE.MeshStandardMaterial({ color: '#e2b456', metalness: 1, roughness: 0.3, bumpMap: foilBump(), bumpScale: 2.5 })),
  solar: () => cachedMat('solar', () => new THREE.MeshStandardMaterial({ color: '#ffffff', map: solarTex(), metalness: 0.55, roughness: 0.28 })),
  glass: () => cachedMat('glass', () => new THREE.MeshStandardMaterial({ color: '#0b121b', metalness: 0.9, roughness: 0.08 })),
  nozzle: () => cachedMat('nozzle', () => new THREE.MeshStandardMaterial({ color: '#25272b', metalness: 0.85, roughness: 0.5 })),
  ember: () => cachedMat('ember', () => new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff5a1e').multiplyScalar(0.14), fog: false })),
  lamp: () => cachedMat('lamp', () => { const m = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }); m.color.setScalar(1.6); return m; }),
  hab: () => cachedMat('hab', () => new THREE.MeshStandardMaterial({ color: '#e2e5e8', map: habTex(), bumpMap: panelBump(), bumpScale: 0.4, emissive: '#ffd7a8', emissiveMap: habEmit(), emissiveIntensity: 1.25, metalness: 0.4, roughness: 0.5 })),
};
function crystalMat(hex) {
  return cachedMat(`crystal:${hex}`, () => {
    const tint = new THREE.Color(hex);
    const m = new THREE.MeshPhysicalMaterial({
      color: tint.clone().multiplyScalar(0.07), emissive: tint, emissiveIntensity: 1.0, vertexColors: true,
      roughness: 0.1, metalness: 0.0, clearcoat: 1, clearcoatRoughness: 0.05, flatShading: true, envMapIntensity: 2.0,
    });
    m.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCrystP;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCrystP = position;');
      s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCrystP;\n' + GLSL_NOISE)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  // cloudy interior with a little view parallax so faces don't read as flat plastic
  vec3 vd = normalize(vViewPosition);
  float cl = sw_fbm(vCrystP * 0.9 + vd * 0.6, 4);
  float vein = pow(1.0 - abs(sw_fbm(vCrystP * 1.7 - vd * 0.4 + 5.0, 3) * 2.0 - 1.0), 10.0);
  totalEmissiveRadiance *= 0.55 + 0.9 * cl + 0.55 * vein;
}
{
  float nv = clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0);
  totalEmissiveRadiance *= (0.1 + 2.3 * pow(1.0 - nv, 2.6)) * vColor.r * vColor.r + pow(vColor.r, 8.0) * 1.4;
}`);
    };
    m.customProgramCacheKey = () => 'sw-crystal';
    pulseMats.push({ mat: m, base: 1.0, speed: 1.6, amp: 0.12 });
    return m;
  });
}
function monolithMat(hex) {
  return cachedMat(`mono:${hex}`, () => {
    const m = new THREE.MeshStandardMaterial({ color: '#0c0d11', metalness: 0.5, roughness: 0.36, emissive: hex, emissiveMap: glyphTex(), emissiveIntensity: 0.32, envMapIntensity: 1.5 });
    pulseMats.push({ mat: m, base: 0.32, speed: 0.9, amp: 0.45 });
    return m;
  });
}

// ---------------------------------------------------------------- light points (GPU-blinked)
const LIGHT_VS = /* glsl */`
attribute vec3 aColor; attribute float aSize; attribute vec4 aBlink;
uniform float uTime, uViewH;
varying vec3 vC; varying float vI;
float sw_blink(vec4 b){
  if (b.w < 0.5) return 1.0;
  float t = fract(uTime / b.x + b.y);
  if (b.w < 1.5) return smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(b.z, b.z + 0.05, t));
  if (b.w < 2.5) return max(1.0 - smoothstep(0.0, 0.035, abs(t - 0.03)), 1.0 - smoothstep(0.0, 0.035, abs(t - 0.13)));
  if (b.w < 3.5) return 0.6 + 0.4 * sin(t * 6.2831853);
  return 0.08 + 0.92 * pow(1.0 - t, 5.0);
}
void main(){
  float k = sw_blink(aBlink);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aSize * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.1);
  gl_PointSize = clamp(px * (0.55 + 0.45 * k), 2.5, 360.0);
  vI = k * clamp(px / 2.5, 0.3, 1.0);
  vC = aColor;
}`;
const LIGHT_FS = /* glsl */`
varying vec3 vC; varying float vI;
void main(){
  vec2 c = gl_PointCoord * 2.0 - 1.0; float r2 = dot(c, c);
  if (r2 > 1.0 || vI < 0.003) discard;
  float g = exp(-r2 * 22.0) * 5.0 + exp(-r2 * 5.0) * 0.45 * (1.0 - r2);
  gl_FragColor = vec4(vC * g * vI, 1.0);
}`;
let lightMat = null;
const _vp = new THREE.Vector4();
function getLightMat() {
  if (!lightMat) {
    lightMat = new THREE.ShaderMaterial({
      uniforms: { uTime: propTime, uViewH: viewH },
      vertexShader: LIGHT_VS, fragmentShader: LIGHT_FS,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    });
  }
  return lightMat;
}
function onLightsRender(renderer) { renderer.getCurrentViewport(_vp); viewH.value = _vp.w || 1080; }

// blink modes
const STEADY = 0, BLINK = 1, STROBE = 2, PULSE = 3, CHASE = 4;

// ---------------------------------------------------------------- geometry builder
const _mtx = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _pv = new THREE.Vector3();
const _qv = new THREE.Quaternion();
const _sv = new THREE.Vector3();
const _ev = new THREE.Euler();
function mtx(p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  _ev.set(r[0], r[1], r[2]);
  return new THREE.Matrix4().compose(_pv.set(p[0], p[1], p[2]), _qv.setFromEuler(_ev), _sv.set(...(typeof s === 'number' ? [s, s, s] : s)));
}
/** Matrix orienting local +Y along `dir` placed at `pos` (for cylinders/struts). */
function alongY(pos, dir, sx = 1, sy = 1, sz = 1) {
  const d = new THREE.Vector3(...dir).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  return new THREE.Matrix4().compose(new THREE.Vector3(...pos), q, new THREE.Vector3(sx, sy, sz));
}

class Builder {
  constructor() { this.groups = new Map(); this.lights = []; this.spinGroups = new Map(); }
  add(mat, geo, m = null, color = null, spin = null) {
    const key = spin ? `${mat.uuid}|spin:${spin}` : mat.uuid;
    if (!this.groups.has(key)) this.groups.set(key, { mat, parts: [], spin });
    this.groups.get(key).parts.push({ geo, m: m || new THREE.Matrix4(), color });
    return this;
  }
  light(pos, color, size = 1, blink = [1, 0, 1, STEADY]) { this.lights.push({ pos, color: new THREE.Color(color), size, blink }); return this; }
  build() {
    const meshes = [];
    let tris = 0;
    for (const { mat, parts, spin } of this.groups.values()) {
      const geo = mergeParts(parts);
      tris += geo.index.count / 3;
      meshes.push({ geo, mat, spin });
    }
    let lights = null;
    if (this.lights.length) {
      const n = this.lights.length;
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), bl = new Float32Array(n * 4);
      this.lights.forEach((l, i) => {
        pos.set(l.pos, i * 3); col.set([l.color.r, l.color.g, l.color.b], i * 3); size[i] = l.size; bl.set(l.blink, i * 4);
      });
      lights = new THREE.BufferGeometry();
      lights.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      lights.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      lights.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      lights.setAttribute('aBlink', new THREE.BufferAttribute(bl, 4));
      lights.computeBoundingSphere();
    }
    return { meshes, lights, tris };
  }
}

function mergeParts(parts) {
  let nV = 0, nI = 0, hasColor = false;
  for (const p of parts) {
    nV += p.geo.attributes.position.count;
    nI += p.geo.index ? p.geo.index.count : p.geo.attributes.position.count;
    if (p.color || p.geo.attributes.color) hasColor = true;
  }
  const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), uv = new Float32Array(nV * 2);
  const col = hasColor ? new Float32Array(nV * 3) : null;
  const idx = nV > 65535 ? new Uint32Array(nI) : new Uint16Array(nI);
  let vo = 0, io = 0;
  const v = new THREE.Vector3();
  for (const p of parts) {
    const g = p.geo, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color;
    _nm.getNormalMatrix(p.m);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(p.m); pos.set([v.x, v.y, v.z], (vo + i) * 3);
      if (N) { v.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize(); nor.set([v.x, v.y, v.z], (vo + i) * 3); }
      if (U) { uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i); }
      if (col) {
        if (p.color) col.set([p.color.r, p.color.g, p.color.b], (vo + i) * 3);
        else if (C) col.set([C.getX(i), C.getY(i), C.getZ(i)], (vo + i) * 3);
        else col.set([1, 1, 1], (vo + i) * 3);
      }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
    else for (let i = 0; i < P.count; i++) idx[io + i] = i + vo;
    io += g.index ? g.index.count : P.count;
    vo += P.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// world-scaled UV primitives (tile = units per texture repeat)
function box(w, h, d, tile = 8) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, uv.getX(k) * dims[f][0] / tile, uv.getY(k) * dims[f][1] / tile); }
  return g;
}
function cyl(rt, rb, h, seg = 16, tile = 8, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  const uv = g.attributes.uv, c = Math.PI * (rt + rb);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * c / tile, uv.getY(i) * h / tile);
  return g;
}
function torus(R, r, rs, ts, tile = 8, uOnly = false) {
  const g = new THREE.TorusGeometry(R, r, rs, ts);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.round(2 * Math.PI * R / tile), uOnly ? uv.getY(i) : uv.getY(i) * 2 * Math.PI * r / tile);
  return g;
}
const sphere = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
/** octagonal prism along Z, width w (x) height h (y), length L; taper = front scale */
function octPrism(w, h, L, taper = 1, tile = 8) {
  const g = new THREE.CylinderGeometry(taper, 1, L, 8, 1, false);
  g.rotateY(Math.PI / 8);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w + h) * 1.6 / tile, uv.getY(i) * L / tile);
  g.rotateX(Math.PI / 2);         // +Y (top) -> +Z (front)
  g.scale(w / 2 / Math.cos(Math.PI / 8), h / 2 / Math.cos(Math.PI / 8), 1);
  return g;
}

// ---------------------------------------------------------------- templates
const templates = new Map();

function tAsteroid(seed, kind) {
  const r = rng(seed);
  const vars = rockVariants(kind === 'ice' ? 'ice' : (r() < 0.3 ? 'dark' : 'rock'), 6);
  const geo = vars[seed % vars.length];
  const matKind = kind === 'ice' ? 'ice' : (vars === rockVariants('dark', 6) ? 'dark' : 'rock');
  return { meshes: [{ geo, mat: rockMaterial(matKind) }], lights: null, radius: 1, colliders: [{ x: 0, y: 0, z: 0, r: 0.92 }], hp: 20, kind: kind === 'ice' ? 'ice' : 'rock', drop: null, tris: geo.index.count / 3 };
}

function tCrystal(seed, color) {
  const r = rng(seed);
  const tint = color || (r() < 0.55 ? '#2fe6d0' : '#a46bff');
  const b = new Builder();
  const rockGeo = makeRockGeometry(seed + 5, { detail: 3, roughness: 0.42, stretch: [1.3, 0.75, 1.1], facets: 3 });
  b.add(rockMaterial('dark'), rockGeo, mtx([0, -0.6, 0], [0, r() * 6, 0], 2.7));
  const mat = crystalMat(tint);
  const n = 7 + Math.floor(r() * 4);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const big = i === 0;
    const len = big ? 6.2 : 2.2 + r() * 3.6;
    const rad = big ? 0.95 : 0.35 + r() * 0.45;
    const tip = rad * (1.4 + r() * 0.8);
    const prism = new THREE.CylinderGeometry(rad, rad * 0.92, len, 6, 1);
    prism.translate(0, len / 2, 0);
    const cone = new THREE.ConeGeometry(rad, tip, 6, 1);
    cone.translate(0, len + tip / 2, 0);
    const merged = mergeParts([{ geo: prism, m: new THREE.Matrix4() }, { geo: cone, m: new THREE.Matrix4() }]);
    const one = merged.index ? merged.toNonIndexed() : merged;
    one.computeVertexNormals();
    // brightness gradient base->tip via vertex colour
    const P = one.attributes.position, C = new Float32Array(P.count * 3);
    const tot = len + tip;
    for (let k = 0; k < P.count; k++) { const t = Math.max(0, P.getY(k)) / tot; const v = 0.3 + 0.7 * t * t; C[k * 3] = C[k * 3 + 1] = C[k * 3 + 2] = v; }
    one.setAttribute('color', new THREE.BufferAttribute(C, 3));
    one.setIndex(null);
    // orientation: fan outward from the top of the rock
    const a = r() * Math.PI * 2, tilt = big ? 0.12 : 0.25 + r() * 0.75;
    const dir = new THREE.Vector3(Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a));
    const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const twist = new THREE.Quaternion().setFromAxisAngle(up, r() * 6);
    q.multiply(twist);
    const base = dir.clone().multiplyScalar(big ? 0.6 : 1.2).add(new THREE.Vector3(0, 0.2, 0));
    b.add(mat, one, new THREE.Matrix4().compose(base, q, new THREE.Vector3(1, 1, 1)));
  }
  b.light([0, 2.5, 0], tint, 9, [3.2, r(), 0, PULSE]);
  const t = b.build();
  return { ...t, radius: 6.2, colliders: [{ x: 0, y: 0, z: 0, r: 3.2 }, { x: 0, y: 3.6, z: 0, r: 2.6 }], hp: 50, kind: 'crystal', drop: 'boost', tint };
}

function tCargo(seed, color) {
  const r = rng(seed);
  const drop = r() < 0.5 ? 'missile' : 'shield';
  const hex = color || CARGO_COLORS[drop];
  const label = `SW-${String(Math.floor(r() * 9000) + 1000)}`;
  const b = new Builder();
  const W = 3.6, H = 3.6, L = 6.4;
  const bodyMat = cachedMat(`cargo:${hex}:${label}`, () => new THREE.MeshStandardMaterial({ color: '#d8d8d8', map: cargoTex(hex, label), metalness: 0.15, roughness: 0.68 }));
  b.add(bodyMat, new THREE.BoxGeometry(W, H, L));
  const fr = M.frame();
  const t = 0.22, o = 0.12;
  for (const z of [-L / 2 + 0.1, -L / 6, L / 6, L / 2 - 0.1]) {     // ribs / frames
    const end = Math.abs(z) > L / 3;
    const th = end ? 0.32 : t;
    b.add(fr, box(W + o * 2, th, end ? 0.32 : 0.2, 2), mtx([0, H / 2 + o / 2, z]));
    b.add(fr, box(W + o * 2, th, end ? 0.32 : 0.2, 2), mtx([0, -H / 2 - o / 2, z]));
    b.add(fr, box(th, H + o * 2, end ? 0.32 : 0.2, 2), mtx([W / 2 + o / 2, 0, z]));
    b.add(fr, box(th, H + o * 2, end ? 0.32 : 0.2, 2), mtx([-W / 2 - o / 2, 0, z]));
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    b.add(fr, box(0.3, 0.3, L + 0.1, 2), mtx([sx * (W / 2 + 0.02), sy * (H / 2 + 0.02), 0]));
    for (const sz of [-1, 1]) b.add(M.hullDark(), box(0.55, 0.55, 0.55, 2), mtx([sx * W / 2, sy * H / 2, sz * L / 2]));
  }
  // end door bars + handle
  for (const x of [-0.6, 0.6]) b.add(M.frame(), cyl(0.07, 0.07, H * 0.9, 6, 2), mtx([x, 0, L / 2 + 0.2]));
  // lamp housing + light
  const lampCol = drop === 'missile' ? new THREE.Color('#ffae42') : new THREE.Color('#5cc8ff');
  b.add(M.lamp(), sphere(0.16, 8, 6), mtx([W / 2 - 0.35, H / 2 + 0.35, L / 2 - 0.35]), lampCol);
  b.add(M.hullDark(), cyl(0.22, 0.26, 0.2, 8, 2), mtx([W / 2 - 0.35, H / 2 + 0.2, L / 2 - 0.35]));
  b.light([W / 2 - 0.35, H / 2 + 0.55, L / 2 - 0.35], lampCol.clone().multiplyScalar(1.2), 1.4, [1.4, r(), 0.18, BLINK]);
  const tt = b.build();
  return { ...tt, radius: 4.2, colliders: [{ x: 0, y: 0, z: -1.6, r: 2.6 }, { x: 0, y: 0, z: 1.6, r: 2.6 }], hp: 35, kind: 'metal', drop, tint: hex };
}

function tSatellite(seed, color) {
  const r = rng(seed);
  const b = new Builder();
  // body: gold foil octagonal bus with white caps
  b.add(M.foil(), cyl(1.5, 1.5, 3.0, 8, 3), mtx([0, 0, 0], [0, Math.PI / 8, 0]));
  b.add(M.white(), cyl(1.55, 1.55, 0.35, 8, 3), mtx([0, 1.65, 0], [0, Math.PI / 8, 0]));
  b.add(M.white(), cyl(1.55, 1.3, 0.35, 8, 3), mtx([0, -1.65, 0], [0, Math.PI / 8, 0]));
  b.add(M.hullDark(), cyl(0.6, 0.9, 0.9, 10, 3), mtx([0, -2.25, 0]));                 // thruster
  b.add(M.nozzle(), cyl(0.5, 0.75, 0.6, 12, 3, true), mtx([0, -2.9, 0]));
  // solar wings (one bent: derelict)
  const bent = (r() - 0.5) * 0.6;
  for (const s of [-1, 1]) {
    const rot = s > 0 ? bent : 0;
    const wing = new THREE.Matrix4().makeRotationX(rot);
    b.add(M.frame(), cyl(0.08, 0.08, 1.4, 6, 2), new THREE.Matrix4().multiplyMatrices(wing, mtx([s * 2.2, 0, 0], [0, 0, Math.PI / 2])));
    for (let k = 0; k < 2; k++) {
      const x = s * (3.15 + k * 2.15);
      b.add(M.solar(), box(2.0, 0.07, 2.4, 2), new THREE.Matrix4().multiplyMatrices(wing, mtx([x, 0, 0])));
      b.add(M.frame(), box(2.06, 0.1, 0.08, 2), new THREE.Matrix4().multiplyMatrices(wing, mtx([x, 0, 1.22])));
      b.add(M.frame(), box(2.06, 0.1, 0.08, 2), new THREE.Matrix4().multiplyMatrices(wing, mtx([x, 0, -1.22])));
    }
  }
  // dish on a boom
  const pts = [];
  for (let i = 0; i <= 10; i++) { const x = (i / 10) * 1.7; pts.push(new THREE.Vector2(x, x * x * 0.18)); }
  const dish = new THREE.LatheGeometry(pts, 24);
  const dm = mtx([0, 2.9, 0.4], [-0.55, 0, 0]);
  b.add(M.white(), dish, dm);
  b.add(M.frame(), cyl(0.07, 0.07, 1.2, 6, 2), mtx([0, 2.25, 0.2], [-0.3, 0, 0]));
  b.add(M.frame(), cyl(0.05, 0.05, 0.9, 6, 2), new THREE.Matrix4().multiplyMatrices(dm, mtx([0, 0.45, 0])));
  b.add(M.hullDark(), sphere(0.12, 8, 6), new THREE.Matrix4().multiplyMatrices(dm, mtx([0, 0.9, 0])));
  // antennas
  b.add(M.frame(), cyl(0.035, 0.035, 3.4, 5, 2), mtx([0.9, -2.6, -0.6], [0.3, 0, -0.35]));
  b.add(M.frame(), cyl(0.03, 0.03, 2.2, 5, 2), mtx([-1.0, 2.6, -0.8], [-0.2, 0, 0.4]));
  // instrument boxes
  b.add(M.hullDark(), box(0.9, 0.7, 0.8, 2), mtx([0, 0.6, 1.6]));
  b.add(M.white(), box(0.6, 0.6, 0.6, 2), mtx([1.0, -0.8, 1.3], [0, 0.4, 0]));
  b.add(M.glass(), cyl(0.22, 0.22, 0.3, 12, 2), mtx([0, 0.6, 2.05], [Math.PI / 2, 0, 0]));
  // lights
  const c = color || '#ff4636';
  b.add(M.lamp(), sphere(0.1, 8, 6), mtx([1.53, -3.65, -1.15]), new THREE.Color(c));
  b.light([1.55, -3.75, -1.2], c, 0.9, [1.8, r(), 0.12, BLINK]);
  b.light([0, 1.95, -1.4], '#62ff9a', 0.6, [2.6, r(), 0.08, BLINK]);
  const t = b.build();
  return { ...t, radius: 7.6, colliders: [{ x: 0, y: 0, z: 0, r: 2.6 }, { x: 0, y: 2.6, z: 0.4, r: 1.8 }, { x: -3.2, y: 0, z: 0, r: 1.4 }, { x: -5.4, y: 0, z: 0, r: 1.4 }, { x: 3.2, y: 0, z: 0, r: 1.4 }, { x: 5.4, y: 0, z: 0, r: 1.4 }], hp: 45, kind: 'metal', drop: 'boost' };
}

function tBeacon(seed, color) {
  const r = rng(seed);
  const c = color || '#8fe3ff';
  const b = new Builder();
  const y0 = -15;
  b.add(M.hullDark(), cyl(1.6, 2.4, 2.2, 8, 4), mtx([0, y0 + 1.1, 0]));
  b.add(M.frame(), cyl(2.6, 2.6, 0.3, 8, 4), mtx([0, y0 + 0.15, 0]));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.add(M.hull(), box(0.25, 4.5, 2.2, 4), mtx([Math.cos(a) * 1.9, y0 + 2.5, Math.sin(a) * 1.9], [0, Math.PI / 2 - a, 0]));
  }
  b.add(M.hull(), cyl(0.38, 0.75, 25, 10, 6), mtx([0, y0 + 2.2 + 12.5, 0]));
  for (const y of [5, 7, 17, 19]) b.add(M.paint('#e09a2e'), cyl(0.68 - y * 0.012, 0.7 - y * 0.012, 1.0, 10, 4), mtx([0, y0 + y, 0]));
  b.add(M.frame(), torus(1.5, 0.12, 6, 24, 4), mtx([0, y0 + 13, 0], [Math.PI / 2, 0, 0]));
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; b.add(M.frame(), cyl(0.06, 0.06, 1.2, 4, 2), mtx([Math.cos(a) * 0.9, y0 + 13, Math.sin(a) * 0.9], [0, -a, Math.PI / 2])); }
  b.add(M.hullDark(), cyl(0.5, 0.42, 0.9, 10, 2), mtx([0, y0 + 27.6, 0]));
  b.add(M.lamp(), sphere(0.42, 12, 8), mtx([0, y0 + 28.4, 0]), new THREE.Color(c));
  b.add(M.frame(), cyl(0.04, 0.04, 2.2, 4, 2), mtx([0.25, y0 + 29.5, 0]));
  b.light([0, y0 + 28.5, 0], c, 4.5, [2.0, r(), 0.22, BLINK]);
  b.light([0, y0 + 13, 1.6], c, 1.2, [2.0, r(), 0.1, STROBE]);
  b.light([0, y0 + 13, -1.6], c, 1.2, [2.0, r(), 0.1, STROBE]);
  const t = b.build();
  return { ...t, radius: 15.5, colliders: [{ x: 0, y: -13, z: 0, r: 2.8 }, { x: 0, y: -8, z: 0, r: 1.4 }, { x: 0, y: -3, z: 0, r: 1.4 }, { x: 0, y: 2, z: 0, r: 1.6 }, { x: 0, y: 7, z: 0, r: 1.3 }, { x: 0, y: 12, z: 0, r: 1.2 }], hp: null, kind: 'metal', drop: null };
}

function tMonolith(seed, color) {
  const r = rng(seed);
  const c = color || '#41dcff';
  const b = new Builder();
  const g = new THREE.BoxGeometry(8, 40, 2.4, 1, 6, 1);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) { const k = 1 - ((P.getY(i) + 20) / 40) * 0.16; P.setX(i, P.getX(i) * k); P.setZ(i, P.getZ(i) * k); }
  g.computeVertexNormals();
  b.add(monolithMat(c), g);
  // bevelled cap
  const cap = new THREE.CylinderGeometry(0.01, 1, 1.6, 4, 1);
  cap.rotateY(Math.PI / 4);
  cap.scale(8 * 0.84 / Math.SQRT2, 1, 2.4 * 0.84 / Math.SQRT2);
  b.add(monolithMat(c), cap, mtx([0, 20.8, 0]));
  // orbiting stones (spin group)
  const stones = rockVariantsLOD('dark', 3, 3);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + r();
    const rr = 9 + r() * 3;
    b.add(rockMaterial('dark'), stones[i % 3], mtx([Math.cos(a) * rr, -8 + r() * 16, Math.sin(a) * rr], [r() * 6, r() * 6, r() * 6], 0.8 + r() * 1.3), null, 'orbit');
  }
  b.light([0, -21.5, 0], c, 7, [6, r(), 0, PULSE]);
  const t = b.build();
  const cols = [];
  for (let y = -17; y <= 17; y += 5.6) cols.push({ x: 0, y, z: 0, r: 4.2 });
  return { ...t, radius: 22, colliders: cols, hp: null, kind: 'metal', drop: null, spin: { orbit: [[0, 1, 0], 0.12] } };
}

function tWreck(seed) {
  const r = rng(seed);
  const b = new Builder();
  const hull = M.hullDark(), rust = M.rust(), scorch = M.scorched(), fr = M.frame();
  // ---- bow section (z 18..70)
  b.add(M.hull(), octPrism(24, 17, 36), mtx([0, 0, 36]));
  b.add(rust, octPrism(24, 17, 16, 0.5), mtx([0, 0, 62]));
  b.add(scorch, octPrism(24.4, 17.4, 4), mtx([0, 0, 20]));
  b.add(hull, box(9, 5, 14, 6), mtx([0, 10.5, 34]));                      // bridge
  b.add(hull, box(6, 3, 8, 6), mtx([0, 14.2, 32]));
  b.add(M.glass(), box(6.4, 0.9, 0.2, 2), mtx([0, 14.4, 36.05]));
  b.add(fr, cyl(0.15, 0.15, 7, 5, 2), mtx([1.5, 19, 30]));
  b.add(fr, cyl(0.1, 0.1, 5, 5, 2), mtx([-1.2, 18, 31]));
  // hull dressing: faded livery band, conduits, greebles
  b.add(M.paint('#9c3b28'), octPrism(24.3, 17.3, 3.2), mtx([0, 0, 46]));
  b.add(M.paint('#c9c2b0'), octPrism(24.3, 17.3, 1.2), mtx([0, 0, 43.2]));
  for (const sx of [-1, 1]) {
    for (const yy of [-2.5, 2.2]) b.add(fr, cyl(0.55, 0.55, 30, 8, 4), mtx([sx * 12.3, yy, 36], [Math.PI / 2, 0, 0]));
    for (let i = 0; i < 4; i++) b.add(M.hullDark(), box(1.2, 2.2, 2.2, 4), mtx([sx * 12.6, -0.2, 24 + i * 8]));
  }
  for (let i = 0; i < 10; i++) {
    const w = 1 + r() * 3, l = 1.5 + r() * 5;
    b.add(r() < 0.5 ? hull : fr, box(w, 0.6 + r() * 1.2, l, 4), mtx([(r() - 0.5) * 14, 8.6, 22 + r() * 34]));
  }
  // ---- broken mid section: exposed ribs, spine, torn plates (z -14..18)
  b.add(fr, box(2.6, 2.6, 34, 4), mtx([0, -5.5, 2]));
  b.add(fr, box(1.2, 1.2, 30, 4), mtx([9.5, 3, 3]));
  b.add(fr, box(1.2, 1.2, 22, 4), mtx([-9.5, 3, 7], [0, 0.03, 0]));
  b.add(fr, box(1.2, 1.2, 26, 4), mtx([-8, -4, 2]));
  for (let i = 0; i < 6; i++) {
    const z = 15 - i * 5.4;
    const rib = new THREE.TorusGeometry(11, 0.55, 4, 8);
    rib.rotateZ(Math.PI / 8);
    rib.scale(1.06, 0.76, 1);
    b.add(i % 2 ? fr : rust, rib, mtx([0, 0, z], [0, 0, (r() - 0.5) * 0.06]));
    b.add(fr, box(21, 0.5, 0.5, 4), mtx([0, -1 + (r() - 0.5) * 2, z]));    // deck beam
  }
  for (let i = 0; i < 9; i++) {   // partial skin plates on top/sides
    const a = (r() - 0.5) * 2.2 - (r() < 0.3 ? Math.PI : 0);
    const z = -10 + r() * 26;
    const len = 3 + r() * 7;
    const m = mtx([Math.sin(a) * 11.6, Math.cos(a) * 8.6, z], [0, 0, -a], [1, 1, 1]);
    b.add(r() < 0.5 ? hull : scorch, box(5 + r() * 3, 0.35, len, 6), m);
  }
  // torn plates around the section edges
  for (const [zEdge, dirZ] of [[18, -1], [-14, 1]]) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + r() * 0.2;
      const len = 1 + r() * 5;
      b.add(r() < 0.6 ? scorch : rust, box(3.4, 0.3, len, 4), mtx([Math.sin(a) * 11.4, Math.cos(a) * 8.2, zEdge + dirZ * len / 2], [(r() - 0.5) * 0.3, 0, -a]));
    }
  }
  // ---- aft section, bent at the break (pivot z=-14)
  const bend = new THREE.Matrix4().makeTranslation(0, 0, -14)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.09, -0.07, 0.05)))
    .multiply(new THREE.Matrix4().makeTranslation(0, 0, 14));
  const A = (m) => new THREE.Matrix4().multiplyMatrices(bend, m);
  b.add(M.hull(), octPrism(26, 19, 40), A(mtx([0, 0, -34])));
  b.add(scorch, octPrism(26.4, 19.4, 3), A(mtx([0, 0, -15.5])));
  b.add(fr, octPrism(27, 20, 1.2), A(mtx([0, 0, -30])));
  b.add(fr, octPrism(27, 20, 1.2), A(mtx([0, 0, -44])));
  b.add(hull, box(22, 15, 14, 6), A(mtx([0, 0, -61])));                    // engine block
  b.add(fr, box(23, 2, 12, 4), A(mtx([0, 8.2, -61])));
  for (const [x, y] of [[-6.5, 0], [6.5, 0], [0, 0]]) {
    b.add(M.nozzle(), cyl(4.0, 3.0, 7, 20, 6, true), A(mtx([x, y, -71.5], [-Math.PI / 2, 0, 0])));
    b.add(M.ember(), new THREE.CircleGeometry(2.9, 20), A(mtx([x, y, -68.2], [0, Math.PI, 0])));
    b.add(M.frame(), cyl(2.2, 2.9, 3, 16, 4, true), A(mtx([x, y, -69.6], [-Math.PI / 2, 0, 0])));
  }
  for (const s of [-1, 1]) {              // container racks
    for (let i = 0; i < 5; i++) {
      if (r() < 0.25) continue;
      const hex = ['#c4552b', '#2c78b4', '#6d7744', '#b89a3c', '#9aa0a6'][Math.floor(r() * 5)];
      b.add(M.paint(hex), box(4, 3.4, 6.6, 4), A(mtx([s * 15.2, (r() < 0.5 ? 3.6 : -1.2), -22 - i * 7.4], [0, 0, s * 0.02])));
    }
    b.add(fr, box(0.8, 0.8, 38, 4), A(mtx([s * 13.2, 1.2, -37])));
  }
  b.add(fr, cyl(0.25, 0.4, 12, 6, 2), A(mtx([3, 15, -40])));
  b.add(M.paint('#9c3b28'), octPrism(26.3, 19.3, 3.2), A(mtx([0, 0, -50])));
  for (let i = 0; i < 8; i++) b.add(r() < 0.5 ? hull : fr, box(1 + r() * 4, 0.6 + r(), 2 + r() * 6, 4), A(mtx([(r() - 0.5) * 16, 9.8, -20 - r() * 34])));
  for (const sx of [-1, 1]) b.add(fr, cyl(0.6, 0.6, 36, 8, 4), A(mtx([sx * 13.3, -3.5, -34], [Math.PI / 2, 0, 0])));
  b.add(hull, box(3, 1.5, 3, 4), A(mtx([3, 21, -40])));
  // ---- floating debris near the break
  for (let i = 0; i < 7; i++) {
    const p = [(r() - 0.5) * 40, (r() - 0.5) * 26, -6 + r() * 20];
    if (Math.abs(p[0]) < 14 && Math.abs(p[1]) < 10) p[0] += Math.sign(p[0] || 1) * 16;
    if (r() < 0.5) b.add(r() < 0.5 ? scorch : hull, box(2 + r() * 4, 0.3, 2 + r() * 5, 4), mtx(p, [r() * 6, r() * 6, r() * 6]));
    else b.add(fr, box(0.8, 0.8, 4 + r() * 8, 4), mtx(p, [r() * 6, r() * 6, r() * 6]));
  }
  // lights: dying emergency beacons
  b.add(M.lamp(), sphere(0.35, 8, 6), mtx([1.5, 22.6, 30]), new THREE.Color('#ff3b2e'));
  b.light([1.5, 22.9, 30], '#ff3b2e', 3, [2.4, 0.1, 0.1, BLINK]);
  const aftLight = new THREE.Vector3(3, 22, -40).applyMatrix4(bend);
  b.light(aftLight.toArray(), '#ff3b2e', 3, [2.4, 0.6, 0.1, BLINK]);
  b.light([-9.5, 3, -5], '#ffb050', 2.2, [0.37, 0, 0.5, BLINK]);
  b.light([10, -3, 8], '#ffb050', 1.6, [0.9, 0.3, 0.12, STROBE]);
  const t = b.build();
  const cols = [{ x: 0, y: 0, z: 64, r: 8 }, { x: 0, y: 12, z: 33, r: 7 }];
  for (let z = 52; z >= 20; z -= 8) cols.push({ x: 0, y: 0, z, r: 12.5 });
  for (let z = 14; z >= -10; z -= 6) cols.push({ x: 0, y: 0, z, r: 11.5 });
  const c = new THREE.Vector3();
  for (let z = -18; z >= -66; z -= 8) { c.set(0, 0, z).applyMatrix4(bend); cols.push({ x: c.x, y: c.y, z: c.z, r: 14 }); }
  c.set(0, 0, -70).applyMatrix4(bend); cols.push({ x: c.x, y: c.y, z: c.z, r: 12 });
  for (const s of [-1, 1]) { c.set(s * 15, 1, -37).applyMatrix4(bend); cols.push({ x: c.x, y: c.y, z: c.z, r: 6 }); }
  return { ...t, radius: 76, colliders: cols, hp: null, kind: 'metal', drop: null };
}

function tStation(seed, color) {
  const r = rng(seed);
  const b = new Builder();
  const R = 90, tube = 8;
  const guide = color || '#5fe6ff';
  // habitat ring (slowly spinning)
  b.add(M.hab(), torus(R, tube, 20, 144, HAB_TILE, true), null, null, 'hab');
  const tan = new THREE.Vector3(), rad = new THREE.Vector3(), zA = new THREE.Vector3(0, 0, 1);
  const basisAt = (a, rr, zOff = 0) => {
    rad.set(Math.cos(a), Math.sin(a), 0); tan.set(-Math.sin(a), Math.cos(a), 0).negate();
    return new THREE.Matrix4().makeBasis(rad, zA, tan).setPosition(rad.x * rr, rad.y * rr, zOff);
  };
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    b.add(M.hullDark(), torus(tube + 0.45, 0.75, 6, 32, 4), basisAt(a, R), null, 'hab');
  }
  // inner docking ring (clear bore >= 45 radius)
  const Ri = 57;
  b.add(M.hull(), torus(Ri, 2.6, 10, 96, 6), null);
  b.add(M.hullDark(), torus(Ri, 3.0, 6, 96, 6), mtx([0, 0, 0], [0, 0, 0], [1, 1, 0.35]));
  // spokes
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const dir = [Math.cos(a), Math.sin(a), 0];
    const mid = (Ri + 2.6 + R - tube) / 2, len = R - tube - Ri - 1.6;
    b.add(M.hull(), cyl(1.5, 1.5, len, 10, 4), alongY([dir[0] * mid, dir[1] * mid, 0], dir));
    for (const zo of [-3.2, 3.2]) b.add(M.frame(), cyl(0.45, 0.45, len, 6, 4), alongY([dir[0] * mid, dir[1] * mid, zo], dir));
    for (let k = 0; k < 3; k++) {
      const d = Ri + 6 + k * 7;
      b.add(M.frame(), box(0.4, 0.4, 6.4, 2), mtx([dir[0] * d, dir[1] * d, 0]));
    }
    b.add(M.hullDark(), box(5, 5, 7, 4), basisAt(a, Ri + 4.5));
    b.add(M.hullDark(), box(4.5, 5.5, 8, 4), basisAt(a, R - tube - 1.2));
  }
  // docking modules on the outer rim
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.add(M.hull(), box(12, 9, 10, 6), basisAt(a, R + tube + 4));
    b.add(M.paint('#d0812f'), box(12.2, 1.2, 10.2, 6), basisAt(a, R + tube + 4, 0));
    b.add(M.hullDark(), cyl(2.6, 2.6, 3, 16, 4), alongY([Math.cos(a) * (R + tube + 11.5), Math.sin(a) * (R + tube + 11.5), 0], [Math.cos(a), Math.sin(a), 0]));
    b.add(M.frame(), torus(2.8, 0.35, 6, 20, 2).rotateY(Math.PI / 2), basisAt(a, R + tube + 13));
    b.light([Math.cos(a) * (R + tube + 13.5), Math.sin(a) * (R + tube + 13.5), 0], '#ffffff', 4.0, [2.2, i * 0.25, 0.1, STROBE]);
  }
  // radiator fins + antenna masts
  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI;
    const p = R + tube + 8;
    b.add(M.frame(), cyl(0.6, 0.6, 16, 6, 4), alongY([Math.cos(a) * (R + tube + 7), Math.sin(a) * (R + tube + 7), 0], [Math.cos(a), Math.sin(a), 0]));
    for (const zo of [-6.5, 6.5]) b.add(M.solar(), box(1, 1, 1, 2), basisAt(a, p, zo).multiply(new THREE.Matrix4().makeScale(14, 10, 0.3)));
  }
  for (const a of [Math.PI / 2, -Math.PI / 2]) {
    b.add(M.frame(), cyl(0.3, 0.5, 22, 6, 4), alongY([Math.cos(a) * (R + tube + 11), Math.sin(a) * (R + tube + 11), 0], [Math.cos(a), Math.sin(a), 0]));
    b.add(M.white(), sphere(1.4, 12, 8), mtx([Math.cos(a) * (R + tube + 3), Math.sin(a) * (R + tube + 3), 0]));
    b.light([Math.cos(a) * (R + tube + 22.6), Math.sin(a) * (R + tube + 22.6), 0], '#ff3a2e', 5.0, [1.6, a > 0 ? 0 : 0.5, 0.14, BLINK]);
  }
  // nav lights on the outer equator, red/green alternate
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    for (const zo of [-1, 1]) b.light([Math.cos(a) * (R + 0.5), Math.sin(a) * (R + 0.5), zo * (tube + 0.4)], i % 2 ? '#ff4636' : '#4dff8a', 3.0, [2.0, i % 2 ? 0 : 0.5, 0.12, BLINK]);
  }
  // runway chase lights on the inner ring faces (both approach sides) + lamp housings
  const nG = 32;
  const gc = new THREE.Color(guide);
  for (let i = 0; i < nG; i++) {
    const a = (i / nG) * Math.PI * 2;
    for (const zo of [-1, 1]) {
      b.light([Math.cos(a) * (Ri - 2.2), Math.sin(a) * (Ri - 2.2), zo * 2.0], guide, 2.6, [2.4, -i / nG, 0, CHASE]);
      b.add(M.lamp(), box(0.5, 0.5, 0.25, 1), mtx([Math.cos(a) * (Ri - 2.0), Math.sin(a) * (Ri - 2.0), zo * 1.75], [0, 0, a]), gc);
    }
  }
  const t = b.build();
  const cols = [];
  for (let i = 0; i < 56; i++) { const a = (i / 56) * Math.PI * 2; cols.push({ x: Math.cos(a) * R, y: Math.sin(a) * R, z: 0, r: tube + 2.2 }); }
  for (let i = 0; i < 44; i++) { const a = (i / 44) * Math.PI * 2; cols.push({ x: Math.cos(a) * Ri, y: Math.sin(a) * Ri, z: 0, r: 4.2 }); }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    for (const d of [65, 72, 79]) cols.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, z: 0, r: 4 });
  }
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; cols.push({ x: Math.cos(a) * (R + tube + 5), y: Math.sin(a) * (R + tube + 5), z: 0, r: 8 }); }
  for (const a of [0, Math.PI]) cols.push({ x: Math.cos(a) * (R + tube + 8), y: Math.sin(a) * (R + tube + 8), z: 0, r: 8 });
  return { ...t, radius: R + tube + 24, colliders: cols, hp: null, kind: 'metal', drop: null, spin: { hab: [[0, 0, 1], 0.03] }, clearRadius: Ri - 4.2 };
}

function template(type, seed, color) {
  const key = `${type}|${seed}|${color || ''}`;
  if (templates.has(key)) return templates.get(key);
  let t;
  switch (type) {
    case 'asteroid': t = tAsteroid(seed, 'rock'); break;
    case 'ice': t = tAsteroid(seed, 'ice'); break;
    case 'crystal': t = tCrystal(seed, color); break;
    case 'cargo': t = tCargo(seed, color); break;
    case 'satellite': t = tSatellite(seed, color); break;
    case 'wreck': t = tWreck(seed); break;
    case 'station': t = tStation(seed, color); break;
    case 'beacon': t = tBeacon(seed, color); break;
    case 'monolith': t = tMonolith(seed, color); break;
    default: throw new Error(`buildProp: unknown type "${type}"`);
  }
  templates.set(key, t);
  return t;
}

/**
 * Build a prop instance (cheap: geometry/material are shared per type+seed+colour).
 * Object origin = prop centre; returned colliders are local spheres at scale 1.
 * Extra fields: tris (triangle count), clearRadius (station bore), tint (crystal/cargo colour hex,
 * pass it as Shatter.burst({ color }) so the debris matches).
 */
export function buildProp(type, { seed = 1, color = null } = {}) {
  const t = template(type, seed | 0, color);
  const root = new THREE.Group();
  root.name = `prop:${type}`;
  const spinners = [];
  const spinGroups = {};
  for (const m of t.meshes) {
    const mesh = new THREE.Mesh(m.geo, m.mat);
    if (m.spin && t.spin?.[m.spin]) {
      if (!spinGroups[m.spin]) {
        const g = new THREE.Group();
        spinGroups[m.spin] = g; root.add(g);
        const [axis, speed] = t.spin[m.spin];
        spinners.push({ obj: g, axis: new THREE.Vector3(...axis), speed });
      }
      spinGroups[m.spin].add(mesh);
    } else root.add(mesh);
  }
  const lights = [];
  if (t.lights) {
    const pts = new THREE.Points(t.lights, getLightMat());
    pts.onBeforeRender = onLightsRender;
    pts.renderOrder = 5;
    root.add(pts);
    lights.push(pts);
  }
  const prop = {
    object: root, radius: t.radius, colliders: t.colliders.map((c) => ({ ...c })), hp: t.hp, kind: t.kind, drop: t.drop,
    lights, tris: t.tris, clearRadius: t.clearRadius, tint: t.tint ?? null,
  };
  if (type === 'asteroid' || type === 'ice') prop.object.userData.rockKind = t.kind;
  const entry = { spinners: spinners.length ? spinners : null };
  prop._entry = entry;
  registry.add(entry);
  return prop;
}
