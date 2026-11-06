// Wormhole tunnel: a translucent energy conduit along a course's closed racing line.
//
// Two draw calls, both additive (order independent, never hides what is inside or behind):
//   1. the wall: a closed tube (rotation-minimising frames, residual twist spread evenly so the
//      lap seam matches) with a fine Fresnel lattice, flowing light streaks, a painted
//      start/finish band, a soft proximity glow around the ship and pooled scrape ripples;
//   2. the hoops: thin camera-facing glow ribbons around the circumference every ~50 units
//      (denser through pinches, brighter every 4th, a pulse wave running in the race
//      direction) plus a chunky segmented white start/finish pair at u = 0.
// update() only writes uniforms: no per-frame allocation.
//
// Where another stretch of the same tube runs close by (crossover courses), that stretch's
// near wall is drawn as a ghosted lattice (no sheen or streaks) and your own wall facing it
// thins out, so you can see racers through both. Split lanes tint the risky channel's wall.

import * as THREE from 'three';

const QUALITY = {
  low:    { step: 8.0, radial: 28, hoopSeg: 40 },
  medium: { step: 7.0, radial: 32, hoopSeg: 52 },
  high:   { step: 6.5, radial: 40, hoopSeg: 64 },
};
const HOOP_SPACING = 52;       // world units between hoops at full radius
const STREAK_PERIOD = 300;     // approx. world units between streaks in one lane
const WAVE_LEN = 900;          // approx. world units between hoop pulse waves
const WAVE_SPEED = 520;        // hoop pulse wave speed (units/s)
const SCRAPE_SLOTS = 4;
const SCRAPE_LIFE = 0.9;
const FINISH_HALF = 3.2;       // half-width of the start/finish band along the line
const WARN = new THREE.Color('#ff6a3a');

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

// ---------------------------------------------------------------- wall shader
const WALL_VS = /* glsl */`
attribute vec4 aData;            // u (lap fraction), angle (0..1 around), radius, pinch weight
attribute vec2 aX;               // near another stretch of tube (0..1), risky split channel (0..1)
varying vec3 vWorld; varying vec3 vN; varying vec4 vData; varying vec2 vX;
void main(){
  vData = aData; vX = aX;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WALL_FS = /* glsl */`
uniform vec3 uColor, uWarn, uShip;
uniform float uLen, uFlow, uFlowWrap, uShipOn, uBaseR, uSpeedK, uStreakP, uStreakCycles;
uniform float uRingPitch, uLong, uHexK, uHexCell, uCamU, uCamOn;
uniform vec4 uScrape[${SCRAPE_SLOTS}];
uniform float uScrapeI[${SCRAPE_SLOTS}];
varying vec3 vWorld; varying vec3 vN; varying vec4 vData; varying vec2 vX;

float h11(float x){ return fract(sin(x * 127.1 + 311.7) * 43758.5453); }

// anti-aliased grid line; x in cell units, w = half width in cell units. Fades out (to its
// average coverage) once the cells get too small on screen, so distant walls never moiré.
float gridLine(float x, float w){
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x + 0.5) - 0.5) / fw;
  float wp = w / fw;
  float cov = clamp(max(wp, 0.7) - d + 0.5, 0.0, 1.0) * min(wp / 0.7, 1.0);
  return cov * (1.0 - smoothstep(0.12, 0.35, fw));
}

// distance to the nearest hex edge (hex lattice in p-space, period (1, sqrt 3))
float hexEdge(vec2 p){
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  vec2 q = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
  q = abs(q);
  return 0.5 - max(dot(q, vec2(0.5, 0.8660254)), q.x);
}

