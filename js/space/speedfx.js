// Speed sensation: everything that makes 100-150 m/s feel like a pod race without touching
// the physics.
//
//   const speed = new SpeedFX(scene, camera, { quality, reduceMotion });
//   const pass = createSpeedPass();          // insert in the composer after RenderPass, before bloom
//   speed.attachPass(pass);                  // SpeedFX drives the pass uniforms (and enables it)
//   // every rendered frame, after the camera is placed:
//   speed.update(dt, { speedN, boost, supersonic, wall, wallPoint, nearMiss, velocity, shipPos, shipQuat, craft });
//   camera.fov += speed.fovKick;  shake += speed.shake;   // optional extra camera punch
//
// Pieces:
//  - Rush streaks: a few hundred thin tapered streaks in a cylinder around the travel axis,
//    positioned entirely in the vertex shader (CPU writes a handful of uniforms per frame).
//    The closest ones whip past the edges of the screen; a centre mask keeps the track clear.
//    When you skim the wall a second group clusters on the wall side, brighter and warmer.
//  - Wall spray: grinding sparks + a hot contact flare at wallPoint when wall > ~0.8.
//  - Supersonic: a flickering Mach cone around the ship, a shock collar at the nose, Mach
//    diamonds in the exhaust and a whiter flame (craft.flameMat), plus a sonic-boom ring (3D
//    expanding ring + flash + a refraction ripple in the speed pass) on entering supersonic.
//  - Near miss: streak burst + a brief edge flash / aberration kick in the pass.
//  - Speed pass: radial zoom blur toward the edges + slight chromatic aberration, strength
//    from speed/boost/supersonic; centre stays sharp.
//  - Boost pads: padHit(big, pos, vel). A big pad fires an amber shockwave ring on screen (speed
//    pass) and round the ship (3D), a warm edge flash, a gold spark burst and a short FOV punch;
//    a small pad is a subtle tick (tiny FOV nudge + a few sparks).
// reduceMotion: fewer/dimmer streaks, a quarter of the blur, no aberration or boom ripple,
// no FOV kick or shake.
// Speed effects level (settings.speedEffects): 'full' | 'reduced' | 'off' scales streak density,
// radial blur, camera shake and FOV kick (SPEED_LEVELS; read the live factors from `levels`).
// Reduce motion caps it at 'reduced'. setLevel(level, reduceMotion) applies a change live.
// Streaks, blur and fovKick are scaled here; `shake` is not (the camera owner multiplies all of
// its shake by levels.shake).

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BillboardPool, makeSpec, resetSpec } from './fx.js';
import { rng } from './util.js';

const QUALITY = { high: { streaks: 420, sparks: 500 }, medium: { streaks: 280, sparks: 340 }, low: { streaks: 150, sparks: 200 } };
const L_SPAN = 170;          // streak cylinder length (m)
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _c = new THREE.Color();
const C_WHITE = new THREE.Color(1, 1, 1);
const C_SPARK0 = new THREE.Color(1.0, 0.72, 0.36);
const C_SPARK1 = new THREE.Color(1.0, 0.3, 0.06);
const C_SHOCK = new THREE.Color(0.75, 0.9, 1.0);
const C_BOOST = new THREE.Color(1.0, 0.85, 0.65);

/** Per-level factors for the speed effects setting. */
export const SPEED_LEVELS = {
  full: { streaks: 1, blur: 1, shake: 1, fov: 1 },
  reduced: { streaks: 0.5, blur: 0.45, shake: 0.35, fov: 0.45 },
  off: { streaks: 0, blur: 0, shake: 0, fov: 0 },
};
/** Effective level name: unknown -> 'full'; reduce motion caps it at 'reduced'. */
export function speedLevel(level, reduceMotion = false) {
  const k = SPEED_LEVELS[level] ? level : 'full';
  return reduceMotion && k === 'full' ? 'reduced' : k;
}
const C_PAD = new THREE.Color(1.0, 0.72, 0.28);

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function randUnit(r, out) {
  const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
}

