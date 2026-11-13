// AI pilot for wormhole races. Produces the same inputs a player does (stick, throttle,
// boost, fire, missile) plus an aim direction for its guns, so AI craft are bound by
// their design's stats.

import * as THREE from 'three';
import { clamp, mulberry32 } from '../core/util.js';

export const AI_SKILL = {
  easy: { gain: 2.2, throttle: 0.82, fire: 0.25, spread: 0.08, missile: 0.15, react: 0.5, boost: 0.15, gates: 0.35, corner: 0.8, risk: 0.1 },
  normal: { gain: 2.8, throttle: 0.93, fire: 0.45, spread: 0.05, missile: 0.45, react: 0.3, boost: 0.55, gates: 0.7, corner: 1, risk: 0.35, drift: 0.5 },
  hard: { gain: 3.4, throttle: 1, fire: 0.85, spread: 0.018, missile: 0.8, react: 0.15, boost: 1, gates: 0.95, corner: 1.2, risk: 0.6, drift: 1 },
};

const _inv = new THREE.Quaternion(), _l = new THREE.Vector3(), _t = new THREE.Vector3(), _a = new THREE.Vector3();
const _b = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();

/** Inverse of ship.js stickCurve, so the AI can ask for an exact turn-rate fraction. */
function invCurve(f) {
  const a = Math.min(1, Math.abs(f));
  if (a < 1e-4) return 0;
  const t = (-0.35 + Math.sqrt(0.1225 + 2.6 * a)) / 1.3;
  return Math.sign(f) * (0.035 + 0.965 * t);
}

export class FlightAI {
  constructor(ship, world, { skill = 'normal', seed = 1 } = {}) {
    this.ship = ship;
    this.world = world;
    this.cfg = AI_SKILL[skill] || AI_SKILL.normal;
    this.rng = mulberry32(seed);
    this.line = new THREE.Vector2((this.rng() - 0.5) * 0.6, (this.rng() - 0.5) * 0.6);
    this.input = { throttle: 0, brake: 0, boost: false, roll: 0, aimX: 0, aimY: 0, fire: false, missile: false, aimDir: new THREE.Vector3(0, 0, -1) };
    this.engage = null;
    this.thinkT = 0;
    this.burst = 0;
    this.avoid = new THREE.Vector3();
    this.avoidT = 0;
    this.shootItem = null;
  }

  think(dt, ships) {
    const sim = this.ship.sim;
    const cfg = this.cfg;
    const inp = this.input;
    const course = sim.course;
    const L = course.length;
    const fwd = _f.set(0, 0, -1).applyQuaternion(sim.quat);
    const speed = Math.max(20, sim.speed);

    // --- Where to go: pure pursuit down the wormhole in a personal lane, which
    // drifts slowly so the pack doesn't fly in file.
    this.laneT = (this.laneT || 0) - dt;
    if (this.laneT <= 0) {
      this.laneT = 2 + this.rng() * 3;
      this.laneGoal = new THREE.Vector2((this.rng() - 0.5) * 1.1, (this.rng() - 0.5) * 1.1);
    }
    if (this.laneGoal) this.line.lerp(this.laneGoal, 1 - Math.exp(-0.6 * dt));
    const look = 40 + speed * 0.45;
    const uT = sim.trackU + look / L;
    const fr = course.frameAt(uT);
    const R = course.tunnelRadiusAt(uT);
    _t.copy(fr.pos).addScaledVector(fr.R, this.line.x * R * 0.45).addScaledVector(fr.U, this.line.y * R * 0.45);

    // Boost gates: line up early, then aim straight through. Weaker pilots skip some.
    const rings = course.rings;
    const g = rings.length ? rings[sim.gateIdx] : null;
    if (g) {
      const ahead = (sim.gateLap + g.u) * L - sim.dist;
      if (this.gateFor !== g.index + sim.gateLap * 1000) {
        this.gateFor = g.index + sim.gateLap * 1000;
        this.wantGate = this.rng() < cfg.gates;
      }
      if (this.wantGate && ahead > 0 && ahead < look) {
        _t.copy(g.pos).addScaledVector(g.normal, Math.max(12, look - ahead));
      } else if (this.wantGate && ahead > 0 && ahead < look * 3) {
        // Shift into the gate's lane: its offset from the centre, applied here.
        course.pointAt(g.u, _u);
        _t.add(_a.subVectors(g.pos, _u)).addScaledVector(fr.R, -this.line.x * R * 0.45).addScaledVector(fr.U, -this.line.y * R * 0.45);
      }
    }

    // Split lanes: commit to a channel well before the divider's nose (weaker pilots
    // mostly take the wide safe one), then hold its centre until past the tail.
    const split = course.splits.length ? this._splitLane(course, sim, uT, L, cfg) : null;
    if (split) {
      const ax = split.sp.axis === 'up' ? fr.U : fr.R, cross = split.sp.axis === 'up' ? fr.R : fr.U;
      _t.copy(fr.pos).addScaledVector(ax, split.lane).addScaledVector(cross, split.cross);
    }

    // --- Obstacle check along our velocity.
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.08 + cfg.react * 0.15;
      this.shootItem = null;
      const look = 50 + speed * 1.1;
      _b.copy(sim.vel).normalize();
      if (_b.lengthSq() < 0.5) _b.copy(fwd);
      const end = _l.copy(sim.pos).addScaledVector(_b, look);
      const hit = this.world.raycast(sim.pos, end, sim.p.radius + 5);
      this.avoidT = 0;
      if (hit && hit.col) {
        const c = hit.col;
        _u.set(c.x, c.y, c.z);
        // Push sideways away from the obstacle centre, relative to our path.
        const closest = _l.copy(sim.pos).addScaledVector(_b, hit.t);
        this.avoid.subVectors(closest, _u);
        this.avoid.addScaledVector(_b, -this.avoid.dot(_b));
        if (this.avoid.lengthSq() < 1) this.avoid.set(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5).cross(_b);
        this.avoid.normalize().multiplyScalar(c.r + sim.p.radius + 14);
        this.avoidT = 1;
        if (c.item && c.item.maxHp != null && c.item.alive && c.item.hp < 160 && !c.item.explosive) this.shootItem = c.item;
        if (c.item && c.item.explosive) this.shootItem = c.item;
      }
    }
    if (this.avoidT > 0) _t.add(this.avoid).addScaledVector(this.avoid, 1.5);
    if (split) {
      // Dodging inside a channel must never steer us into the divider (or out of the channel).
      const ax = split.sp.axis === 'up' ? fr.U : fr.R;
      const lat = _a.subVectors(_t, fr.pos).dot(ax);
      const lo = split.lane - split.half, hi = split.lane + split.half;
      if (lat < lo || lat > hi) _t.addScaledVector(ax, clamp(lat, lo, hi) - lat);
    }
    // Never aim into the wall.
    _a.subVectors(_t, fr.pos);
    _a.addScaledVector(fr.T, -_a.dot(fr.T));
    const off = _a.length(), maxOff = R * 0.78;
    if (off > maxOff) _t.addScaledVector(_a, maxOff / off - 1);