void main(){
  float u = vData.x, ang = vData.y, rad = vData.z, pinch = vData.w;
  float s = u * uLen;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 N = normalize(vN);
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 2.2);

  // distance shaping: almost nothing right at the lens, full at mid range, soft far away
  float nearF = mix(0.03, 1.0, smoothstep(9.0, 34.0, dist));
  float farLat = 1.0 - smoothstep(700.0, 1700.0, dist);
  float farGlow = 1.0 - 0.75 * smoothstep(1500.0, 6000.0, dist);

  float pw = pinch * pinch * pinch; pw *= pw;    // only the narrowest stretch is tinted
  vec3 base = mix(uColor, uWarn, max(pw * 0.6, vX.y * 0.5));

  // another stretch of tube close by: is this wall ours (thin it) or the other one (ghost it)?
  float sep = abs(fract(u - uCamU + 0.5) - 0.5) * uLen;
  float other = smoothstep(350.0, 600.0, sep) * uCamOn;
  float ghost = vX.x * other;
  float thin = vX.x * (1.0 - other);

  // ---- structural lattice: rails along the length + faint rings around ----
  float lLong = gridLine(ang * uLong, 0.016);
  float lRing = gridLine(s / uRingPitch, 0.02);
  float lat = max(lLong, lRing * mix(0.4, 0.9, ghost));
  float latVis = mix(mix(0.05, 0.6, ghost), 1.0, fres);
  vec3 col = base * lat * latVis * 0.085 * mix(1.0, 1.5, ghost) * nearF * farLat;

  // soft grazing sheen: what makes the tube read as a luminous path from afar
  float sheenK = mix(1.0, 2.6, smoothstep(700.0, 3500.0, dist)) * (1.0 - 0.9 * ghost) * (1.0 - 0.6 * thin);
  col += base * (pow(1.0 - ndv, 4.0) * 0.05 + fres * 0.006) * sheenK * nearF * farGlow;
  // faint warning fill on the narrowest part of a pinch
  col += uWarn * pw * (0.01 + fres * 0.04) * nearF;

  // ---- flowing light streaks (race direction = increasing u) ----
  {
    const float LANES = 12.0;
    float lx = ang * LANES;
    float lane = mod(floor(lx), LANES);
    float g = fract(lx) - 0.5 - (h11(lane + 3.0) - 0.5) * 0.5;
    float fwg = fwidth(lx);
    float sig = max(0.026, fwg * 0.9);
    float across = exp(-g * g / (sig * sig)) * (0.026 / sig);
    float ph = (s - uFlow) / uStreakP + h11(lane);
    float cyc = mod(floor(ph), uStreakCycles);
    float x = fract(ph);
    float tailLen = 0.12 + 0.16 * uSpeedK;
    float on = step(h11(lane * 17.0 + cyc * 3.1), 0.32);
    float body = smoothstep(1.0 - tailLen, 1.0, x) * smoothstep(1.0, 0.985, x);
    float sF = smoothstep(30.0, 130.0, dist) * (1.0 - smoothstep(600.0, 2200.0, dist));
    col += mix(base, vec3(1.0), 0.15) * across * body * body * on * sF * (0.55 + 0.4 * uSpeedK) * mix(0.5, 1.0, fres) * (1.0 - ghost);
  }

  // ---- start/finish band painted on the wall ----
  {
    float sw = s > uLen * 0.5 ? s - uLen : s;
    float band = 1.0 - smoothstep(FINISH_HALF - 0.4, FINISH_HALF, abs(sw));
    if (band > 0.0) {
      float cx = floor(ang * 36.0), cy = floor((sw + FINISH_HALF) / (FINISH_HALF * 0.5));
      float chk = mod(cx + cy, 2.0);
      col += mix(base * 0.18, vec3(0.62), chk) * band * mix(0.35, 1.0, fres) * mix(0.15, 1.0, nearF);
    }
  }

  // ---- proximity glow: the wall lights up as the ship nears it ----
  if (uShipOn > 0.001) {
    float dS = distance(vWorld, uShip);
    float prox = smoothstep(24.0, 2.0, dS);
    prox *= prox * uShipOn;
    if (prox > 0.002) {
      float he = hexEdge(vec2(ang * uHexK, s / uHexCell));
      float fw = max(fwidth(he), 1e-4);
      float hl = (1.0 - smoothstep(0.02, 0.02 + fw * 1.5, he)) * (1.0 - smoothstep(0.12, 0.3, fw));
      float pF = smoothstep(1.5, 7.0, dist);
      vec3 pc = mix(base, vec3(1.0), 0.25);
      col += pc * prox * (0.07 + hl * 0.3) * pF;
    }
  }

  // ---- scrape ripples: expanding rings + a short flash at the contact point ----
  for (int k = 0; k < ${SCRAPE_SLOTS}; k++) {
    float I = uScrapeI[k];
    if (I <= 0.0) continue;
    vec4 sp = uScrape[k];
    float age = sp.w;
    float d = distance(vWorld, sp.xyz);
    float R = 2.0 + age * 48.0;
    float wdt = 1.2 + age * 3.0;
    float life = 1.0 - age / ${SCRAPE_LIFE.toFixed(2)};
    float ring = exp(-pow((d - R) / wdt, 2.0)) * life * life;
    float flash = exp(-d * d / pow(2.5 + age * 9.0, 2.0)) * exp(-age * 7.0);
    float hexes = 0.0;
    if (d < R + 8.0) {
      float he = hexEdge(vec2(ang * uHexK, s / uHexCell));
      float fw = max(fwidth(he), 1e-4);
      hexes = (1.0 - smoothstep(0.03, 0.03 + fw * 1.5, he)) * smoothstep(R + 5.0, R - 2.0, d) * smoothstep(R - 18.0, R - 5.0, d) * life * 0.25;
    }
    col += mix(base, vec3(1.0), 0.35) * I * (ring * 0.8 + flash * 0.8 + hexes) * mix(0.35, 1.0, smoothstep(6.0, 40.0, dist)) * smoothstep(1.0, 4.0, dist);
  }

  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- hoop shader
