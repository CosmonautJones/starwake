// Visual effects: engine ribbon trails, pooled spark particles, speed streaks.

import * as THREE from 'three';

export class Trail {
  constructor(scene, color, { length = 44, width = 0.9 } = {}) {
    this.n = length;
    this.width = width;
    this.scene = scene;
    this.pts = Array.from({ length: this.n }, () => new THREE.Vector3());
    this.rights = Array.from({ length: this.n }, () => new THREE.Vector3(1, 0, 0));
    this.widths = new Float32Array(this.n);
    this.filled = 0;
    const pos = new Float32Array(this.n * 2 * 3);
    const t = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) { t[i * 2] = t[i * 2 + 1] = i / (this.n - 1); }
    const idx = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uColor: { value: color.clone() }, uIntensity: { value: 1 }, uNear: { value: 6 } },
      vertexShader: /* glsl */`attribute float aT; varying float vT; varying float vDepth; void main(){ vT = aT; vec4 mv = modelViewMatrix*vec4(position,1.0); vDepth = -mv.z; gl_Position = projectionMatrix*mv; }`,
      // Fade out close to the camera so a ribbon streaming past the lens never fills the screen.
      fragmentShader: /* glsl */`uniform vec3 uColor; uniform float uIntensity; uniform float uNear; varying float vT; varying float vDepth;
        void main(){ float a = pow(1.0 - vT, 2.2) * uIntensity * 0.7 * smoothstep(uNear, uNear * 4.0, vDepth); gl_FragColor = vec4(mix(vec3(1.0), uColor, smoothstep(0.0, 0.08, vT)) * 1.1, a); }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  reset() { this.filled = 0; }

  push(point, right, width) {
    if (!Number.isFinite(point.x + point.y + point.z + right.x + width)) return;
    // shift history
    for (let i = this.n - 1; i > 0; i--) {
      this.pts[i].copy(this.pts[i - 1]);
      this.rights[i].copy(this.rights[i - 1]);
      this.widths[i] = this.widths[i - 1];
    }
    this.pts[0].copy(point);
    this.rights[0].copy(right);
    this.widths[0] = width;
    if (this.filled < this.n) {
      // fill the rest on first push so no stray lines from origin
      for (let i = this.filled; i < this.n; i++) { this.pts[i].copy(point); this.rights[i].copy(right); this.widths[i] = 0; }
      this.filled = this.n;
    }
    const pos = this.geo.attributes.position.array;
    for (let i = 0; i < this.n; i++) {
      const w = this.widths[i] * this.width * (1 - i / this.n * 0.6);
      const p = this.pts[i], r = this.rights[i];
      pos[i * 6] = p.x - r.x * w; pos[i * 6 + 1] = p.y - r.y * w; pos[i * 6 + 2] = p.z - r.z * w;
      pos[i * 6 + 3] = p.x + r.x * w; pos[i * 6 + 4] = p.y + r.y * w; pos[i * 6 + 5] = p.z + r.z * w;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() { this.scene.remove(this.mesh); this.geo.dispose(); this.mat.dispose(); }
}

export class Sparks {
  constructor(scene, max = 600) {
    this.scene = scene;
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.cursor = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      uniforms: { uScale: { value: 300 } },
      vertexShader: /* glsl */`attribute float size; varying vec3 vColor; uniform float uScale;
        void main(){ vColor = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = size * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: /* glsl */`varying vec3 vColor; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(vColor * 2.0, smoothstep(0.5, 0.0, d)); }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(origin, baseVel, count, color, { spread = 20, size = 0.8, life = 0.5 } = {}) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.pos[i * 3] = origin.x; this.pos[i * 3 + 1] = origin.y; this.pos[i * 3 + 2] = origin.z;
      this.vel[i * 3] = baseVel.x + (Math.random() - 0.5) * spread;
      this.vel[i * 3 + 1] = baseVel.y + (Math.random() - 0.5) * spread;
      this.vel[i * 3 + 2] = baseVel.z + (Math.random() - 0.5) * spread;
      this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
      this.size[i] = size * (0.5 + Math.random());
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.8);
    }
  }

  update(dt) {
    const drag = Math.exp(-2.5 * dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      for (let c = 0; c < 3; c++) {
        this.vel[i * 3 + c] *= drag;
        this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt;
      }
      this.size[i] *= 0.985;
      if (k <= 0) this.size[i] = 0;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  dispose() { this.scene.remove(this.points); this.geo.dispose(); this.mat.dispose(); }
}

/** Streaks attached to the camera; brightness follows speed. */
export class SpeedLines {
  constructor(camera, count = 90) {
    this.camera = camera;
    this.count = count;
    this.data = [];
    const pos = new Float32Array(count * 6);
    const alpha = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      this.data.push(this._spawn({}, true));
      alpha[i * 2] = 0; alpha[i * 2 + 1] = 1;
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aA', new THREE.BufferAttribute(alpha, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uOpacity: { value: 0 }, uColor: { value: new THREE.Color('#bfe9ff') } },
      vertexShader: /* glsl */`attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: /* glsl */`uniform float uOpacity; uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA * uOpacity); }`,
    });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 10;
    camera.add(this.lines);
  }

  _spawn(d, initial) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 4 + Math.random() * 14;
    d.x = Math.cos(ang) * rad; d.y = Math.sin(ang) * rad * 0.7;
    d.z = initial ? -Math.random() * 120 : -120 - Math.random() * 20;
    return d;
  }

  update(dt, speed, intensity) {
    this.mat.uniforms.uOpacity.value = intensity;
    if (intensity <= 0.01) { this.lines.visible = false; return; }
    this.lines.visible = true;
    const pos = this.geo.attributes.position.array;
    const len = 4 + speed * 0.06;
    for (let i = 0; i < this.count; i++) {
      const d = this.data[i];
      d.z += speed * 1.6 * dt;
      if (d.z > -2) this._spawn(d, false);
      pos[i * 6] = d.x; pos[i * 6 + 1] = d.y; pos[i * 6 + 2] = d.z;
      pos[i * 6 + 3] = d.x; pos[i * 6 + 4] = d.y; pos[i * 6 + 5] = d.z - len;
    }
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() { this.camera.remove(this.lines); this.geo.dispose(); this.mat.dispose(); }
}
