// Free-flight ship physics. Deterministic for a fixed timestep and inputs.
//
// Steering: aimX/aimY command pitch/yaw rates (the ship turns toward the cursor),
// roll is manual. Flight assist swings the velocity vector onto the nose at a rate
// set by the craft's grip, converting most sideways speed back into forward speed,
// so light craft carve and heavy craft slide.
//
// Two settings, picked by what the ship flies in:
//   Course (race)  - the wormhole wall keeps you in (scraping costs a little speed),
//                    progress is distance along the line, gates are optional boosts,
//                    and track assist eases the nose down the tunnel when you let go.
//   Arena (battle) - open space inside a sphere; a soft field pushes strays back.

import * as THREE from 'three';
import { clamp } from '../core/util.js';

const _f = new THREE.Vector3(), _lat = new THREE.Vector3(), _n = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Vector3();
const FWD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const _loc = { i: 0, u: 0, c: new THREE.Vector3(), t: new THREE.Vector3() };
const _t = new THREE.Vector3(), _inv = new THREE.Quaternion();

/** Shared stick curve: fine control near the centre, full rate at the edge. */
export function stickCurve(v) {
  const a = Math.abs(v);
  if (a < 0.035) return 0;
  const t = (a - 0.035) / 0.965;
  return Math.sign(v) * (0.35 * t + 0.65 * t * t);
}

export class ShipSim {
  constructor(course, physics, spawn, id) {
    this.course = course;
    this.p = physics;
    this.id = id;
    this.events = [];
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3(); // local: x pitch, y yaw, z roll
    this.battle = course.kind === 'arena';
    this.assist = 0;            // track assist strength 0..1 (set by the race for its player)
    this.levelAssist = 0;       // battle: wing levelling 0..1 (player's flight assist)
    this.spawnPicker = null;    // battle: () => spawn transform, chosen by the race
    this.world = null;
    this.trackT = new THREE.Vector3(0, 0, -1);
    this.reset(spawn);
  }

  reset(spawn) {
    this.pos.copy(spawn.pos);
    this.quat.copy(spawn.quat);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.boost = 0.4;
    this.boosting = false;
    this.hull = this.p.hull;
    this.shield = this.p.shield;
    this.shieldDelay = 0;
    this.heat = 0;
    this.overheated = false;
    this.fireCd = 0;
    this.barrel = 0;
    this.missiles = 3;
    this.missileCd = 0;
    this.lock = { id: null, t: 0 };
    this.stun = 0;
    this.stunGuard = 0;   // after a stun ends, a short window where nothing stuns again
    this.ghost = 0;
    this.supersonic = false;
    this.dodgeT = 0;      // > 0 while dodging (lasers deflect)
    this.dodgeDir = 0;
    this.dodgeCd = 0;
    this.dead = false;
    this.respawnT = 0;
    this.lap = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.started = false;
    this.finished = false;
    this.streak = 0;
    this.lastHitBy = null;
    this.deaths = 0;
    // Race: where we are along the line. dist is signed distance from the start line
    // (negative on the grid); a lap is one course length.
    this.trackU = spawn.u ?? 0;
    this.trackI = Math.round(this.trackU * (this.course.sampleCount || 1));
    this.dist = this.battle ? 0 : (((this.trackU + 0.5) % 1) - 0.5) * this.course.length;
    this.wall = 0;        // 0 centre .. 1 touching the wall
    this.scraping = 0;
    this.scrapeCd = 0;
    this.wrongWay = 0;    // seconds facing backwards
    this.gateIdx = 0;
    this.gateLap = 0;
    if (!this.battle) this._seekGate();
    // Battle: time spent outside the arena sphere.
    this.outside = 0;
  }

  get ringCount() { return this.course.rings.length; }
  get nextRing() { return this.gateIdx; }
  get forward() { return _f.copy(FWD).applyQuaternion(this.quat); }
  get speed() { return this.vel.length(); }
  get forwardSpeed() { return this.vel.dot(_f.copy(FWD).applyQuaternion(this.quat)); }
  get hullN() { return this.hull / this.p.hull; }

  /** Race progress in laps (continuous), used for ranking. */
  progress() { return this.battle ? 0 : this.dist / this.course.length; }