const HOOP_VS = /* glsl */`
attribute vec3 aTan;             // circle tangent at this vertex
attribute vec4 aHoop;            // u, kind (0 normal, 1 major, 2 finish), angle (0..1), side (-1/+1)
attribute float aPinch;
attribute float aNear;           // near another stretch of tube (0..1)
uniform float uPx;               // world size of one pixel at unit distance
varying float vAcross; varying float vDim; varying float vU; varying float vKind; varying float vAng;
varying float vDist; varying float vPinch; varying float vNear;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 toCam = cameraPosition - wp.xyz;
  float d = length(toCam);
  vec3 V = toCam / max(d, 1e-4);
  vec3 T = normalize(mat3(modelMatrix) * aTan);
  vec3 off = cross(T, V);
  float ol = length(off);
  off = ol > 1e-4 ? off / ol : normalize(cross(T, vec3(0.31, 0.83, 0.46)));
  float kind = aHoop.y;
  float w0 = kind > 1.5 ? 0.85 : (kind > 0.5 ? 0.34 : 0.25);
  float w = max(w0, d * uPx * 1.1);
  vDim = w0 / w;
  const float HALO = 3.0;
  wp.xyz += off * aHoop.w * w * HALO;
  vAcross = aHoop.w * HALO;
  vU = aHoop.x; vKind = kind; vAng = aHoop.z; vDist = d; vPinch = aPinch; vNear = aNear;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const HOOP_FS = /* glsl */`
