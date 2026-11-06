// Lasers and missiles: simulation (headless-safe) plus an optional renderer.
// Only projectiles fired by locally simulated ships apply damage ("local");
// copies received from the network are cosmetic, and the owner reports hits.

import * as THREE from 'three';
import { Trail } from '../world/fx.js';

export const LASER = { speed: 820, life: 0.95, damage: 9, cooldown: 0.12, heat: 0.075, length: 9 };
export const MISSILE = { speed: 70, accel: 100, maxSpeed: 290, turn: 1.6, seeker: 0.5, life: 6, damage: 46, splash: 24, lockTime: 0.75, lockRange: 1100, lockCone: 0.12 };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion();
const FWD = new THREE.Vector3(0, 0, -1);

/** Laser hardpoints in ship-local space, alternating left/right. */
export function hardpoint(sim, i, out) {
  const r = sim.p.radius;
  return out.set((i % 2 ? 1 : -1) * r * 0.75, -0.25, -r * 0.6).applyQuaternion(sim.quat).add(sim.pos);
}

/** Clamp `dir` to within `maxAngle` of `fwd` (both unit vectors). */
export function clampCone(dir, fwd, maxAngle) {
  const ang = dir.angleTo(fwd);
  if (ang <= maxAngle) return dir;
  _c.crossVectors(fwd, dir);
  if (_c.lengthSq() < 1e-9) return dir.copy(fwd);
  _c.normalize();
  return dir.copy(fwd).applyAxisAngle(_c, maxAngle);
}

export class WeaponSystem {
  constructor(world) {
    this.world = world;
    this.lasers = [];
    this.missiles = [];
    this.events = [];
    this.teams = new Map(); // ship id -> team, for team modes (empty = free-for-all)
    this.missileSeq = 0;
  }

  /** Try to fire one laser from `ship` along `dir`. Returns the bolt or null. */
  tryFireLaser(ship, dir, color, local) {
    const sim = ship.sim;
    if (sim.dead || sim.overheated || sim.fireCd > 0 || sim.finished) return null;
    sim.fireCd = LASER.cooldown;
    sim.heat += LASER.heat;
    if (sim.heat >= 1) { sim.heat = 1; sim.overheated = true; sim.events.push({ type: 'overheat' }); }
    const origin = hardpoint(sim, sim.barrel++, new THREE.Vector3());
    return this.spawnLaser(origin, dir, sim.vel, ship.id, color, local);
  }