    // --- Convert target to stick inputs. Steer the *velocity* onto the target: point
    // the nose past it by the current slip so flight assist carries us onto the line.
    _inv.copy(sim.quat).invert();
    _l.subVectors(_t, sim.pos).normalize();
    if (speed > 30) {
      _b.copy(sim.vel).normalize();
      _l.multiplyScalar(1.9).addScaledVector(_b, -0.9).normalize();
    }
    _l.applyQuaternion(_inv);
    const yawErr = Math.atan2(_l.x, -_l.z);
    const pitchErr = Math.atan2(_l.y, Math.hypot(_l.x, _l.z) * Math.sign(-_l.z || 1));
    const gn = cfg.gain;
    const wantYaw = clamp(yawErr * gn + sim.angVel.y * 0.25, -1, 1);
    const wantPitch = clamp(pitchErr * gn - sim.angVel.x * 0.25, -1, 1);
    inp.aimX = invCurve(wantYaw);
    inp.aimY = invCurve(wantPitch);
    if (_l.z > 0.2) { inp.aimX = yawErr >= 0 ? 1 : -1; } // target behind: turn hard

    // --- Drift: a bend that wants the stick pinned at speed is taken sideways (brake + steer),
    // held for at most a corner's worth, then released for the kick. Decided once per bend.
    const pinned = Math.max(Math.abs(wantYaw), Math.abs(wantPitch)) > 0.85 && Math.abs(yawErr) + Math.abs(pitchErr) > 0.32 && _l.z < 0;
    if (pinned && speed > sim.p.topSpeed * 0.55 && this.avoidT === 0) {
      if (!this.driftT) this.driftGo = this.rng() < (cfg.drift || 0);
      this.driftT = (this.driftT || 0) + dt;
    } else this.driftT = 0;
    const drifting = this.driftT > 0 && this.driftGo && this.driftT < 0.85;

    // Keep roughly level with the line's up so craft look composed.
    const upLocal = _b.copy(fr.U).applyQuaternion(_inv);
    inp.roll = clamp(Math.atan2(upLocal.x, upLocal.y) * 1.2, -1, 1) * 0.7;

