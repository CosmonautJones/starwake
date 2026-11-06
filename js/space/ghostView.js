// The ghost's look: the player's own craft rebuilt as a translucent hologram (fresnel rim,
// drifting scan lines, additive, no depth write, unlit). Purely visual: it is never added
// to the race's entities, so nothing collides with it, targets it or ranks it.

import * as THREE from 'three';
import { buildCraft } from '../craft/craftMesh.js';
import { GhostRecorder, decodeGhost } from '../flight/ghost.js';

const GHOST_COLOR = new THREE.Color('#8fe9ff');
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _out = {};

function holoMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vL;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mv.xyz;
        vL = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uTime; uniform float uOpacity;
      varying vec3 vN; varying vec3 vV; varying vec3 vL;
      void main() {
        float fr = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        fr = fr * fr;
        float scan = 0.6 + 0.4 * sin(vL.z * 7.0 - uTime * 5.0);
        float band = smoothstep(0.92, 1.0, sin(vL.z * 1.3 + uTime * 2.2));
        vec3 c = uColor * (0.22 + fr * 1.5 + band * 0.5) * scan;
        gl_FragColor = vec4(c * uOpacity, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

export class GhostView {
  constructor(scene, design) {
    this.scene = scene;
    this.craft = buildCraft(design, { lod: 'low', underglow: false });
    this.mat = holoMaterial(GHOST_COLOR);
    const flames = new Set(this.craft.flames);
    this.craft.root.traverse((o) => {
      if (!o.isMesh || flames.has(o)) return;
      if (o.parent === this.craft.root) { o.visible = false; return; } // nav lights / beacon
      o.material = this.mat;
      o.renderOrder = 4;
    });
    this.root = this.craft.root;
    this.root.visible = false;
    scene.add(this.root);
    this.fade = 0;
  }

  /** Place the ghost at track time t. camPos fades it out when it overlaps the camera. */
  update(track, t, time, dt, camPos, hidden = false) {
    const there = !hidden && track.sample(t, _p, _q, _out);
    this.fade = Math.max(0, Math.min(1, this.fade + (there ? 1 : -1) * dt * 4));
    if (there) { this.root.position.copy(_p); this.root.quaternion.copy(_q); }
    const near = camPos ? Math.max(0, Math.min(1, (this.root.position.distanceTo(camPos) - 5) / 12)) : 1;
    const k = this.fade * near;
    this.root.visible = k > 0.01;
    if (!this.root.visible) return;
    this.mat.uniforms.uOpacity.value = 0.85 * k;
    this.mat.uniforms.uTime.value = time;
    this.craft.setThrust(0.6, _out.boost ? 1 : 0, time, 0.35 * k);
  }

  dispose() {
    this.scene.remove(this.root);
    this.mat.dispose();
    this.craft.dispose();
  }
}

/**
 * One solo race's ghost: records this run, and (when a saved best exists for the course and
 * lap count) flies it alongside and works out the live delta.
 */
export class GhostRun {
  constructor(scene, { saved = null, courseId, laps, design }) {
    this.courseId = courseId; this.laps = laps;
    this.rec = new GhostRecorder();
    this.clock = 0;
    const tr = saved ? decodeGhost(saved) : null;
    this.track = tr && tr.course === courseId && tr.laps === laps ? tr : null;
    this.view = this.track ? new GhostView(scene, this.track.design || design) : null;
    this.result = null; // the packed run, once you finish
    this.final = null; // finish-line delta against the ghost
  }

  /** Once per fixed step while racing. */
  step(dt, e) {
    this.clock += dt;
    if (this.rec.done) return;
    this.rec.tick(dt, e.sim);
    if (e.finishTime != null) {
      this.result = this.rec.finish({ course: this.courseId, laps: this.laps, time: e.finishTime, design: e.design });
      if (this.track) this.final = e.finishTime - this.track.time;
    }
  }

  /** Seconds behind (+) or ahead (-) of the ghost, or null when there is none to compare. */
  delta(sim) {
    if (!this.track) return null;
    if (this.final != null) return this.final;
    if (this.clock < 1) return null;
    return this.track.delta(this.clock, sim.dist);
  }

  render(dt, time, camPos, hidden) { this.view?.update(this.track, this.clock, time, dt, camPos, hidden); }

  dispose() { this.view?.dispose(); }
}