// ================================================================ rush streaks
const STREAK_VS = /* glsl */`
attribute vec4 aS;      // angle 0..1, radius 0..1, phase 0..1, brightness
attribute float aG;     // 0 general, 1 wall group
uniform vec3 uFlow;     // travel direction in view space (unit)
uniform float uDist, uLen, uRMin, uRMax, uAlpha, uWallA, uWallAng, uWallR, uWidth, uNear;
uniform vec2 uRes;
varying float vT; varying float vA; varying float vG;
void main(){
  vec3 f = uFlow;
  vec3 h = abs(f.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 b1 = normalize(cross(f, h));
  vec3 b2 = cross(b1, f);
  float s = mod(aS.z * ${L_SPAN.toFixed(1)} - uDist * (0.85 + 0.3 * aS.w), ${L_SPAN.toFixed(1)}) - ${(L_SPAN * 0.12).toFixed(1)};
  float ang, rad;
  if (aG > 0.5) { ang = uWallAng + (aS.x - 0.5) * 1.1; rad = uWallR * (0.78 + 0.2 * aS.y); }
  else { ang = aS.x * 6.2831853; rad = mix(uRMin, uRMax, pow(aS.y, 0.75)); }
  vec3 head = f * s + (b1 * cos(ang) + b2 * sin(ang)) * rad;
  float len = uLen * (0.55 + 0.9 * aS.w) * (aG > 0.5 ? 1.5 : 1.0);
  vec3 tail = head + f * len;
  // clip to the near plane (view space looks down -z)
  float zc = -uNear;
  if (head.z > zc && tail.z > zc) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vT = 0.0; vG = 0.0; return; }
  if (head.z > zc) head = mix(tail, head, (tail.z - zc) / (tail.z - head.z));
  if (tail.z > zc) tail = mix(head, tail, (head.z - zc) / (head.z - tail.z));
  vec4 ch = projectionMatrix * vec4(head, 1.0), ct = projectionMatrix * vec4(tail, 1.0);
  vec2 sh = ch.xy / ch.w, st = ct.xy / ct.w;
  vec2 dir = (sh - st) * uRes; float dl = length(dir);
  dir = dl > 1e-4 ? dir / dl : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x) / uRes * 2.0;
  vT = position.x;
  vec4 c = position.x < 0.5 ? ch : ct;
  // closer streaks are fatter (a few px), far ones hairlines
  float wpx = uWidth * clamp(10.0 / max(-head.z, 0.5), 0.6, 2.2) * (position.x < 0.5 ? 1.0 : 0.4);
  c.xy += nrm * position.y * wpx * c.w;
  gl_Position = c;
  // fade in from the far end, keep the screen centre (the racing line) clear
  float far = 1.0 - smoothstep(${(L_SPAN * 0.55).toFixed(1)}, ${(L_SPAN * 0.88).toFixed(1)}, s);
  vec2 own = position.x < 0.5 ? sh : st;               // per-end mask: tails fade before the centre too
  float rc = length(own * vec2(uRes.x / uRes.y, 1.0));
  float centre = smoothstep(0.22, 0.72, rc);
  float close = 0.35 + 0.65 * smoothstep(3.0, 14.0, length(head));   // no fat bars right at the lens
  vA = uAlpha * aS.w * far * centre * close * (aG > 0.5 ? uWallA : 1.0);
  vG = aG;
}`;
const STREAK_FS = /* glsl */`
uniform vec3 uColor, uWallColor;
varying float vT; varying float vA; varying float vG;
void main(){
  float a = vA * pow(clamp(1.0 - vT, 0.0, 1.0), 1.6);
  if (a < 0.003) discard;
  vec3 col = mix(uColor, uWallColor, vG) * (1.0 + (1.0 - vT) * 0.8);
  gl_FragColor = vec4(col * a, 1.0);
}`;

// ================================================================ shock cone / rings
const SHOCK_VS = /* glsl */`
varying vec3 vN; varying vec3 vV; varying float vZ;
void main(){
  vZ = position.z;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const SHOCK_FS = /* glsl */`