uniform vec3 uColor, uWarn;
uniform float uLen, uWave, uWaveLen, uCamU, uCamOn;
varying float vAcross; varying float vDim; varying float vU; varying float vKind; varying float vAng;
varying float vDist; varying float vPinch; varying float vNear;
void main(){
  float x = vAcross;
  float prof = exp(-x * x * 2.2) + 0.1 * exp(-x * x * 0.45);
  float s = vU * uLen;
  float pw = vPinch * vPinch * vPinch; pw *= pw;
  vec3 base = mix(uColor, uWarn, pw * 0.7);
  vec3 col;
  if (vKind > 1.5) {
    // start/finish: white, segmented
    float seg = fract(vAng * 24.0);
    float on = smoothstep(0.0, 0.04, seg) * smoothstep(0.5, 0.46, seg);
    col = mix(base * 0.3, vec3(0.8), on);
  } else {
    float ph = fract((s - uWave) / uWaveLen);
    float pulse = pow(ph, 14.0);
    float b = vKind > 0.5 ? 0.62 : 0.4;
    col = mix(base, vec3(1.0), vKind * 0.15 + pulse * 0.15) * (b + pulse * 0.8);
  }
  float fade = smoothstep(4.0, 22.0, vDist) * (1.0 - 0.6 * smoothstep(1800.0, 6000.0, vDist));
  float other = smoothstep(350.0, 600.0, abs(fract(vU - uCamU + 0.5) - 0.5) * uLen) * uCamOn;
  col *= prof * vDim * fade * (1.0 - 0.8 * vNear * other);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- frames
// Rotation-minimising frames by double reflection (Wang et al. 2008) around the closed loop,
// then the residual twist (angle between the transported and initial normal at the seam)
// is spread evenly along the lap so frame N == frame 0.
function buildFrames(curve, n) {
  const P = [], T = [], Nn = [];
  for (let i = 0; i < n; i++) {
    const u = i / n;
    P.push(curve.getPointAt(u));
    T.push(curve.getTangentAt(u).normalize());
  }
  const r0 = new THREE.Vector3(0, 1, 0).addScaledVector(T[0], -T[0].y);
  if (r0.lengthSq() < 1e-6) r0.set(1, 0, 0).addScaledVector(T[0], -T[0].x);
  r0.normalize();
  Nn.push(r0);
  const v1 = new THREE.Vector3(), rL = new THREE.Vector3(), tL = new THREE.Vector3(), v2 = new THREE.Vector3();
  let r = r0.clone();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    v1.subVectors(P[j], P[i]);
    const c1 = v1.dot(v1);
    if (c1 < 1e-10) { if (j) Nn.push(r.clone()); continue; }
    rL.copy(r).addScaledVector(v1, (-2 / c1) * v1.dot(r));
    tL.copy(T[i]).addScaledVector(v1, (-2 / c1) * v1.dot(T[i]));
    v2.subVectors(T[j], tL);
    const c2 = v2.dot(v2);
    r = c2 < 1e-10 ? rL.clone() : rL.clone().addScaledVector(v2, (-2 / c2) * v2.dot(rL));
    r.addScaledVector(T[j], -r.dot(T[j])).normalize();
    if (j) Nn.push(r);
  }
  // r is now frame 0's normal after one full lap of transport; measure the residual twist
  const twist = Math.atan2(_v.crossVectors(r, r0).dot(T[0]), r.dot(r0));
  const B = [];
  for (let i = 0; i < n; i++) {
    Nn[i].applyAxisAngle(T[i], (twist * i) / n).normalize();
    B.push(new THREE.Vector3().crossVectors(T[i], Nn[i]).normalize());
  }
  return { P, T, N: Nn, B, twist };
}

function pinchWeight(def, u) {
  const t = def?.tunnel;
  if (!t || !t.pinches) return 0;
  let w = 0;
  for (const p of t.pinches) {
    if (!(p.radius < t.radius)) continue;
    const d = Math.abs((((u - p.at) % 1) + 1.5) % 1 - 0.5);
    if (d < p.len) w = Math.max(w, 0.5 + 0.5 * Math.cos((d / p.len) * Math.PI));
  }
  return w;
}

const ringDist = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

/**
 * Walls near another stretch of the same tube. at(P, R, u) returns the samples of other
 * stretches close to the ring at u (or null, the usual case); weight() is 1 on a wall a few
 * metres from the other tube, falling to 0 by 50 m.
 */
function nearOther(course) {
  const S = course.samples, n = course.sampleCount, L = course.length;
  const rad = new Float32Array(n);
  for (let i = 0; i < n; i++) rad[i] = course.tunnelRadiusAt(i / n);
  let maxR = 0;
  for (let i = 0; i < n; i++) maxR = Math.max(maxR, rad[i]);
  return {
    at(P, R, u) {
      let out = null;
      const reach = R + maxR + 60;
      for (let i = 0; i < n; i += 2) {
        if (ringDist(i / n, u) * L < 400) continue;
        if (S[i].distanceToSquared(P) < reach * reach) (out || (out = [])).push(i);
      }
      if (!out) return null;
      // densify round the candidates so the weight is smooth
      const all = new Set();
      for (const i of out) for (let k = -2; k <= 2; k++) all.add((i + k + n) % n);
      return [...all];
    },
    weight(cand, x, y, z) {
      let g = Infinity;
      for (const i of cand) {
        const s = S[i], dx = x - s.x, dy = y - s.y, dz = z - s.z;
        g = Math.min(g, Math.sqrt(dx * dx + dy * dy + dz * dz) - rad[i]);
      }
      const t = Math.min(1, Math.max(0, (g - 4) / 46));
      return 1 - t * t * (3 - 2 * t);
    },
  };
}