  /**
   * @param {number} dt fixed step
   * @param {{throttle,brake,boost,roll,aimX,aimY}} input
   * @param {{world, racing:boolean, raceTime:number}} env
   */
  step(dt, input, env) {
    const p = this.p;
    if (this.dead) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) this.respawn();
      return;
    }
    // Stuns are short and never chain: capped, then a guard window after each one.
    if (this.stunGuard > 0) { this.stunGuard -= dt; this.stun = 0; }
    if (this.stun > 0.6) this.stun = 0.6;
    if (this.stun > 0) { this.stun -= dt; if (this.stun <= 0) this.stunGuard = 1; }
    if (this.ghost > 0) this.ghost -= dt;
    if (this.dodgeT > 0) this.dodgeT -= dt;
    if (this.dodgeCd > 0) this.dodgeCd -= dt;
    if (this.fireCd > 0) this.fireCd -= dt;
    if (this.missileCd > 0) this.missileCd -= dt;

    // Shields recharge after a short delay without damage.
    if (this.shieldDelay > 0) this.shieldDelay -= dt;
    else this.shield = Math.min(p.shield, this.shield + 14 * dt);

    // Laser heat.
    this.heat = Math.max(0, this.heat - (this.overheated ? 0.32 : 0.5) * dt);
    if (this.overheated && this.heat < 0.3) this.overheated = false;

    const racing = env.racing && !this.finished;
    const ctl = this.stun > 0 ? 0.35 : 1;
    const throttle = racing ? input.throttle : (this.finished ? 0.5 : 0);
    const brake = racing ? input.brake : 0;

    // --- Boost.
    const wantBoost = racing && input.boost && this.boost > 0.02 && this.stun <= 0;
    if (wantBoost && !this.boosting) this.events.push({ type: 'boostStart' });
    this.boosting = wantBoost;
    if (wantBoost) this.boost = Math.max(0, this.boost - p.boostDrain * dt);
    else this.boost = Math.min(1, this.boost + 0.03 * p.boostRegen * dt);

    // --- Rotation.
    const fwdSpeed = this.forwardSpeed;
    const speedN = clamp(fwdSpeed / p.topSpeed, 0, 1.5);
    const turnScale = (1 - 0.15 * clamp(speedN - 0.5, 0, 1)) * (this.boosting ? 0.85 : 1) * ctl;
    const allowTurn = env.racing || this.finished ? 1 : 0;
    const tx = stickCurve(input.aimY) * p.turnRate * turnScale * allowTurn;
    const ty = -stickCurve(input.aimX) * p.turnRate * turnScale * allowTurn;
    let tz = -input.roll * p.rollRate * ctl * allowTurn;
    let ax = tx, ay = ty;
    if (this.assist > 0 && !this.battle && allowTurn) {
      // Track assist: when the stick is near centre, ease the nose down the tunnel
      // (all the way round if we're facing backwards) and level the wings.
      const stick = Math.hypot(input.aimX, input.aimY);
      const w = this.assist * (1 - clamp((stick - 0.06) / 0.3, 0, 1)) * ctl;
      if (w > 0) {
        this.course.pointAt(this.trackU + (45 + Math.max(0, fwdSpeed) * 0.55) / this.course.length, _t);
        _inv.copy(this.quat).invert();
        _t.sub(this.pos).normalize().applyQuaternion(_inv);
        const pitchErr = Math.atan2(_t.y, -_t.z), yawErr = Math.atan2(_t.x, -_t.z);
        ax += clamp(pitchErr * 2.6, -1, 1) * p.turnRate * 0.6 * w;
        ay += -clamp(yawErr * 2.6, -1, 1) * p.turnRate * 0.6 * w;
        if (!input.roll && Math.abs(this.trackT.y) < 0.85) {
          _e.copy(UP).addScaledVector(this.trackT, -UP.dot(this.trackT)).normalize().applyQuaternion(_inv);
          tz -= clamp(Math.atan2(_e.x, _e.y) * 1.4, -1, 1) * p.rollRate * 0.35 * w;
        }
      }
    }
    if (this.battle && this.levelAssist > 0 && allowTurn && !input.roll) {
      // Flight assist in open space: level the wings to the arena's "up" unless climbing steeply.
      _f.copy(FWD).applyQuaternion(this.quat);
      if (Math.abs(_f.y) < 0.8) {
        _inv.copy(this.quat).invert();
        _e.copy(UP).addScaledVector(_f, -UP.dot(_f)).normalize().applyQuaternion(_inv);
        tz -= clamp(Math.atan2(_e.x, _e.y) * 1.4, -1, 1) * p.rollRate * 0.3 * this.levelAssist * ctl;
      }
    }
    const k = 1 - Math.exp(-p.response * dt);
    this.angVel.x += (ax - this.angVel.x) * k;
    this.angVel.y += (ay - this.angVel.y) * k;
    this.angVel.z += (tz - this.angVel.z) * k;
    if (this.stun > 0) {
      // Tumbling a little after a heavy hit.
      this.angVel.x += Math.sin(env.raceTime * 23) * 1.2 * dt;
      this.angVel.z += Math.cos(env.raceTime * 17) * 2.5 * dt;
    }
    _e.copy(this.angVel).multiplyScalar(dt);
    const ang = _e.length();
    if (ang > 1e-7) {
      _q.setFromAxisAngle(_e.divideScalar(ang), ang);
      this.quat.multiply(_q).normalize();
    }

    // --- Translation.
    const fwd = _f.copy(FWD).applyQuaternion(this.quat);
    let fs = this.vel.dot(fwd);
    _lat.copy(this.vel).addScaledVector(fwd, -fs);
    const burst = this.boosting ? p.boostMul : 1;
    const maxV = p.topSpeed * burst * (this.stun > 0 ? 0.65 : 1);
    // Throttle sets a target speed; above it the engines ease off, with none it coasts.
    const want = maxV * (this.boosting ? 1 : throttle);
    if (want > 0 && fs < want) {
      const a = p.accel * (this.boosting ? 1.9 : 1);
      fs = Math.min(want, fs + a * dt * (1 - 0.6 * clamp(fs / maxV, 0, 1)));
    } else if (want > 0) {
      fs -= (fs - want) * 0.9 * dt;
    } else {
      fs -= fs * 0.22 * dt;
    }
    if (fs > maxV) fs += (maxV - fs) * Math.min(1, 1.8 * dt);
    if (brake > 0) fs = fs > 0 ? Math.max(-30, fs - p.brake * brake * dt) : Math.max(-35, fs - 40 * brake * dt);
    // Flight assist: bleed sideways speed, returning most of it to forward speed.
    const latLen = _lat.length();
    const keep = Math.exp(-p.assist * ctl * dt);
    const removed = latLen * (1 - keep);
    _lat.multiplyScalar(keep);
    // Return most of it to forward speed, but never more than the speed we had
    // (turning must not be a way to gain speed).
    if (fs > 0) fs = Math.min(maxV, fs + removed * 0.8, Math.sqrt(Math.max(0, fs * fs + latLen * latLen * (1 - keep * keep))));
    this.vel.copy(fwd).multiplyScalar(fs).add(_lat);

    // Supersonic: at (nearly) full boosted speed. Ramming a rival in this state wrecks them.
    const ssMax = p.topSpeed * p.boostMul;
    if (!this.supersonic && fs > ssMax * 0.93 && racing) { this.supersonic = true; this.events.push({ type: 'supersonic' }); }
    else if (this.supersonic && (fs < ssMax * 0.85 || !racing)) this.supersonic = false;

    // Dodge: a quick sideways burst (flight assist then bleeds it into a ~15 m side-step).
    if (racing && input.dodge && this.dodgeCd <= 0 && this.stun <= 0) {
      _p.set(1, 0, 0).applyQuaternion(this.quat);
      this.vel.addScaledVector(_p, Math.sign(input.dodge) * 58);
      this.dodgeT = 0.45; this.dodgeDir = Math.sign(input.dodge); this.dodgeCd = 1.6;
      this.events.push({ type: 'dodge', dir: this.dodgeDir });
    }

    this.pos.addScaledVector(this.vel, dt);

    this.world = env.world;
    this._collideWorld(env.world);
    if (this.battle) this._arena(dt);
    else this._tunnel(dt, env.raceTime, racing);
  }

  _collideWorld(world) {
    if (!world) return;
    const R = this.p.radius;
    world.forEachNear(this.pos, R + 4, (c) => {
      if (c.dead) return;
      _n.set(this.pos.x - c.x, this.pos.y - c.y, this.pos.z - c.z);
      const d = _n.length();
      const min = c.r + R;
      if (d >= min || d < 1e-6) return;
      _n.divideScalar(d);
      if (c.ref && c.ref.explosive) {
        world.hitBreakable(c.ref.id, 999, this.id);
        return;
      }
      this.pos.addScaledVector(_n, min - d);
      const vn = this.vel.dot(_n);
      if (vn >= 0) return;
      const impact = -vn;
      // Ramming small breakables smashes them and costs less speed.
      const smash = c.ref && c.ref.hp != null && c.ref.hp <= impact * 0.9;
      if (c.ref && c.ref.hp != null) world.hitBreakable(c.ref.id, impact * 0.9, this.id);
      if (smash) {
        this.vel.multiplyScalar(0.82);
      } else {
        this.vel.addScaledVector(_n, -vn * 1.35);
        this.vel.multiplyScalar(1 - Math.min(0.45, impact / 380) * (1 - this.p.armor * 0.5));
      }
      const dmg = impact > 22 ? (impact - 22) * 0.32 * (1 - this.p.armor * 0.45) : 0;
      this.events.push({ type: 'bump', intensity: clamp(impact / 160, 0.1, 1) });
      if (dmg > 0 && this.ghost <= 0) this.damage(dmg, 'collision', null);
    });
  }

  /** Wormhole: wall contact, progress along the line, laps, gates, wrong way. */
  _tunnel(dt, raceTime, racing) {
    const course = this.course, L = course.length;
    const loc = course.locate(this.pos, this.trackI, _loc);
    this.trackI = loc.i;
    let du = loc.u - this.trackU;
    du -= Math.round(du);
    this.trackU = loc.u;
    this.trackT.copy(loc.t);
    const prevDist = this.dist;
    this.dist += du * L;

    // The wall: a soft tube. Slide along it, losing a little speed, never stopping.
    _n.subVectors(this.pos, loc.c);
    _n.addScaledVector(loc.t, -_n.dot(loc.t));
    const r = _n.length();
    const R = course.tunnelRadiusAt(loc.u) - this.p.radius;
    this.wall = clamp(r / R, 0, 1);
    if (this.scrapeCd > 0) this.scrapeCd -= dt;
    this.scraping = Math.max(0, this.scraping - dt * 4);
    if (r > R && r > 1e-6) {
      _n.divideScalar(r);
      this.pos.addScaledVector(_n, R - r);
      const vn = this.vel.dot(_n);
      if (vn > 0) {
        this.vel.addScaledVector(_n, -vn * 1.3);
        this.vel.multiplyScalar(1 - Math.min(0.22, vn / 700));
        if (this.scrapeCd <= 0 && vn > 6) {
          this.scrapeCd = 0.18;
          this.events.push({ type: 'scrape', intensity: clamp(vn / 110, 0.12, 1), point: this.pos.clone().addScaledVector(_n, this.p.radius) });
        }
      }
      this.vel.multiplyScalar(Math.exp(-0.4 * dt));
      this.scraping = 1;
    }

    if (this.finished || !racing) return;

    // Facing the wrong way for long: put us back on the line, pointing forwards.
    const fwdT = _f.copy(FWD).applyQuaternion(this.quat).dot(loc.t);
    if (fwdT < -0.3 && this.vel.dot(loc.t) < 25) this.wrongWay += dt;
    else this.wrongWay = Math.max(0, this.wrongWay - dt * 3);
    if (this.wrongWay > 4.5) { this.wrongWay = 0; this.events.push({ type: 'autoReset' }); this.respawn(); return; }

    // Start line and laps.
    if (!this.started && this.dist >= 0) {
      this.started = true;
      this.lapStart = raceTime;
      this.events.push({ type: 'start' });
    }
    while (this.started && this.dist >= (this.lap + 1) * L) {
      const lapTime = raceTime - this.lapStart;
      this.lapStart = raceTime;
      this.lapTimes.push(lapTime);
      this.lap += 1;
      this.events.push({ type: 'lap', lap: this.lap, time: lapTime });
    }

    // Optional boost gates: crossing a gate's distance mark checks if we were inside it.
    const rings = course.rings;
    if (!rings.length) return;
    for (let guard = 0; guard < 4; guard++) {
      const g = rings[this.gateIdx];
      const gd = (this.gateLap + g.u) * L;
      if (prevDist < gd && this.dist >= gd) {
        _n.subVectors(this.pos, g.pos);
        _n.addScaledVector(g.normal, -_n.dot(g.normal));
        if (_n.length() <= g.radius + this.p.radius * 0.5) {
          this.streak = Math.min(10, this.streak + 1);
          this.boost = Math.min(1, this.boost + 0.22 + 0.02 * this.streak);
          this.events.push({ type: 'ring', index: g.index, streak: this.streak });
        } else if (this.streak) this.streak = 0;
        this.gateIdx = (this.gateIdx + 1) % rings.length;
        if (this.gateIdx === 0) this.gateLap++;
      } else break;
    }
    if (this.dist < prevDist) this._seekGate(); // flying backwards: re-find the next gate
  }

  _seekGate() {
    const rings = this.course.rings, L = this.course.length;
    if (!rings.length) return;
    let lap = Math.floor(this.dist / L);
    const f = this.dist / L - lap;
    let idx = rings.findIndex((g) => g.u > f);
    if (idx < 0) { idx = 0; lap++; }
    this.gateIdx = idx;
    this.gateLap = lap;
  }

  /** Arena: a soft boundary sphere. Outside it, a field pushes you back in. */
  _arena(dt) {
    const a = this.course;
    _n.subVectors(this.pos, a.center);
    const d = _n.length();
    const over = d - a.radius;
    if (over > 0) {
      _n.divideScalar(d);
      this.outside += dt;
      const vn = this.vel.dot(_n);
      this.vel.addScaledVector(_n, -(60 + over * 1.6) * dt - (vn > 0 ? vn * 1.2 * dt : 0));
      if (this.outside > 5) this.damage(12 * dt, 'boundary', null);
      if (over > 700) { this.events.push({ type: 'autoReset' }); this.respawn(); }
    } else this.outside = 0;
  }

  /** Damage with shields first. Returns true if this destroyed the ship. */
  damage(amount, kind, byId) {
    if (this.dead || this.ghost > 0 || this.finished) return false;
    // A dodge (barrel roll) deflects lasers.
    if (kind === 'laser' && this.dodgeT > 0.05) { this.events.push({ type: 'deflect' }); return false; }
    this.lastKind = kind;
    const a = amount * (kind === 'collision' ? 1 : 1 - this.p.armor * 0.25);
    this.shieldDelay = 2.6;
    let rest = a;
    if (this.shield > 0) {
      const s = Math.min(this.shield, rest);
      this.shield -= s;
      rest -= s;
      if (this.shield <= 0) this.events.push({ type: 'shieldDown' });
    }
    if (rest > 0) this.hull -= rest;
    if (byId) this.lastHitBy = byId;
    this.events.push({ type: 'damaged', kind, amount: a, shieldOnly: rest <= 0, by: byId });
    if (this.hull <= 0) {
      this.hull = 0;
      this.destroy(byId);
      return true;
    }
    return false;
  }

  destroy(byId) {
    if (this.dead) return;
    this.dead = true;
    this.supersonic = false;
    this.deaths++;
    this.respawnT = this.battle ? 3 : 2.2;
    this.boosting = false;
    this.events.push({ type: 'destroyed', by: byId, cause: this.lastKind || null, pos: this.pos.clone() });
  }

  /** Race: back on the line where we are, facing forwards. Battle: a safe spawn. */
  respawn() {
    if (this.battle) {
      const sp = this.spawnPicker ? this.spawnPicker(this) : this.course.gridSlot(0);
      this.pos.copy(sp.pos);
      this.quat.copy(sp.quat);
      this.vel.copy(FWD).applyQuaternion(this.quat).multiplyScalar(60);
    } else {
      const course = this.course, L = course.length;
      // Back on the line where we were; if that spot is blocked, step BACK until it's
      // clear, so a recovery never gains ground.
      let u = this.trackU - 15 / L;
      for (let k = 0; k < 12 && this.world && this._blocked(course.pointAt(u, _t)); k++) u -= 20 / L;
      const f = course.frameAt(u);
      this.pos.copy(f.pos);
      this.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.R, f.U, f.T.clone().negate()));
      this.vel.copy(f.T).multiplyScalar(80);
      let du = (((u - this.trackU) % 1) + 1.5) % 1 - 0.5;
      this.dist += du * L;
      this.trackU = ((u % 1) + 1) % 1;
      this.trackI = Math.round(this.trackU * course.sampleCount);
      this._seekGate();
    }
    this.angVel.set(0, 0, 0);
    this.dead = false;
    this.hull = this.p.hull;
    this.shield = this.p.shield;
    this.ghost = this.battle ? 2.6 : 2.2;
    this.stun = 0;
    this.stunGuard = 0;
    this.supersonic = false;
    this.dodgeT = 0;
    this.streak = 0;
    this.wrongWay = 0;
    this.outside = 0;
    this.events.push({ type: 'respawn' });
  }

  _blocked(p) {
    let hit = false;
    this.world.forEachNear(p, 14, (c) => { if (!c.dead) hit = true; });
    return hit;
  }

  snapshot() {
    const r = (v) => Math.round(v * 100) / 100;
    return {
      p: [r(this.pos.x), r(this.pos.y), r(this.pos.z)],
      q: [+this.quat.x.toFixed(4), +this.quat.y.toFixed(4), +this.quat.z.toFixed(4), +this.quat.w.toFixed(4)],
      v: [r(this.vel.x), r(this.vel.y), r(this.vel.z)],
      b: this.boosting ? (this.supersonic ? 2 : 1) : 0, dg: this.dodgeT > 0 ? this.dodgeDir : 0, c: this.gateIdx, pr: +this.progress().toFixed(4), l: this.lap,
      h: Math.round(this.hull), s: Math.round(this.shield), f: this.finished ? 1 : 0, d: this.dead ? 1 : 0, g: this.ghost > 0 ? 1 : 0,
    };
  }
}