    // --- Speed: the fastest we can carry through the bends ahead (the wall
    // forgives a little, so plan a bit more aggressively than in open space).
    const angle = Math.acos(clamp(_l.z * -1, -1, 1));
    const rate = sim.p.turnRate * cfg.corner;
    const kMax = course.maxCurvatureAhead(sim.trackU, 40 + speed * 0.9);
    let vOk = kMax > 1e-4 ? rate / kMax : Infinity;
    if (angle > 0.15) vOk = Math.min(vOk, (rate * Math.max(30, sim.pos.distanceTo(_t))) / angle);
    const maxV = sim.p.topSpeed;
    inp.throttle = clamp(vOk / maxV, 0.3, 1) * cfg.throttle;
    inp.brake = speed > vOk * 1.25 + 6 ? clamp((speed - vOk) / 90, 0.15, 1) : 0;
    if (drifting) inp.brake = 1;
    // Boost in committed bursts rather than flickering every step.
    this.boostT = (this.boostT || 0) - dt;
    if (this.boostT <= 0) { this.boostT = 0.8 + this.rng() * 0.6; this.boostRoll = this.rng() < cfg.boost; }
    inp.boost = this.boostRoll && sim.boost > 0.2 && angle < 0.2 && vOk > maxV * 1.2 && this.avoidT === 0;

    // --- Combat.
    inp.fire = false;
    inp.missile = false;
    let target = null, tDist = Infinity;
    for (const s of ships) {
      if (s.id === this.ship.id || s.sim.dead || s.sim.ghost > 0 || !s.connected || (this.ship.team != null && s.team === this.ship.team)) continue;
      _a.subVectors(s.sim.pos, sim.pos);
      const d = _a.length();
      if (d > 650) continue;
      if (_a.divideScalar(d).dot(fwd) < 0.93) continue;
      if (d < tDist) { tDist = d; target = s; }
    }
    if (this.shootItem && this.shootItem.alive) {
      inp.aimDir.subVectors(this.shootItem.pos, sim.pos).normalize();
      inp.fire = sim.heat < 0.85 && inp.aimDir.dot(fwd) > 0.9;
    } else if (target) {
      const tt = tDist / 1150;
      inp.aimDir.copy(target.sim.pos).addScaledVector(target.sim.vel, tt).sub(sim.pos).normalize();
      inp.aimDir.x += (this.rng() - 0.5) * cfg.spread * 2;
      inp.aimDir.y += (this.rng() - 0.5) * cfg.spread * 2;
      inp.aimDir.z += (this.rng() - 0.5) * cfg.spread * 2;
      inp.aimDir.normalize();
      // Fire in bursts, never into overheat.
      this.burst -= dt;
      if (this.burst <= -0.6) this.burst = this.rng() < cfg.fire ? 0.5 + this.rng() * 0.6 : -0.2;
      inp.fire = this.burst > 0 && sim.heat < 0.82;
      inp.missile = sim.lock.t >= 1 && sim.lock.id === target.id && sim.missiles > 0 && this.rng() < cfg.missile * dt * 2;
    } else {
      inp.aimDir.copy(fwd);
    }
    return inp;
  }

  /** The channel to fly while a split is near (ahead or alongside), or null. */
  _splitLane(course, sim, uT, L, cfg) {
    // From ~350 m before the nose (time to cross the tube) until the look-ahead passes the tail.
    const sp = course.splitAt(sim.trackU + 175 / L, 175 / L);
    if (!sp) return null;
    const ahead = (((uT - sp.u1) % 1) + 1.5) % 1 - 0.5;
    if (ahead * L > 20) return null;
    const key = sp.index + 1000 * Math.floor(sim.dist / L + 0.5);
    if (this.splitFor !== key) {
      this.splitFor = key;
      this.splitRisk = this.rng() < cfg.risk;
      this.splitCross = (this.rng() - 0.5) * 0.5;
    }
    // Alongside the divider there's no changing channel: fly the one we're in. Close to the
    // nose and still lined up with it, take whichever side is nearer.
    const at = ((((sim.trackU - sp.u0) % 1) + 1.5) % 1 - 0.5) * L;
    if (at > -140) {
      const f = course.frameAt(sim.trackU);
      const lat = _u.subVectors(sim.pos, f.pos).dot(sp.axis === 'up' ? f.U : f.R) * sp.side;
      if (at > -8 || Math.abs(lat - sp.offset) < sp.thick + sim.p.radius + 10) this.splitRisk = lat > sp.offset;
    }
    const margin = sim.p.radius + 9;
    if (this.splitRisk) {
      const half = Math.max(2, sp.riskHalf - margin);
      return { sp, lane: sp.riskLane, half, cross: 0 };
    }
    // Safe channel: between the far wall and the divider; stay off both.
    const half = Math.max(4, (sp.width + sp.offset - sp.thick) / 2 - margin - 6) * 0.6;
    return { sp, lane: sp.safeLane, half, cross: this.splitCross * sp.width * 0.5 };
  }
}