/** Split lanes: walls of the risky channel get a warning tint. */
function riskZones(course) {
  const splits = course.splits || [];
  return {
    at(u) {
      for (const sp of splits) {
        const d = ringDist(u, sp.at);
        if (d > sp.half + sp.ramp) continue;
        const k = d <= sp.half ? 1 : 1 - (d - sp.half) / sp.ramp;
        const f = course.frameAt(u);
        const ax = (sp.axis === 'up' ? f.U : f.R).multiplyScalar(sp.side);
        return { weight: (nx, ny, nz) => { const c = nx * ax.x + ny * ax.y + nz * ax.z; return k * Math.min(1, Math.max(0, (c - 0.35) / 0.4)); } };
      }
      return null;
    },
  };
}

export class Tunnel {
  constructor(scene, course, { color = '#5ee7ff', quality = 'high' } = {}) {
    this.scene = scene;
    this.course = course;
    this.q = QUALITY[quality] || QUALITY.high;
    this._flow = 0;
    this._wave = 0;
    this._time = 0;
    this._shipOn = 0;
    this._speedK = 0;

    const L = course.length;
    this.length = L;
    const baseR = course.def?.tunnel?.radius ?? course.tunnelRadiusAt(0);
    this.baseRadius = baseR;

    // ---------------------------------------------------- shared uniforms
    const accent = new THREE.Color(color);
    const streakCycles = Math.max(1, Math.round(L / STREAK_PERIOD));
    const waveCycles = Math.max(1, Math.round(L / WAVE_LEN));
    const ringPitch = L / Math.max(1, Math.round(L / 26));
    const longLines = 16;
    const hexK = Math.max(12, Math.round((2 * Math.PI * baseR) / 4.5));
    this._streakP = L / streakCycles;
    this._waveLen = L / waveCycles;
    this.uniforms = {
      uColor: { value: accent },
      uWarn: { value: WARN.clone() },
      uLen: { value: L },
      uFlow: { value: 0 },
      uShip: { value: new THREE.Vector3() },
      uShipOn: { value: 0 },
      uBaseR: { value: baseR },
      uSpeedK: { value: 0 },
      uStreakP: { value: this._streakP },
      uStreakCycles: { value: streakCycles },
      uRingPitch: { value: ringPitch },
      uLong: { value: longLines },
      uHexK: { value: hexK },
      uHexCell: { value: (2 * Math.PI * baseR) / hexK },
      uScrape: { value: Array.from({ length: SCRAPE_SLOTS }, () => new THREE.Vector4()) },
      uScrapeI: { value: new Array(SCRAPE_SLOTS).fill(0) },
      uWave: { value: 0 },
      uWaveLen: { value: this._waveLen },
      uPx: { value: 0.001 },
      uCamU: { value: 0 },
      uCamOn: { value: 0 },
    };
    this._camI = -1;
    this._camLoc = { i: 0, u: 0, c: new THREE.Vector3(), t: new THREE.Vector3() };
    this._camLast = new THREE.Vector3();
    this._camOn = 0;
    this._scrapeAge = new Float32Array(SCRAPE_SLOTS).fill(Infinity);
    this._scrapeNext = 0;

    // ---------------------------------------------------- wall geometry
    const n = Math.max(64, Math.round(L / this.q.step));
    const m = this.q.radial;
    this._n = n;
    const fr = buildFrames(course.curve, n);
    this._frames = fr;
    this.twist = fr.twist;
    const rows = n + 1, cols = m + 1;
    const nv = rows * cols;
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), dat = new Float32Array(nv * 4), ext = new Float32Array(nv * 2);
    const near = nearOther(course), risk = riskZones(course);
    const cosA = new Float32Array(cols), sinA = new Float32Array(cols);
    for (let j = 0; j < cols; j++) { const a = (j / m) * Math.PI * 2; cosA[j] = Math.cos(a); sinA[j] = Math.sin(a); }
    for (let i = 0; i < rows; i++) {
      const k = i % n;
      const u = i / n;
      const R = course.tunnelRadiusAt(k / n);
      const pin = pinchWeight(course.def, k / n);
      const P = fr.P[k], Nn = fr.N[k], B = fr.B[k];
      const cand = near.at(P, R, k / n), rz = risk.at(k / n);
      for (let j = 0; j < cols; j++) {
        const vi = i * cols + j;
        const nx = cosA[j] * Nn.x + sinA[j] * B.x, ny = cosA[j] * Nn.y + sinA[j] * B.y, nz = cosA[j] * Nn.z + sinA[j] * B.z;
        pos[vi * 3] = P.x + nx * R; pos[vi * 3 + 1] = P.y + ny * R; pos[vi * 3 + 2] = P.z + nz * R;
        nor[vi * 3] = nx; nor[vi * 3 + 1] = ny; nor[vi * 3 + 2] = nz;
        dat[vi * 4] = u; dat[vi * 4 + 1] = j / m; dat[vi * 4 + 2] = R; dat[vi * 4 + 3] = pin;
        if (cand) ext[vi * 2] = near.weight(cand, pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        if (rz) ext[vi * 2 + 1] = rz.weight(nx, ny, nz);
      }
    }
    const idx = nv > 65535 ? new Uint32Array(n * m * 6) : new Uint16Array(n * m * 6);
    let p = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const a = i * cols + j, b = (i + 1) * cols + j;
      idx[p++] = a; idx[p++] = b; idx[p++] = a + 1;
      idx[p++] = b; idx[p++] = b + 1; idx[p++] = a + 1;
    }
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    wallGeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    wallGeo.setAttribute('aData', new THREE.BufferAttribute(dat, 4));
    wallGeo.setAttribute('aX', new THREE.BufferAttribute(ext, 2));
    wallGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    wallGeo.computeBoundingSphere();
    this.wallMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: WALL_VS,
      fragmentShader: WALL_FS.replace(/FINISH_HALF/g, FINISH_HALF.toFixed(2)),
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      fog: false, toneMapped: false,
    });
    this.wallMat.forceSinglePass = true;   // additive: order independent, so one pass covers both faces
    this.wall = new THREE.Mesh(wallGeo, this.wallMat);
    this.wall.name = 'TunnelWall';
    this.wall.frustumCulled = false;
    this.wall.renderOrder = -10;           // first among transparents; alpha-blended FX draw over it
    this.wall.matrixAutoUpdate = false;

    // ---------------------------------------------------- hoops
    const hoops = this._placeHoops(course);
    this.hoops = hoops;
    const seg = this.q.hoopSeg;
    const hv = hoops.length * (seg + 1) * 2;
    const hPos = new Float32Array(hv * 3), hTan = new Float32Array(hv * 3), hDat = new Float32Array(hv * 4), hPin = new Float32Array(hv), hNear = new Float32Array(hv);
    const hIdx = new (hv > 65535 ? Uint32Array : Uint16Array)(hoops.length * seg * 6);
    let vi = 0, ii = 0;
    const Nn = new THREE.Vector3(), B = new THREE.Vector3(), T = new THREE.Vector3(), P = new THREE.Vector3();
    for (const h of hoops) {
      this._frameAt(h.u, P, T, Nn, B);
      const R = course.tunnelRadiusAt(h.u) * 0.997;
      const pin = pinchWeight(course.def, h.u);
      const cand = near.at(P, R, h.u);
      const first = vi;
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        const px = P.x + (c * Nn.x + s * B.x) * R, py = P.y + (c * Nn.y + s * B.y) * R, pz = P.z + (c * Nn.z + s * B.z) * R;
        const nw = cand ? near.weight(cand, px, py, pz) : 0;
        const tx = -s * Nn.x + c * B.x, ty = -s * Nn.y + c * B.y, tz = -s * Nn.z + c * B.z;
        for (let side = -1; side <= 1; side += 2) {
          hPos[vi * 3] = px; hPos[vi * 3 + 1] = py; hPos[vi * 3 + 2] = pz;
          hTan[vi * 3] = tx; hTan[vi * 3 + 1] = ty; hTan[vi * 3 + 2] = tz;
          hDat[vi * 4] = h.u; hDat[vi * 4 + 1] = h.kind; hDat[vi * 4 + 2] = j / seg; hDat[vi * 4 + 3] = side;
          hPin[vi] = pin; hNear[vi] = nw;
          vi++;
        }
      }
      // a hoop of a stretch running alongside dims as a whole, so it doesn't clutter the view
      if (cand) { let mx = 0; for (let v = first; v < vi; v++) mx = Math.max(mx, hNear[v]); hNear.fill(mx, first, vi); }
      for (let j = 0; j < seg; j++) {
        const a = first + j * 2, b = a + 2;
        hIdx[ii++] = a; hIdx[ii++] = a + 1; hIdx[ii++] = b;
        hIdx[ii++] = a + 1; hIdx[ii++] = b + 1; hIdx[ii++] = b;
      }
    }
    const hoopGeo = new THREE.BufferGeometry();
    hoopGeo.setAttribute('position', new THREE.BufferAttribute(hPos, 3));
    hoopGeo.setAttribute('aTan', new THREE.BufferAttribute(hTan, 3));
    hoopGeo.setAttribute('aHoop', new THREE.BufferAttribute(hDat, 4));
    hoopGeo.setAttribute('aPinch', new THREE.BufferAttribute(hPin, 1));
    hoopGeo.setAttribute('aNear', new THREE.BufferAttribute(hNear, 1));
    hoopGeo.setIndex(new THREE.BufferAttribute(hIdx, 1));
    hoopGeo.computeBoundingSphere();
    this.hoopMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: HOOP_VS, fragmentShader: HOOP_FS,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      fog: false, toneMapped: false,
    });
    this.hoopMat.forceSinglePass = true;
    this.hoopMesh = new THREE.Mesh(hoopGeo, this.hoopMat);
    this.hoopMesh.name = 'TunnelHoops';
    this.hoopMesh.frustumCulled = false;
    this.hoopMesh.renderOrder = -9;
    this.hoopMesh.matrixAutoUpdate = false;
    // Drawing-buffer height in pixels, used to keep distant hoops >= ~1 px wide (no shimmer).
    // Optional: set it to renderer.domElement.height on resize for exact pixel widths.
    this.pixelHeight = 1080;

    this.group = new THREE.Group();
    this.group.name = 'Tunnel';
    this.group.add(this.wall, this.hoopMesh);
    scene.add(this.group);

    this.triangles = n * m * 2 + hoops.length * seg * 2;
    this.drawCalls = 2;
  }

  /** Parallel-transport frame at u (interpolated between the precomputed rings). */
  _frameAt(u, P, T, Nn, B) {
    const n = this._n, fr = this._frames;
    u = ((u % 1) + 1) % 1;
    this.course.curve.getPointAt(u, P);
    this.course.curve.getTangentAt(u, T).normalize();
    const f = u * n, i0 = Math.floor(f) % n, i1 = (i0 + 1) % n, t = f - Math.floor(f);
    // ring n (== ring 0) carries the full twist correction, so lerping i0 -> i1 is seamless
    Nn.copy(fr.N[i0]).lerp(fr.N[i1], t);
    Nn.addScaledVector(T, -Nn.dot(T)).normalize();
    B.crossVectors(T, Nn).normalize();
  }

  _placeHoops(course) {
    // spacing shrinks through pinches so they read as tightening; integrate 1/spacing and
    // spread a whole number of hoops evenly in that "phase" so the lap closes cleanly.
    const L = course.length, steps = 2048, R0 = this.baseRadius;
    const phase = new Float32Array(steps + 1);
    for (let i = 0; i < steps; i++) {
      const u = (i + 0.5) / steps;
      const k = Math.min(1, course.tunnelRadiusAt(u) / R0);
      const sp = HOOP_SPACING * Math.max(0.5, k * k);
      phase[i + 1] = phase[i] + (L / steps) / sp;
    }
    const count = Math.max(8, Math.round(phase[steps] / 4) * 4);   // multiple of 4: majors line up at the seam
    const hoops = [];
    let i = 0;
    for (let h = 0; h < count; h++) {
      const target = (h / count) * phase[steps];
      while (i < steps - 1 && phase[i + 1] < target) i++;
      const f = (target - phase[i]) / Math.max(1e-9, phase[i + 1] - phase[i]);
      const u = (i + f) / steps;
      hoops.push({ u: h === 0 ? 0 : u, kind: h % 4 === 0 ? 1 : 0 });
    }
    // start/finish: two chunky segmented hoops framing the painted band at u = 0
    hoops[0].kind = 2; hoops[0].u = FINISH_HALF / L;
    hoops.push({ u: 1 - FINISH_HALF / L, kind: 2 });
    return hoops;
  }

  update(dt, camera, { shipPos = null, speed = 0 } = {}) {
    const U = this.uniforms;
    this._time += dt;
    const L = this.length;
    // streaks travel faster than the ship, so they always flow forward past you
    this._flow = (this._flow + dt * (70 + Math.abs(speed) * 1.15)) % L;
    this._wave = (this._wave + dt * (WAVE_SPEED + Math.abs(speed) * 0.5)) % L;
    U.uFlow.value = this._flow;
    U.uWave.value = this._wave;
    const k = Math.min(1, Math.abs(speed) / 260);
    this._speedK += (k - this._speedK) * Math.min(1, dt * 3);
    U.uSpeedK.value = this._speedK;
    const on = shipPos ? 1 : 0;
    this._shipOn += (on - this._shipOn) * Math.min(1, dt * 6);
    if (shipPos) U.uShip.value.copy(shipPos);
    U.uShipOn.value = this._shipOn;
    // Which stretch of tube we're in (for ghosting the others): hill-climb from last frame,
    // re-found from scratch after a jump (respawn, new focus ship).
    if (shipPos) {
      const c = this.course;
      if (this._camI < 0 || this._camLast.distanceToSquared(shipPos) > 200 * 200) this._camI = Math.round(c.nearestU(shipPos).u * c.sampleCount);
      this._camI = c.locate(shipPos, this._camI, this._camLoc, 40).i;
      this._camLast.copy(shipPos);
      U.uCamU.value = this._camLoc.u;
    }
    this._camOn += ((shipPos ? 1 : 0) - this._camOn) * Math.min(1, dt * 4);
    U.uCamOn.value = this._camOn;
    if (camera && camera.isPerspectiveCamera) {
      U.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)) / Math.max(1, this.pixelHeight);
    }
    const I = U.uScrapeI.value, S = U.uScrape.value;
    for (let s = 0; s < SCRAPE_SLOTS; s++) {
      if (I[s] <= 0) continue;
      this._scrapeAge[s] += dt;
      if (this._scrapeAge[s] >= SCRAPE_LIFE) { I[s] = 0; continue; }
      S[s].w = this._scrapeAge[s];
    }
  }

  scrape(point, intensity = 1) {
    const I = this.uniforms.uScrapeI.value, S = this.uniforms.uScrape.value;
    // reuse a free slot, else the oldest; a scrape very close to a fresh one just refreshes it
    let slot = -1, oldest = -1, oldAge = -1;
    for (let s = 0; s < SCRAPE_SLOTS; s++) {
      if (I[s] > 0 && this._scrapeAge[s] < 0.12) {
        _v2.set(S[s].x, S[s].y, S[s].z);
        if (_v2.distanceToSquared(point) < 36) { I[s] = Math.max(I[s], Math.min(2, intensity)); return; }
      }
      if (I[s] <= 0 && slot < 0) slot = s;
      if (this._scrapeAge[s] > oldAge) { oldAge = this._scrapeAge[s]; oldest = s; }
    }
    if (slot < 0) slot = oldest >= 0 ? oldest : this._scrapeNext;
    this._scrapeNext = (slot + 1) % SCRAPE_SLOTS;
    S[slot].set(point.x, point.y, point.z, 0);
    I[slot] = Math.max(0.05, Math.min(2, intensity));
    this._scrapeAge[slot] = 0;
  }

  dispose() {
    this.group.removeFromParent();
    this.wall.geometry.dispose();
    this.hoopMesh.geometry.dispose();
    this.wallMat.dispose();
    this.hoopMat.dispose();
    this._frames = null;
  }
}