uniform vec3 uColor; uniform float uAmt, uTime;
varying vec3 vN; varying vec3 vV; varying float vZ;
void main(){
  float nv = clamp(abs(dot(normalize(vN + 1e-5), normalize(vV))), 0.0, 1.0);
  float rim = pow(1.0 - nv, 2.2);
  float t = (vZ + 1.0) * 0.5;                        // 0 apex .. 1 open end
  float bands = 0.72 + 0.28 * sin(vZ * 22.0 - uTime * 55.0);
  float fl = 0.8 + 0.2 * sin(uTime * 83.0 + vZ * 5.0);
  float a = uAmt * (0.12 + rim * 0.9) * bands * fl * smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.55, 1.0, t));
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const RING_FS = /* glsl */`
uniform vec3 uColor; uniform float uAmt, uTime;
varying vec3 vN; varying vec3 vV; varying float vZ;
void main(){
  float nv = clamp(abs(dot(normalize(vN + 1e-5), normalize(vV))), 0.0, 1.0);
  float a = uAmt * (0.35 + 0.65 * pow(1.0 - nv, 1.5));
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
// flat annulus with a soft profile (radius 1 in local XY), for the sonic boom wave
const BOOM_VS = /* glsl */`
varying vec2 vP;
void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BOOM_FS = /* glsl */`
uniform vec3 uColor; uniform float uAmt, uW;
varying vec2 vP;
void main(){
  float r = length(vP);
  float x = (r - (1.0 - uW)) / uW;
  float a = exp(-x * x * 3.0) * uAmt;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

function machConeGeometry() {
  // apex at z = -1 (ahead of the nose), opening backwards to radius 1 at z = +1, slight bulge
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new THREE.Vector2(Math.pow(t, 0.8) * 1.0, -1 + 2 * t));
  }
  const g = new THREE.LatheGeometry(pts, 32);
  g.rotateX(Math.PI / 2);    // lathe axis Y -> Z (profile y -> z, so the apex lands at z = -1)
  g.computeVertexNormals();
  return g;
}

// ================================================================ SpeedFX
export class SpeedFX {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {{quality?:'high'|'medium'|'low', reduceMotion?:boolean, level?:'full'|'reduced'|'off', color?:string, wallColor?:string, topSpeed?:number}} o
   *   topSpeed: m/s that speedN 1 maps to when no `velocity` is given (default 130).
   *   level: the speed effects setting (default 'full').
   */
  constructor(scene, camera, { quality = 'high', reduceMotion = false, level = 'full', color = '#cfe4ff', wallColor = '#ffc27a', topSpeed = 130 } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.q = QUALITY[quality] || QUALITY.high;
    this.reduceMotion = reduceMotion;
    this.topSpeed = topSpeed;
    this.pass = null;
    this.enabled = true;
    this._r = rng(777);
    this._spec = makeSpec();
    this._time = 0; this._dist = 0;
    this._alpha = 0; this._ss = 0; this._wall = 0; this._nm = 0; this._boost = 0; this._wasSS = false;
    this._exhaust = 0; this._sparkAcc = 0;
    this._boom = { t: -1, c: new THREE.Vector2(0.5, 0.5) };
    this.fovKick = 0;        // extra degrees the caller may add to camera.fov
    this.shake = 0;          // extra shake (same units as FlightRace.shake) the caller may add
    this._fovImp = 0;
    this._pad = { t: -1, amt: 0, c: new THREE.Vector2(0.5, 0.5) };

    // ---- streaks
    const n = this.q.streaks;
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    const aS = new Float32Array(n * 4), aG = new Float32Array(n);
    const r = this._r;
    for (let i = 0; i < n; i++) {
      aS[i * 4] = r(); aS[i * 4 + 1] = r(); aS[i * 4 + 2] = r(); aS[i * 4 + 3] = 0.35 + 0.65 * r() * r() + (r() < 0.08 ? 0.6 : 0);
      aG[i] = i % 4 === 0 ? 1 : 0;   // a quarter of them hug the wall when skimming
    }
    geo.setAttribute('aS', new THREE.InstancedBufferAttribute(aS, 4));
    geo.setAttribute('aG', new THREE.InstancedBufferAttribute(aG, 1));
    geo.instanceCount = n;
    this._streakGeo = geo;
    this.su = {
      uFlow: { value: new THREE.Vector3(0, 0, -1) }, uDist: { value: 0 }, uLen: { value: 4 },
      uRMin: { value: 2.2 }, uRMax: { value: 26 }, uAlpha: { value: 0 }, uWallA: { value: 0 },
      uWallAng: { value: 0 }, uWallR: { value: 12 }, uWidth: { value: 1.6 }, uNear: { value: camera.near * 1.05 },
      uRes: { value: new THREE.Vector2(1280, 720) }, uColor: { value: new THREE.Color(color) }, uWallColor: { value: new THREE.Color(wallColor) },
    };
    this._baseColor = new THREE.Color(color);
    this._streakMat = new THREE.ShaderMaterial({
      uniforms: this.su, vertexShader: STREAK_VS, fragmentShader: STREAK_FS,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.streaks = new THREE.Mesh(geo, this._streakMat);
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 16;
    this.streaks.visible = false;
    // (the streak shader works in view space from uniforms; the mesh transform is unused)
    scene.add(this.streaks);

    // ---- sparks / flares
    this.add = new BillboardPool(scene, this.q.sparks, THREE.AdditiveBlending, 23);

    // ---- supersonic shell
    this.cu = { uColor: { value: C_SHOCK.clone() }, uAmt: { value: 0 }, uTime: { value: 0 } };
    this._coneMat = new THREE.ShaderMaterial({ uniforms: this.cu, vertexShader: SHOCK_VS, fragmentShader: SHOCK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.cone = new THREE.Mesh(machConeGeometry(), this._coneMat);
    this.cone.frustumCulled = false; this.cone.visible = false; this.cone.renderOrder = 21;
    scene.add(this.cone);
    this.ru = { uColor: { value: new THREE.Color(0.9, 0.97, 1.0) }, uAmt: { value: 0 }, uTime: this.cu.uTime };
    this._collarMat = new THREE.ShaderMaterial({ uniforms: this.ru, vertexShader: SHOCK_VS, fragmentShader: RING_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.collar = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 6, 48), this._collarMat);
    this.collar.frustumCulled = false; this.collar.visible = false; this.collar.renderOrder = 21;
    scene.add(this.collar);
    // sonic boom rings (pooled)
    this.booms = [];
    const boomGeo = new THREE.RingGeometry(0.0, 1, 64, 1);
    for (let i = 0; i < 3; i++) {
      const u = { uColor: { value: new THREE.Color(0.85, 0.95, 1.0) }, uAmt: { value: 0 }, uW: { value: 0.2 } };
      const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: BOOM_VS, fragmentShader: BOOM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(boomGeo, mat);
      mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 21;
      scene.add(mesh);
      this.booms.push({ mesh, mat, u, t: 1, life: 0.9, r0: 3, r1: 70, vel: new THREE.Vector3() });
    }
    this._boomGeo = boomGeo;
    this.setLevel(level, reduceMotion);
    if (typeof window !== 'undefined') this.setSize(window.innerWidth, window.innerHeight);
  }

  /** Apply the speed effects setting (cheap; safe to call every frame). */
  setLevel(level, reduceMotion = this.reduceMotion) {
    const k = speedLevel(level, reduceMotion);
    if (k === this.level && !!reduceMotion === this.reduceMotion) return;
    this.level = k;
    this.reduceMotion = !!reduceMotion;
    this.levels = SPEED_LEVELS[k];
    this._streakGeo.instanceCount = Math.round(this.q.streaks * this.levels.streaks);
  }

  /** Viewport size in CSS pixels (streak width is in pixels). Call on resize. */
  setSize(w, h) { this.su.uRes.value.set(Math.max(1, w), Math.max(1, h)); }

  /** Let SpeedFX drive a pass from createSpeedPass(). */
  attachPass(pass) { this.pass = pass; return pass; }

  /** Trigger a sonic boom (also fired automatically on the supersonic rising edge). */
  boom(pos, dir = null, velocity = null, strength = 1) {
    const rm = this.reduceMotion;
    let b = this.booms[0];
    for (const x of this.booms) if (x.t > b.t) b = x;
    b.t = 0; b.life = 0.85; b.r0 = 2.5; b.r1 = rm ? 35 : 75 * strength; b.strength = (rm ? 0.5 : 1) * strength;
    b.u.uColor.value.setRGB(0.85, 0.95, 1.0);
    b.mesh.position.copy(pos);
    if (dir && dir.lengthSq() > 1e-6) { _v.copy(dir).normalize(); b.mesh.quaternion.setFromUnitVectors(_v2.set(0, 0, 1), _v); }
    b.vel.copy(velocity || _v.set(0, 0, 0)).multiplyScalar(0.94);   // the shock front rides with the ship, then falls behind
    b.mesh.visible = true;
    // flash + camera-facing ring
    const o = this._spec, r = this._r;
    resetSpec(o); o.shape = 1; o.px = pos.x; o.py = pos.y; o.pz = pos.z;
    if (velocity) { o.vx = velocity.x * 0.97; o.vy = velocity.y * 0.97; o.vz = velocity.z * 0.97; }
    o.life = 0.2; o.s0 = 5; o.s1 = 14; o.fadePow = 2.4; o.alpha = rm ? 0.3 : 0.8;
    o.r0 = 1.2; o.g0 = 1.4; o.b0 = 1.7; o.r1 = 0.4; o.g1 = 0.55; o.b1 = 0.9;
    this.add.spawn(o);
    resetSpec(o); o.shape = 2; o.px = pos.x; o.py = pos.y; o.pz = pos.z;
    if (velocity) { o.vx = velocity.x * 0.94; o.vy = velocity.y * 0.94; o.vz = velocity.z * 0.94; }
    o.life = 0.5; o.s0 = 6; o.s1 = rm ? 30 : 60; o.ease = 2.4; o.fadePow = 1.5; o.rot = r() * 6.28; o.alpha = rm ? 0.3 : 0.7;
    o.r0 = 0.9; o.g0 = 1.05; o.b0 = 1.25; o.r1 = 0.3; o.g1 = 0.4; o.b1 = 0.6;
    this.add.spawn(o);
    // shock vapour: a burst of streaks peeling back off the ship
    for (let i = 0; i < 26; i++) {
      resetSpec(o); randUnit(r, _v3);
      o.shape = 3; o.px = pos.x + _v3.x * 3; o.py = pos.y + _v3.y * 3; o.pz = pos.z + _v3.z * 3;
      const sp = 25 + r() * 35;
      const vx = velocity ? velocity.x * 0.55 : 0, vy = velocity ? velocity.y * 0.55 : 0, vz = velocity ? velocity.z * 0.55 : 0;
      o.vx = vx + _v3.x * sp; o.vy = vy + _v3.y * sp; o.vz = vz + _v3.z * sp;
      o.drag = 2; o.life = 0.35 + r() * 0.35; o.s0 = o.s1 = 0.12; o.streak = 0.05; o.fadePow = 1.2; o.alpha = rm ? 0.4 : 0.9;
      setCol3(o, C_SHOCK, 2.2, C_SHOCK, 0.6);
      this.add.spawn(o);
    }
    if (!rm) { this._fovImp = Math.max(this._fovImp, 9 * strength * this.levels.fov); this.shake = Math.max(this.shake, 0.6 * strength); }
    // screen-space ripple centre
    const cam = this.camera;
    _v.copy(pos).project(cam);
    if (_v.z < 1) { this._boom.c.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5); this._boom.t = 0; }
  }

  /**
   * The player took a boost pad. Big: amber shockwave ring (screen + 3D), warm edge flash,
   * gold spark burst and a short FOV punch. Small: a subtle tick.
   * @param {boolean} big
   * @param {THREE.Vector3} [pos] ship position
   * @param {THREE.Vector3} [velocity] ship velocity
   */
  padHit(big, pos = null, velocity = null) {
    const rm = this.reduceMotion, F = this.levels, o = this._spec, r = this._r;
    const vx = velocity ? velocity.x : 0, vy = velocity ? velocity.y : 0, vz = velocity ? velocity.z : 0;
    if (!big) {
      this._fovImp = Math.max(this._fovImp, 1.4 * F.fov);
      if (pos && this.enabled) {
        for (let i = 0; i < 6; i++) {
          resetSpec(o); randUnit(r, _v3);
          o.shape = 3; o.px = pos.x; o.py = pos.y; o.pz = pos.z;
          o.vx = vx * 0.8 + _v3.x * 14; o.vy = vy * 0.8 + _v3.y * 14; o.vz = vz * 0.8 + _v3.z * 14;
          o.drag = 3; o.life = 0.25; o.s0 = o.s1 = 0.07; o.fadePow = 1.2; o.alpha = 0.8;
          setCol3(o, C_PAD, 2.4, C_PAD, 0.8);
          this.add.spawn(o);
        }
      }
      return;
    }
    this._fovImp = Math.max(this._fovImp, 6 * F.fov);
    if (!rm) this.shake = Math.max(this.shake, 0.25);
    this._pad.t = 0;
    this._pad.amt = rm ? 0.4 : 1;
    this._pad.c.set(0.5, 0.5);
    if (pos) {
      _v.copy(pos).project(this.camera);
      if (_v.z < 1) this._pad.c.set(Math.min(0.9, Math.max(0.1, _v.x * 0.5 + 0.5)), Math.min(0.9, Math.max(0.1, _v.y * 0.5 + 0.5)));
    }
    if (!pos || !this.enabled) return;
    // 3D ring round the ship, facing the direction of travel (shares the boom pool)
    let b = this.booms[0];
    for (const x of this.booms) if (x.t > b.t) b = x;
    b.t = 0; b.life = 0.6; b.r0 = 2; b.r1 = rm ? 16 : 30; b.strength = rm ? 0.6 : 1.3;
    b.u.uColor.value.copy(C_PAD).multiplyScalar(1.6);
    b.mesh.position.copy(pos);
    if (velocity && velocity.lengthSq() > 1e-6) { _v.copy(velocity).normalize(); b.mesh.quaternion.setFromUnitVectors(_v2.set(0, 0, 1), _v); }
    b.vel.copy(velocity || _v.set(0, 0, 0)).multiplyScalar(0.97);
    b.mesh.visible = true;
    // hot flash at the ship + a gold spark burst
    resetSpec(o); o.shape = 1; o.px = pos.x; o.py = pos.y; o.pz = pos.z;
    o.vx = vx * 0.98; o.vy = vy * 0.98; o.vz = vz * 0.98;
    o.life = 0.22; o.s0 = 4; o.s1 = 11; o.fadePow = 2.2; o.alpha = rm ? 0.35 : 0.75;
    setCol3(o, C_PAD, 2.2, C_PAD, 0.6);
    this.add.spawn(o);
    for (let i = 0; i < (rm ? 10 : 28); i++) {
      resetSpec(o); randUnit(r, _v3);
      o.shape = 3; o.px = pos.x + _v3.x * 1.5; o.py = pos.y + _v3.y * 1.5; o.pz = pos.z + _v3.z * 1.5;
      const sp = 18 + r() * 30;
      o.vx = vx * 0.7 + _v3.x * sp; o.vy = vy * 0.7 + _v3.y * sp; o.vz = vz * 0.7 + _v3.z * sp;
      o.drag = 2.2; o.life = 0.3 + r() * 0.35; o.s0 = o.s1 = 0.1; o.streak = 0.05; o.fadePow = 1.2; o.alpha = 0.95;
      setCol3(o, C_PAD, 3.0, C_SPARK1, 0.9);
      this.add.spawn(o);
    }
  }

  /**
   * Call every rendered frame after the camera is placed.
   * @param {number} dt
   * @param {object} s
   *   speedN 0..1.5 (forward speed / top speed), boost bool, supersonic bool,
   *   wall 0..1 (1 = touching the tunnel wall), wallPoint Vector3|null (nearest wall / contact point),
   *   nearMiss 0..1 (pass a pulse on the frame a near miss happens; continuous values also work),
   *   velocity Vector3 (ship world velocity; optional but makes the flow exact),
   *   shipPos Vector3, shipQuat Quaternion (needed for the Mach cone / boom), craft (optional:
   *   whitens craft.flameMat and places Mach diamonds at craft.nozzles), wallNormal Vector3|null
   *   (unit, pointing into the tunnel; optional, improves the spark spray).
   */
  update(dt, s = {}) {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    const cam = this.camera;
    const rm = this.reduceMotion;
    this._time += dt;
    const speedN = Math.max(0, +s.speedN || 0);
    const boost = s.boost ? 1 : 0;
    const ss = s.supersonic ? 1 : 0;
    const vel = s.velocity || null;
    const speed = vel ? vel.length() : speedN * this.topSpeed;
    const k = 1 - Math.exp(-dt * 6);
    this._boost += (boost - this._boost) * k;
    this._ss += (ss - this._ss) * (1 - Math.exp(-dt * (ss ? 10 : 4)));
    const wallIn = Math.max(0, Math.min(1, +s.wall || 0));
    const skim = smooth(0.7, 0.97, wallIn) * Math.min(1, speedN * 1.5);
    this._wall += (skim - this._wall) * (1 - Math.exp(-dt * 10));
    this._nm = Math.max(this._nm * Math.exp(-dt * 7), Math.max(0, Math.min(1, +s.nearMiss || 0)));

    // ---- flow direction in view space
    _qi.copy(cam.quaternion).invert();
    const flow = this.su.uFlow.value;
    if (vel && speed > 1) flow.copy(vel).divideScalar(speed).applyQuaternion(_qi);
    else flow.set(0, 0, -1);
    if (flow.z > -0.2) { flow.z = -0.2; }   // never let the flow axis swing behind the camera
    flow.normalize();

    // ---- streak intensity / length
    const spd = smooth(0.25, 1.0, speedN);
    let a = Math.min(0.62, spd * 0.34 + this._boost * 0.2 + this._ss * 0.1) + this._nm * 0.45;   // present, but the ships and the line stay the subject
    if (rm) a *= 0.35;
    a *= this.levels.streaks > 0 ? 0.6 + 0.4 * this.levels.streaks : 0;
    this._alpha += (a - this._alpha) * k;
    const su = this.su;
    su.uAlpha.value = this.enabled ? this._alpha : 0;
    // exaggerate the flow so 130 m/s reads like a pod race (the wall streaks already move at 1.15x)
    const flowSpeed = speed * (1.7 + 0.6 * this._boost + 0.8 * this._ss) * (rm ? 0.6 : 1);
    this._dist = (this._dist + flowSpeed * dt) % 100000;
    su.uDist.value = this._dist;
    su.uLen.value = Math.min(20, 2 + speed * (0.06 + 0.025 * this._boost + 0.015 * this._ss)) * (rm ? 0.6 : 1);
    su.uWidth.value = 1.3 + 0.2 * this._ss + 0.2 * this._boost;
    su.uNear.value = cam.near * 1.05;
    _c.copy(this._baseColor).lerp(C_WHITE, this._ss * 0.6);
    if (this._boost > 0.01) _c.lerp(C_BOOST, this._boost * 0.25);
    su.uColor.value.copy(_c);
    this.streaks.visible = su.uAlpha.value > 0.003;

    // ---- wall group placement
    if (s.wallPoint && this._wall > 0.01) {
      _v.copy(s.wallPoint).applyMatrix4(cam.matrixWorldInverse);       // wall point in view space
      // decompose relative to the flow axis
      const along = _v.dot(flow);
      _v2.copy(_v).addScaledVector(flow, -along);
      const rad = _v2.length();
      // angle in the shader's (b1, b2) basis
      _v3.set(Math.abs(flow.y) < 0.9 ? 0 : 1, Math.abs(flow.y) < 0.9 ? 1 : 0, 0);
      const b1 = _v3.crossVectors(flow, _v3).normalize();
      const b1x = b1.x, b1y = b1.y, b1z = b1.z;
      const b2x = b1y * flow.z - b1z * flow.y, b2y = b1z * flow.x - b1x * flow.z, b2z = b1x * flow.y - b1y * flow.x;
      const c1 = _v2.x * b1x + _v2.y * b1y + _v2.z * b1z, c2 = _v2.x * b2x + _v2.y * b2y + _v2.z * b2z;
      su.uWallAng.value = Math.atan2(c2, c1);
      su.uWallR.value = Math.max(2.5, Math.min(40, rad));
    }
    su.uWallA.value = this._wall * (rm ? 0.5 : 1.25) * (this.levels.streaks > 0 ? 1 : 0);

    // ---- wall spray sparks
    this._sparks(dt, s, vel, speed, wallIn, rm);

    // ---- supersonic shell
    const shipPos = s.shipPos, shipQuat = s.shipQuat;
    const shell = this._ss * (rm ? 0.4 : 1) * (this.enabled ? 1 : 0);
    this.cu.uTime.value = this._time;
    if (shipPos && shipQuat && shell > 0.01) {
      const flick = 0.85 + 0.15 * Math.sin(this._time * 47);
      this.cone.visible = true;
      this.cone.position.copy(shipPos).addScaledVector(_v.set(0, 0, 0.4).applyQuaternion(shipQuat), 1);
      this.cone.quaternion.copy(shipQuat);
      const pulse = 1 + 0.03 * Math.sin(this._time * 31);
      this.cone.scale.set(3.6 * pulse, 3.2 * pulse, 5.2);
      this.cu.uAmt.value = shell * 0.4 * flick;
      this.collar.visible = true;
      this.collar.position.copy(shipPos).addScaledVector(_v.set(0, 0, -3.1).applyQuaternion(shipQuat), 1);
      this.collar.quaternion.copy(shipQuat);
      const cs = 1.5 + 0.12 * Math.sin(this._time * 23);
      this.collar.scale.set(cs, cs, cs);
      this.ru.uAmt.value = shell * 0.8;
    } else { this.cone.visible = false; this.collar.visible = false; }
    // exhaust: whiter flame + Mach diamonds
    this._exhaust += (this._ss - this._exhaust) * k;
    const craft = s.craft;
    if (craft && craft.flameMat && craft.glowColor) {
      craft.flameMat.uniforms.uColor.value.copy(craft.glowColor).lerp(C_WHITE, this._exhaust * 0.7 + this._boost * 0.15);
      if (this._exhaust > 0.05 && craft.root && craft.root.visible && this.enabled) this._diamonds(craft, this._exhaust * (rm ? 0.5 : 1), vel);
    }
    // sonic boom on the rising edge
    if (ss && !this._wasSS && shipPos) this.boom(shipPos, vel, vel, 1);
    this._wasSS = !!ss;
    for (const b of this.booms) {
      if (b.t >= 1) continue;
      b.t = Math.min(1, b.t + dt / b.life);
      const e = 1 - Math.pow(1 - b.t, 2.6);
      const R = b.r0 + (b.r1 - b.r0) * e;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.scale.set(R, R, R);
      b.u.uAmt.value = Math.pow(1 - b.t, 1.5) * 0.55 * (b.strength ?? 1);
      b.u.uW.value = 0.035 + 0.07 * (1 - b.t);
      if (b.t >= 1) b.mesh.visible = false;
    }

    this.add.update(dt);

    // ---- camera punch outputs
    this._fovImp *= Math.exp(-dt * 3.5);
    this.shake *= Math.exp(-dt * 4);
    this.fovKick = rm ? 0 : this._fovImp + (this._nm * 3 + this._ss * 4) * this.levels.fov;
    if (rm) this.shake = 0;

    // ---- pass
    if (this.pass) this._drivePass(dt, speedN, vel, speed, rm);
  }

  _sparks(dt, s, vel, speed, wallIn, rm) {
    const wp = s.wallPoint;
    if (!wp || !this.enabled) { this._sparkAcc = 0; return; }
    const grind = smooth(0.82, 1.0, wallIn) * Math.min(1.2, speed / 60);
    if (grind <= 0.01) { this._sparkAcc = 0; return; }
    const r = this._r, o = this._spec;
    const rate = (rm ? 90 : 420) * grind;
    this._sparkAcc += rate * dt;
    // inward normal: given, else from the wall point toward the camera
    const n = s.wallNormal ? _v2.copy(s.wallNormal) : _v2.subVectors(this.camera.position, wp).normalize();
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;
    let guard = 64;
    while (this._sparkAcc >= 1 && guard-- > 0) {
      this._sparkAcc -= 1;
      resetSpec(o); randUnit(r, _v3);
      o.shape = 3;
      o.px = wp.x + _v3.x * 0.6; o.py = wp.y + _v3.y * 0.6; o.pz = wp.z + _v3.z * 0.6;
      const lag = 0.25 + r() * 0.55;              // sparks drag behind the ship -> rush past the camera
      const out = 4 + r() * 22;
      o.vx = vx * lag + n.x * out + _v3.x * 10; o.vy = vy * lag + n.y * out + _v3.y * 10; o.vz = vz * lag + n.z * out + _v3.z * 10;
      o.drag = 1.6 + r(); o.life = 0.18 + r() * 0.4; o.s0 = o.s1 = 0.06 + r() * 0.06; o.streak = 0.04; o.fadePow = 1.1;
      setCol3(o, C_SPARK0, 3.2 + r(), C_SPARK1, 1.2);
      this.add.spawn(o);
    }
    if (this._sparkAcc > 4) this._sparkAcc = 0;
    // hot contact flare
    if (grind > 0.3) {
      resetSpec(o);
      o.shape = 1; o.px = wp.x; o.py = wp.y; o.pz = wp.z;
      o.vx = vx * 0.9; o.vy = vy * 0.9; o.vz = vz * 0.9;
      o.life = Math.max(0.05, dt * 1.6); o.s0 = o.s1 = 2.2 + grind * 2 + r(); o.fadePow = 1; o.alpha = 0.7 * grind;
      setCol3(o, C_SPARK0, 2.4, C_SPARK1, 1.6);
      this.add.spawn(o);
    }
  }

  _diamonds(craft, k, vel) {
    const o = this._spec;
    const mw = craft.root.matrixWorld;
    for (let i = 0; i < craft.nozzles.length; i++) {
      const nz = craft.nozzles[i];
      for (let j = 0; j < 4; j++) {
        _v.set(nz.pos.x, nz.pos.y, nz.pos.z + 0.6 + j * (0.9 + nz.r * 0.9)).applyMatrix4(mw);
        resetSpec(o);
        o.shape = 1; o.px = _v.x; o.py = _v.y; o.pz = _v.z;
        if (vel) { o.vx = vel.x; o.vy = vel.y; o.vz = vel.z; }
        o.life = 0.034; o.s0 = o.s1 = nz.r * (0.9 - j * 0.15) * (0.85 + 0.3 * Math.sin(this._time * 70 + j * 2 + i)); o.fadePow = 0.5;
        o.alpha = k * (1 - j * 0.2);
        o.r0 = 2.2; o.g0 = 2.3; o.b0 = 2.6; o.r1 = 1.4; o.g1 = 1.6; o.b1 = 2.0;
        this.add.spawn(o);
      }
    }
  }

  _drivePass(dt, speedN, vel, speed, rm) {
    const u = this.pass.uniforms, cam = this.camera;
    // Supersonic used to add +0.45 (pinning the blur at 1); it now adds a little on top of the
    // boost blur, so full-speed supersonic sits ~25% under the old strength.
    const F = this.levels;
    let str = smooth(0.55, 1.15, speedN) * 0.45 + this._boost * 0.25 + this._ss * 0.06 + this._nm * 0.3;
    if (rm) str *= 0.25;
    str *= F.blur;
    if (!this.enabled) str = 0;
    u.uStrength.value += (Math.min(1, str) - u.uStrength.value) * (1 - Math.exp(-dt * 6));
    u.uAberr.value = rm ? 0 : (0.003 + this._ss * 0.0024) * Math.min(1, F.blur * 1.5);
    u.uBoomAmp.value = 0.022 * (F.blur > 0 ? Math.max(0.5, F.blur) : 0);
    u.uFlash.value = rm ? this._nm * 0.3 : this._nm;
    u.uAspect.value = cam.aspect || 1.7778;
    // focus of expansion = where we're heading on screen
    if (vel && speed > 1) {
      _v.copy(vel).divideScalar(speed).multiplyScalar(1000).add(cam.position).project(cam);
      if (_v.z < 1 && Math.abs(_v.x) < 1.5 && Math.abs(_v.y) < 1.5) {
        const tx = Math.min(0.85, Math.max(0.15, _v.x * 0.5 + 0.5)), ty = Math.min(0.85, Math.max(0.15, _v.y * 0.5 + 0.5));
        const c = u.uCenter.value; const kk = 1 - Math.exp(-dt * 8);
        c.x += (tx - c.x) * kk; c.y += (ty - c.y) * kk;
      }
    }
    const b = this._boom;
    if (b.t >= 0) {
      b.t += dt / 0.7;
      if (b.t >= 1 || rm) b.t = -1;
    }
    u.uBoomT.value = b.t;
    u.uBoomC.value.copy(b.c);
    const pad = this._pad;
    if (pad.t >= 0) { pad.t += dt / 0.55; if (pad.t >= 1) pad.t = -1; }
    u.uPadT.value = this.enabled ? pad.t : -1;
    u.uPadAmt.value = pad.amt;
    u.uPadC.value.copy(pad.c);
    this.pass.enabled = u.uStrength.value > 0.004 || u.uFlash.value > 0.004 || b.t >= 0 || u.uPadT.value >= 0;
  }

  /** Live draw calls + triangles (for the perf HUD). */
  stats() {
    let calls = 0, tris = 0;
    if (this.streaks.visible) { calls++; tris += this.q.streaks * 2; }
    if (this.add.n) { calls++; tris += this.add.n * 2; }
    if (this.cone.visible) { calls += 2; tris += 32 * 12 * 2 + 48 * 6 * 2; }
    for (const b of this.booms) if (b.mesh.visible) { calls++; tris += 128; }
    return { calls, tris, particles: this.add.n, passOn: !!this.pass?.enabled };
  }

  dispose() {
    this.scene.remove(this.streaks, this.cone, this.collar);
    this._streakGeo.dispose(); this._streakMat.dispose();
    this.cone.geometry.dispose(); this._coneMat.dispose();
    this.collar.geometry.dispose(); this._collarMat.dispose();
    for (const b of this.booms) { this.scene.remove(b.mesh); b.mat.dispose(); }
    this._boomGeo.dispose();
    this.add.dispose();
  }
}

function setCol3(o, c0, k0, c1, k1) { o.r0 = c0.r * k0; o.g0 = c0.g * k0; o.b0 = c0.b * k0; o.r1 = c1.r * k1; o.g1 = c1.g * k1; o.b1 = c1.b * k1; }

// ================================================================ post pass
const SpeedShader = {
  name: 'SpeedShader',
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0 },
    uAberr: { value: 0.0045 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(0.75, 0.9, 1.0) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1.7778 },
    uBoomT: { value: -1 },
    uBoomC: { value: new THREE.Vector2(0.5, 0.5) },
    uBoomAmp: { value: 0.022 },
    uPadT: { value: -1 },
    uPadAmt: { value: 1 },
    uPadC: { value: new THREE.Vector2(0.5, 0.5) },
    uPadColor: { value: new THREE.Color(1.0, 0.68, 0.26) },
  },
  vertexShader: /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform float uStrength, uAberr, uFlash, uAspect, uBoomT, uBoomAmp, uPadT, uPadAmt;
uniform vec3 uFlashColor, uPadColor;
uniform vec2 uCenter, uBoomC, uPadC;
varying vec2 vUv;
void main(){
  vec2 uv = vUv;
  vec2 asp = vec2(uAspect, 1.0);
  // sonic boom: a refraction ripple racing outward from the ship
  if (uBoomT >= 0.0) {
    vec2 d = (uv - uBoomC) * asp;
    float r = length(d);
    float R = 0.05 + uBoomT * 1.5;
    float w = 0.035 + 0.07 * uBoomT;
    float x = (r - R) / w;
    float k = x * exp(-x * x) * (1.0 - uBoomT) * uBoomAmp;
    uv -= (d / max(r, 1e-4)) / asp * k;
  }
  // big boost pad: an amber shockwave racing out from the ship (a ripple + a bright ring)
  float padRing = 0.0;
  if (uPadT >= 0.0) {
    vec2 pd = (vUv - uPadC) * asp;
    float pr = length(pd);
    float px = (pr - (0.03 + uPadT * 1.25)) / (0.022 + 0.05 * uPadT);
    float pf = pow(1.0 - uPadT, 1.6) * uPadAmt;
    padRing = exp(-px * px) * pf;
    uv -= (pd / max(pr, 1e-4)) / asp * px * exp(-px * px) * pf * 0.012;
  }
  vec2 d = uv - uCenter;
  float rr = length(d * asp);
  float m = smoothstep(0.2, 0.95, rr) * uStrength;
  vec4 base = texture2D(tDiffuse, uv);
  vec3 col = base.rgb;
  if (m > 0.002) {
    vec3 acc = col; float ws = 1.0;
    // per-pixel jittered taps: smooth streaks instead of a dotted ghost trail
    float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    for (int i = 1; i < 10; i++) {
      float t = (float(i) - jit) / 9.0;
      float w = 1.0 - t * 0.65;
      acc += texture2D(tDiffuse, uCenter + d * (1.0 - m * 0.07 * t)).rgb * w; ws += w;
    }
    col = acc / ws;
    float ab = uAberr * m + uFlash * 0.003;
    col.r = mix(col.r, texture2D(tDiffuse, uCenter + d * (1.0 + ab)).r, 0.6);
    col.b = mix(col.b, texture2D(tDiffuse, uCenter + d * (1.0 - ab)).b, 0.6);
  } else if (uFlash > 0.002) {
    float ab = uFlash * 0.003;
    col.r = mix(col.r, texture2D(tDiffuse, uCenter + d * (1.0 + ab)).r, 0.6);
    col.b = mix(col.b, texture2D(tDiffuse, uCenter + d * (1.0 - ab)).b, 0.6);
  }
  // near miss: brief cold flash at the screen edges
  col += uFlashColor * uFlash * smoothstep(0.45, 1.1, rr) * 0.3;
  if (uPadT >= 0.0) {
    float re = length((vUv - 0.5) * asp);
    col += uPadColor * (padRing * 0.85 + pow(1.0 - uPadT, 5.0) * uPadAmt * 0.32 * smoothstep(0.12, 1.0, re));
  }
  gl_FragColor = vec4(col, base.a);
}`,
};

/**
 * Radial zoom blur + edge chromatic aberration + sonic-boom ripple + near-miss edge flash +
 * boost-pad shockwave (uPadT -1 off / 0..1, uPadC, uPadAmt).
 * Insert after the RenderPass and before UnrealBloomPass (HDR in, HDR out). Starts disabled;
 * SpeedFX.attachPass(pass) drives `uniforms` and `enabled`. Uniforms: uStrength 0..1,
 * uCenter (uv of the focus of expansion), uAberr, uFlash 0..1, uBoomT (-1 off, 0..1), uBoomC.
 */
export function createSpeedPass() {
  const pass = new ShaderPass(SpeedShader);
  pass.enabled = false;
  return pass;
}
