// The view from the seat: canopy frame, dash and nose, built around the camera for the
// first-person view. Low-poly like the craft, tinted with the craft's own colours.
//
// Everything is authored in camera space (-z forward, y up) and no closer than the
// camera's near plane. The race places `group` on the camera each frame; `rig` inside it
// carries the motion (the frame lagging a head that leads the turn, pressed back under
// boost, buzzing at speed) and the dash instruments are live.
import * as THREE from 'three';
import { clamp, damp } from '../core/util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4(), _upY = new THREE.Vector3(0, 1, 0);

/** A box strut from a to b, pushed into `out` as a transformed geometry. */
function strut(out, a, b, w, d) {
  const len = _a.copy(b).sub(a).length();
  const g = new THREE.BoxGeometry(w, len, d);
  const q = new THREE.Quaternion().setFromUnitVectors(_upY, _b.copy(b).sub(a).normalize());
  g.applyMatrix4(_m.compose(_a.copy(a).add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  out.push(g);
}

/** Merge position-only geometries (flat-shaded, so normals are recomputed per face). */
function merge(list) {
  let n = 0;
  const parts = list.map((g) => { const ng = g.index ? g.toNonIndexed() : g; n += ng.attributes.position.count; if (ng !== g) g.dispose(); return ng; });
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; g.dispose(); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}

const BAR = 0.34; // dash bar length, metres
const tri = (arr, a, b, c) => arr.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
function fromTris(arr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
  g.computeVertexNormals();
  return g;
}

export class Cockpit {
  /** colors: { primary, secondary, glow } as THREE.Color or anything THREE.Color accepts. */
  constructor(scene, colors) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'cockpit';
    this.group.visible = false;
    this.rig = new THREE.Group();
    this.group.add(this.rig);
    const primary = new THREE.Color(colors.primary), glow = new THREE.Color(colors.glow);

    // --- Frame: two pillars leaning in to a top bar, and a spine running back overhead.
    const frame = [];
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    // (Placed for a 70 degree, 16:9 view; update() rescales the rig so it hugs the screen edge at any FOV or shape.)
    const footL = V(-1.44, -0.6, -1.18), topL = V(-1.13, 0.665, -1.02), footR = V(1.44, -0.6, -1.18), topR = V(1.13, 0.665, -1.02);
    strut(frame, footL, topL, 0.07, 0.05);
    strut(frame, footR, topR, 0.07, 0.05);
    strut(frame, topL, topR, 0.06, 0.05);
    strut(frame, V(0, 0.67, -1.02), V(0, 0.9, -0.6), 0.05, 0.04);
    this.frameMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#141a2c'), roughness: 0.55, metalness: 0.6, flatShading: true });
    this.frame = new THREE.Mesh(merge(frame), this.frameMat);
    this.rig.add(this.frame);

    // --- Dash: a shelf that swells into a binnacle at the centre, falling away toward the seat.
    const dash = [], N = 22, far = -1.24, near = -0.62;
    const top = (x) => -0.6 + 0.105 * Math.exp(-((x / 0.5) ** 2));
    for (let i = 0; i < N; i++) {
      const x0 = -1.7 + (3.4 * i) / N, x1 = -1.7 + (3.4 * (i + 1)) / N;
      const a = [x0, top(x0), far], b = [x1, top(x1), far], c = [x1 * 0.86, top(x1) - 0.42, near], d = [x0 * 0.86, top(x0) - 0.42, near];
      tri(dash, a, d, c); tri(dash, a, c, b);
    }
    this.dashMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#0d1222'), roughness: 0.8, metalness: 0.25, flatShading: true });
    this.dash = new THREE.Mesh(fromTris(dash), this.dashMat);
    this.rig.add(this.dash);

    // --- Nose: the craft's own hood running out ahead, in its paint.
    const nose = [], bl = [-0.62, -0.68, -1.26], br = [0.62, -0.68, -1.26], ridge = [0, -0.54, -1.26], tip = [0, -0.62, -4.4];
    tri(nose, bl, ridge, tip); tri(nose, ridge, br, tip);
    // (Darkened and matte: a bright hood right under the eye blooms into a white wedge.)
    this.noseMat = new THREE.MeshStandardMaterial({ color: primary.clone().multiplyScalar(0.42), roughness: 0.85, metalness: 0.1, flatShading: true });
    this.nose = new THREE.Mesh(fromTris(nose), this.noseMat);
    this.rig.add(this.nose);

    // --- Light: an edge line along the dash lip and up the pillars, in the craft's glow.
    const lines = [];
    for (let i = 0; i < N; i++) {
      const x0 = -1.7 + (3.4 * i) / N, x1 = -1.7 + (3.4 * (i + 1)) / N;
      strut(lines, V(x0, top(x0) + 0.004, far + 0.01), V(x1, top(x1) + 0.004, far + 0.01), 0.007, 0.007);
    }
    strut(lines, V(footL.x + 0.04, footL.y, footL.z + 0.03), V(topL.x + 0.04, topL.y, topL.z + 0.03), 0.005, 0.005);
    strut(lines, V(footR.x - 0.04, footR.y, footR.z + 0.03), V(topR.x - 0.04, topR.y, topR.z + 0.03), 0.005, 0.005);
    this.lineMat = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(0.8) });
    this.lines = new THREE.Mesh(merge(lines), this.lineMat);
    this.rig.add(this.lines);

    // --- Instruments on the shelf: speed (left), boost (right), three drift pips on the binnacle.
    const bar = new THREE.PlaneGeometry(1, 1);
    bar.translate(0.5, 0, 0); // grows from its left edge
    this.barGeo = bar;
    const mkBar = (x, color, flip) => {
      const back = new THREE.Mesh(bar, new THREE.MeshBasicMaterial({ color: new THREE.Color('#1b2540') }));
      const fill = new THREE.Mesh(bar, new THREE.MeshBasicMaterial({ color }));
      for (const m of [back, fill]) {
        m.position.set(x, top(x + (flip ? -0.2 : 0.2)) - 0.085, far + 0.13);
        m.rotation.set(-1.05, 0, 0);
        m.scale.set(flip ? -BAR : BAR, 0.03, 1);
        this.rig.add(m);
      }
      fill.position.y += 0.002; fill.position.z += 0.002;
      fill.material.side = back.material.side = THREE.DoubleSide;
      return fill;
    };
    this.speedBar = mkBar(-0.8, new THREE.Color('#4feaff').multiplyScalar(0.9), false);
    this.boostBar = mkBar(0.8, new THREE.Color('#ff7a2f').multiplyScalar(1.0), true);
    this.pipGeo = new THREE.CircleGeometry(0.017, 10);
    this.pips = [-1, 0, 1].map((i) => {
      const m = new THREE.Mesh(this.pipGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#1b2540') }));
      m.position.set(i * 0.07, top(0) - 0.055, far + 0.09);
      m.rotation.set(-1.05, 0, 0);
      this.rig.add(m);
      return m;
    });
    this._pipOff = new THREE.Color('#1b2540');
    this._pipOn = new THREE.Color('#ffc94a').multiplyScalar(1.5);
    this._kick = new THREE.Color('#ff7a2f').multiplyScalar(1.7);

    this.sway = new THREE.Vector3();
    this.tilt = 0;
    scene.add(this.group);
  }

  /**
   * camera: where the seat is. s: { speedN, boost (meter 0..1), boosting, angVel (ship-local
   * rad/s), drift (0..1), drifting, kick (0..1), supersonic, time, reduce }.
   */
  update(dt, camera, s) {
    this.group.position.copy(camera.position);
    this.group.quaternion.copy(camera.quaternion);
    const k = s.reduce ? 0.35 : 1;
    // The head leads into a turn, so the frame trails it; boost presses you back from the dash.
    const tx = clamp(s.angVel.y * 0.035, -0.07, 0.07) * k, ty = clamp(-s.angVel.x * 0.03, -0.05, 0.05) * k;
    const tz = -(s.boosting ? 0.07 : 0) * k - (s.kick || 0) * 0.05 * k;
    this.sway.set(damp(this.sway.x, tx, 7, dt), damp(this.sway.y, ty, 7, dt), damp(this.sway.z, tz, 5, dt));
    this.tilt = damp(this.tilt, clamp(s.angVel.y * 0.03 + (s.drifting ? Math.sign(s.angVel.y || 1) * 0.02 : 0), -0.06, 0.06) * k, 6, dt);
    const buzz = (Math.max(0, s.speedN - 0.55) * 0.004 + (s.supersonic ? 0.004 : 0) + (s.boosting ? 0.003 : 0)) * k;
    this.rig.position.set(this.sway.x + Math.sin(s.time * 67) * buzz, this.sway.y + Math.sin(s.time * 53 + 1.3) * buzz, this.sway.z);
    this.rig.rotation.z = this.tilt;
    // Hold the frame at the same place on screen as the view widens with speed or the window changes shape.
    const fk = Math.tan((camera.fov * Math.PI) / 360) / 0.7002;
    this.rig.scale.set(fk * camera.aspect / (16 / 9), fk, 1);
    // Instruments.
    this.speedBar.scale.x = BAR * clamp(s.speedN / 1.3, 0.02, 1);
    this.boostBar.scale.x = -BAR * clamp(s.boost, 0.02, 1);
    const lit = s.drifting ? (s.drift >= 0.999 ? 3 : s.drift >= 0.62 ? 2 : s.drift >= 0.3 ? 1 : 0) : 0;
    for (let i = 0; i < 3; i++) this.pips[i].material.color.copy(s.kick > 0 && !s.drifting ? this._kick : i < lit ? this._pipOn : this._pipOff);
  }

  setVisible(on) { this.group.visible = on; }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.material) o.material.dispose(); });
    for (const g of [this.frame.geometry, this.dash.geometry, this.nose.geometry, this.lines.geometry, this.barGeo, this.pipGeo]) g.dispose();
  }
}