  spawnLaser(origin, dir, inheritVel, owner, color, local) {
    let b = this.lasers.find((x) => !x.alive);
    if (!b) { b = { pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), color: new THREE.Color() }; this.lasers.push(b); }
    b.alive = true;
    b.pos.copy(origin); b.prev.copy(origin);
    const fwdInherit = inheritVel ? Math.max(0, inheritVel.dot(dir)) : 0;
    b.vel.copy(dir).multiplyScalar(LASER.speed + fwdInherit);
    b.life = LASER.life;
    b.owner = owner;
    b.color.copy(color);
    b.local = local;
    return b;
  }

  tryFireMissile(ship, targetId, local) {
    const sim = ship.sim;
    if (sim.dead || sim.missiles <= 0 || sim.missileCd > 0 || sim.finished) return null;
    sim.missiles--;
    sim.missileCd = 0.6;
    const fwd = _a.copy(FWD).applyQuaternion(sim.quat);
    const origin = new THREE.Vector3(0, -0.9, -sim.p.radius * 0.4).applyQuaternion(sim.quat).add(sim.pos);
    const vel = fwd.clone().multiplyScalar(Math.max(0, sim.forwardSpeed) + MISSILE.speed);
    const id = `${ship.id}.${++this.missileSeq}`;
    return this.spawnMissile(id, origin, vel, ship.id, targetId, local);
  }

  spawnMissile(id, origin, vel, owner, targetId, local) {
    const m = { id, alive: true, pos: origin.clone(), prev: origin.clone(), vel: vel.clone(), owner, target: targetId, life: MISSILE.life, local, age: 0 };
    this.missiles.push(m);
    this.events.push({ type: 'missileSpawn', missile: m });
    return m;
  }

  /** Remove a missile because the owner said it exploded (network). */
  detonate(id, pos) {
    const m = this.missiles.find((x) => x.id === id);
    if (!m) { if (pos) this.events.push({ type: 'missileBoom', pos: pos.clone(), owner: null, local: false, missile: null }); return; }
    if (!m.alive) return;
    if (pos) m.pos.copy(pos);
    this._boom(m, null);
  }

  /**
   * @param {number} dt
   * @param {{id, sim, connected}[]} ships
   */
  update(dt, ships) {
    // Lasers.
    for (const b of this.lasers) {
      if (!b.alive) continue;
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) { b.alive = false; continue; }
      // Ships.
      let hitShip = null, hitT = Infinity;
      const segLen = b.prev.distanceTo(b.pos);
      _a.subVectors(b.pos, b.prev).divideScalar(segLen || 1);
      for (const s of ships) {
        const sim = s.sim;
        if (s.id === b.owner || sim.dead || !s.connected || this.sameTeam(b.owner, s)) continue;
        const R = sim.p.radius * 1.15;
        _b.subVectors(b.prev, sim.pos);
        const bq = _b.dot(_a), cq = _b.lengthSq() - R * R;
        const disc = bq * bq - cq;
        if (disc < 0) continue;
        const t = -bq - Math.sqrt(disc);
        if (t >= -R && t <= segLen && t < hitT) { hitT = Math.max(0, t); hitShip = s; }
      }
      const w = this.world.raycast(b.prev, b.pos, 0.3);
      if (w && w.t < hitT) {
        b.alive = false;
        this.events.push({ type: 'laserWorld', point: w.point, item: w.item, owner: b.owner, local: b.local, color: b.color });
        continue;
      }
      if (hitShip) {
        b.alive = false;
        const point = b.prev.clone().addScaledVector(_a, hitT);
        this.events.push({ type: 'laserHit', target: hitShip.id, point, owner: b.owner, local: b.local, color: b.color });
      }
    }

    // Missiles.
    for (const m of this.missiles) {
      if (!m.alive) continue;
      m.age += dt;
      m.life -= dt;
      m.prev.copy(m.pos);
      const tgt = m.target ? ships.find((s) => s.id === m.target && !s.sim.dead && s.connected) : null;
      const speed = Math.min(MISSILE.maxSpeed, m.vel.length() + MISSILE.accel * dt);
      const dir = _a.copy(m.vel).normalize();
      if (tgt && m.age > 0.15) {
        const dist = tgt.sim.pos.distanceTo(m.pos);
        const lead = Math.min(1.2, dist / speed) * 0.6;
        _b.copy(tgt.sim.pos).addScaledVector(tgt.sim.vel, lead).sub(m.pos).normalize();
        const ang = dir.angleTo(_b);
        // Counterplay: break hard across its nose and the seeker loses you.
        if (ang > MISSILE.seeker && m.age > 0.5) { m.target = null; m.lost = true; }
        const maxTurn = m.target ? MISSILE.turn * dt : 0;
        if (ang > 1e-4) {
          _c.crossVectors(dir, _b);
          if (_c.lengthSq() > 1e-10) { _c.normalize(); dir.applyAxisAngle(_c, Math.min(ang, maxTurn)); }
        }
      }
      m.vel.copy(dir).multiplyScalar(speed);
      m.pos.addScaledVector(m.vel, dt);

      // Proximity fuse on any ship but the owner.
      let boomOn = null;
      for (const s of ships) {
        if (s.id === m.owner || s.sim.dead || !s.connected || this.sameTeam(m.owner, s)) continue;
        if (s.sim.pos.distanceTo(m.pos) < s.sim.p.radius + (s.id === m.target ? 6 : 3)) { boomOn = s; break; }
      }
      const w = boomOn ? null : this.world.raycast(m.prev, m.pos, 0.6);
      if (boomOn || w || m.life <= 0) {
        if (w) m.pos.copy(w.point);
        this._boom(m, boomOn, w?.item || null);
      }
    }
    this.missiles = this.missiles.filter((m) => m.alive || m.age < 0);
  }

  _boom(m, directShip, item) {
    m.alive = false;
    this.events.push({ type: 'missileBoom', pos: m.pos.clone(), owner: m.owner, local: m.local, missile: m, direct: directShip?.id ?? null, item });
  }

  /** Lock-on step for a ship aiming along `aimDir`. Returns {id, t, locked, changed}. */
  updateLock(ship, aimDir, ships, dt, coneScale = 1) {
    const sim = ship.sim;
    let best = null, bestAng = MISSILE.lockCone * coneScale;
    for (const s of ships) {
      if (s.id === ship.id || s.sim.dead || !s.connected || s.sim.ghost > 0 || (ship.team != null && s.team === ship.team)) continue;
      _a.subVectors(s.sim.pos, sim.pos);
      const d = _a.length();
      if (d > MISSILE.lockRange || d < 20) continue;
      const ang = aimDir.angleTo(_a.divideScalar(d));
      // Keep an existing lock in a wider cone.
      const limit = s.id === sim.lock.id ? bestAng * 2.2 : bestAng;
      if (ang < limit && (!best || ang < best.ang)) best = { s, ang };
    }
    const prevId = sim.lock.id;
    if (!best) { sim.lock.id = null; sim.lock.t = 0; return { ...sim.lock, locked: false, changed: prevId !== null }; }
    if (best.s.id !== sim.lock.id) { sim.lock.id = best.s.id; sim.lock.t = 0; }
    sim.lock.t = Math.min(1, sim.lock.t + dt / MISSILE.lockTime);
    return { id: sim.lock.id, t: sim.lock.t, locked: sim.lock.t >= 1, changed: prevId !== sim.lock.id };
  }

  /** Team play: shots pass through teammates. `teams` maps ship id -> team (or is empty). */
  sameTeam(ownerId, ship) {
    if (ship.team == null) return false;
    return this.teams.get(ownerId) === ship.team;
  }

  incomingFor(id) { return this.missiles.some((m) => m.alive && m.target === id); }
}

