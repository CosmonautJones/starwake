// A battle arena: a sphere of open space with spawn points on its shell. It offers
// the small part of the Course API the world, ships and renderer share
// (def, rings, samples, gridSlot), so the same systems run both game modes.

import * as THREE from 'three';
import { mulberry32, hashString } from '../core/util.js';

export class Arena {
  constructor(def) {
    this.def = def;
    this.kind = 'arena';
    this.radius = def.radius;
    this.center = new THREE.Vector3(0, 0, 0);
    this.rings = [];
    this.samples = []; // no line to keep decor belts away from
    this.length = 1;

    // Spawn points spread evenly over a shell (Fibonacci sphere, flattened a little
    // so nobody starts directly above or below the action), facing the middle.
    const n = 16;
    const rng = mulberry32(hashString(def.id) + 5);
    const golden = Math.PI * (3 - Math.sqrt(5));
    this.spawns = [];
    for (let i = 0; i < n; i++) {
      const y = (1 - ((i + 0.5) / n) * 2) * 0.55;
      const r = Math.sqrt(1 - y * y);
      const a = i * golden + rng() * 0.2;
      const pos = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r).multiplyScalar(this.radius * 0.78);
      const look = new THREE.Vector3().copy(this.center).addScaledVector(pos, 0.15); // just shy of the station
      const m = new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0));
      this.spawns.push({ pos, quat: new THREE.Quaternion().setFromRotationMatrix(m), u: 0 });
    }
  }

  /** Opening spawn for roster slot i: spaced around the shell. */
  gridSlot(i) {
    const n = this.spawns.length;
    const s = this.spawns[(i * 5) % n];
    return { pos: s.pos.clone(), quat: s.quat.clone(), u: 0 };
  }

  /** The spawn point farthest from every listed (enemy) position. */
  pickSpawn(threats) {
    let best = this.spawns[0], bestD = -1;
    for (const s of this.spawns) {
      let d = Infinity;
      for (const p of threats) d = Math.min(d, s.pos.distanceToSquared(p));
      if (!threats.length) d = Math.random();
      if (d > bestD) { bestD = d; best = s; }
    }
    return { pos: best.pos.clone(), quat: best.quat.clone(), u: 0 };
  }

  pointAt(u, out = new THREE.Vector3()) { return out.copy(this.center); }
}
