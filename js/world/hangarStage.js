// The hangar's 3D preview: a turntable in a nebula-lit bay. Drag to orbit.

import * as THREE from 'three';
import { SpaceSky } from '../space/sky.js';
import { buildCraft } from '../craft/craftMesh.js';
import { damp } from '../core/util.js';

const HANGAR_THEME = {
  space: '#04060d', nebula: ['#23408f', '#5a2f8f'], nebulaStrength: 0.45, starDensity: 1,
  sun: { dir: [0.5, 0.7, 0.5], color: '#fff4e6', intensity: 2.2, size: 0.8 },
  ambient: '#33405f', ambientIntensity: 0.5,
  fog: null,
  planets: [{ pos: [-5200, -1400, -6400], radius: 2200, type: 'gas', color: '#6a7fb8', color2: '#2d3866', atmosphere: '#9fc4ff', ring: { inner: 1.4, outer: 2.1, color: '#b8c8e8', tilt: [1.1, 0.3, 0.2] } }],
};

export class HangarStage {
  constructor(renderer) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 20000);
    this.env = new SpaceSky(renderer, this.scene, HANGAR_THEME, { quality: 'medium' });
    this.yaw = 0.7; this.pitch = 0.3; this.dist = 21;
    this.targetYaw = this.yaw; this.targetPitch = this.pitch;
    this.autoSpin = true;
    this.time = 0;
    this.focusX = 0; // shifts the craft into the visible gap between panels
    this.bloomStrength = 0.3; // studio lighting: keep paint colours readable

    // Turntable.
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, 0.5, 64), new THREE.MeshStandardMaterial({ color: 0x141833, metalness: 0.85, roughness: 0.35 }));
    deck.position.y = -1.6;
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#3cf0ff').multiplyScalar(1.2) });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(7.1, 0.05, 8, 96), ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = -1.33;
    const inner = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.03, 8, 96), ringMat);
    inner.rotation.x = Math.PI / 2; inner.position.y = -1.33;
    this.ringMat = ringMat;
    this.table = new THREE.Group();
    this.table.add(deck, ring, inner);
    this.scene.add(this.table);

    // Studio lights for readable silhouettes.
    const key = new THREE.DirectionalLight(0xffffff, 1.0); key.position.set(6, 10, 8);
    const rimA = new THREE.DirectionalLight(0x3cf0ff, 1.4); rimA.position.set(-8, 4, -8);
    const rimB = new THREE.DirectionalLight(0xff4fa3, 0.9); rimB.position.set(8, 2, -6);
    this.scene.add(key, rimA, rimB);
    this.scene.fog = null;
    this.scene.environmentIntensity = 0.45;

    this.craft = null;
    this.craftGroup = new THREE.Group();
    this.scene.add(this.craftGroup);
  }

  setDesign(design) {
    if (this.craft) { this.craftGroup.remove(this.craft.root); this.craft.dispose(); }
    this.craft = buildCraft(design);
    this.craftGroup.add(this.craft.root);
    this.ringMat.color.set(design.colors.glow).multiplyScalar(1.2);
    this.pop = 1;
  }

  drag(dx, dy) {
    this.autoSpin = false;
    clearTimeout(this._spinTimer);
    this._spinTimer = setTimeout(() => (this.autoSpin = true), 4000);
    this.targetYaw -= dx * 0.008;
    this.targetPitch = Math.max(-0.05, Math.min(0.9, this.targetPitch + dy * 0.005));
  }

  zoom(delta) { this.dist = Math.max(13, Math.min(30, this.dist + delta * 0.01)); }

  update(dt) {
    this.time += dt;
    if (this.autoSpin) this.targetYaw += dt * 0.35;
    this.yaw = damp(this.yaw, this.targetYaw, 6, dt);
    this.pitch = damp(this.pitch, this.targetPitch, 6, dt);
    const c = this.camera;
    c.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist, Math.sin(this.pitch) * this.dist + 1, Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist);
    c.position.x += this.focusX;
    c.lookAt(this.focusX, -2.2, 0); // aim low so the craft sits above the stats panel
    if (this.craft) {
      this.craft.root.position.y = Math.sin(this.time * 1.6) * 0.15;
      this.craft.setThrust(0.35 + Math.sin(this.time * 2) * 0.05, 0, this.time);
      if (this.pop > 0) {
        this.pop = Math.max(0, this.pop - dt * 3);
        this.craft.root.scale.setScalar(1 + Math.sin(this.pop * Math.PI) * 0.06);
      }
    }
    this.env.update(c, dt);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    if (this.craft) this.craft.dispose();
    this.scene.traverse((o) => { o.geometry?.dispose?.(); if (o.material && o.material.dispose) o.material.dispose(); });
    this.env.dispose();
  }
}