// ---------------------------------------------------------------------------- rendering

export class WeaponView {
  constructor(scene, system, { quality = 'high' } = {}) {
    this.scene = scene;
    this.sys = system;
    const geo = new THREE.CylinderGeometry(0.16, 0.16, 1, 6, 1, true);
    geo.rotateX(Math.PI / 2);
    this.boltMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.maxBolts = 400;
    this.bolts = new THREE.InstancedMesh(geo, this.boltMat, this.maxBolts);
    this.bolts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxBolts * 3), 3);
    this.bolts.frustumCulled = false;
    this.bolts.count = 0;
    scene.add(this.bolts);
    // Core: thinner, white-hot centre.
    const coreGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 4, 1, true);
    coreGeo.rotateX(Math.PI / 2);
    this.cores = new THREE.InstancedMesh(coreGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), this.maxBolts);
    this.cores.frustumCulled = false;
    this.cores.count = 0;
    scene.add(this.cores);

    // Missile model (shared).
    const body = new THREE.CylinderGeometry(0.22, 0.28, 2.2, 8);
    body.rotateX(Math.PI / 2);
    this.missileGeo = body;
    this.missileMat = new THREE.MeshStandardMaterial({ color: 0xd9dde8, metalness: 0.6, roughness: 0.35 });
    this.glowTex = glowTexture();
    this.missileViews = new Map();
    this.quality = quality;
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
  }

  update(dt) {
    let n = 0;
    const m4 = this._m, scale = this._s;
    for (const b of this.sys.lasers) {
      if (!b.alive || n >= this.maxBolts) continue;
      _a.copy(b.vel).normalize();
      _q.setFromUnitVectors(FWD, _a);
      _b.copy(b.pos).addScaledVector(_a, -LASER.length / 2);
      scale.set(1, 1, LASER.length);
      m4.compose(_b, _q, scale);
      this.bolts.setMatrixAt(n, m4);
      this.cores.setMatrixAt(n, m4);
      this.bolts.instanceColor.setXYZ(n, b.color.r * 2.6, b.color.g * 2.6, b.color.b * 2.6);
      n++;
    }
    this.bolts.count = n;
    this.cores.count = n;
    this.bolts.instanceMatrix.needsUpdate = true;
    this.cores.instanceMatrix.needsUpdate = true;
    this.bolts.instanceColor.needsUpdate = true;

    // Missiles.
    for (const m of this.sys.missiles) {
      let v = this.missileViews.get(m);
      if (!v && m.alive) {
        const mesh = new THREE.Mesh(this.missileGeo, this.missileMat);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: new THREE.Color(2.5, 1.4, 0.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        glow.scale.setScalar(5);
        glow.position.z = 1.4;
        mesh.add(glow);
        const trail = new Trail(this.scene, new THREE.Color('#ffd2a0'), { length: this.quality === 'low' ? 18 : 30, width: 0.9 });
        this.scene.add(mesh);
        v = { mesh, trail, glow };
        this.missileViews.set(m, v);
      }
      if (!v) continue;
      if (!m.alive) continue;
      _a.copy(m.vel).normalize();
      v.mesh.quaternion.setFromUnitVectors(FWD, _a);
      v.mesh.position.copy(m.pos);
      _b.set(1, 0, 0).applyQuaternion(v.mesh.quaternion);
      v.trail.push(_c.copy(m.pos).addScaledVector(_a, -1.4), _b, 1);
    }
    for (const [m, v] of this.missileViews) {
      if (m.alive) continue;
      this.scene.remove(v.mesh);
      v.glow.material.dispose();
      v.trail.dispose();
      this.missileViews.delete(m);
    }
  }

  dispose() {
    for (const v of this.missileViews.values()) { this.scene.remove(v.mesh); v.glow.material.dispose(); v.trail.dispose(); }
    this.missileViews.clear();
    for (const o of [this.bolts, this.cores]) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); }
    this.missileGeo.dispose(); this.missileMat.dispose(); this.glowTex.dispose();
  }
}

function glowTexture() {
  const size = 64;
  if (typeof document === 'undefined') return new THREE.Texture();
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.4)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  return t;
}
