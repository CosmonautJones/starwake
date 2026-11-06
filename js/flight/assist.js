// Player assists: everything that makes the player's ship easier to fly and shoot.
// Pure logic (no rendering) so tools/player-sim.mjs can measure it headlessly with the
// exact code the game runs.
//
//   PlayerAssist.softTarget()  aim assist: the rival nearest the reticle within a cone
//   leadPoint()                where to shoot so a bolt meets a moving target
//   PlayerAssist.gunArc()      how far the guns swivel off the nose
//   PlayerAssist.nudge()       flight assist: steer round obstacles, ease onto the target
//   PlayerAssist.lockCone()    auto-lock: how wide the missile seeker looks

import * as THREE from 'three';
import { clamp } from '../core/util.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _x = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Where to aim so a bolt at `speed` meets a target moving at constant velocity. */
export function leadPoint(fromPos, fromVel, tPos, tVel, speed, out) {
  // Bolts fly at `speed` plus the shooter's forward speed along the shot (no sideways carry).
  out.copy(tPos);
  for (let i = 0; i < 3; i++) {
    const dx = out.x - fromPos.x, dy = out.y - fromPos.y, dz = out.z - fromPos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const along = Math.max(0, (fromVel.x * dx + fromVel.y * dy + fromVel.z * dz) / d);
    const t = d / (speed + along);
    out.copy(tPos).addScaledVector(tVel, t);
  }
  return out;
}

export class PlayerAssist {
  constructor() {
    this.aim = 1;     // aim assist 0..1
    this.flight = 0.7; // flight assist 0..1
    this.target = null;
    this.avoid = null;
    this.avoidT = 0;
    this.avoidDir = new THREE.Vector3();
  }

  /** Soft target: the rival closest to the aim ray, sticky once chosen. */
  softTarget(origin, dir, self, entities, range = 950) {
    const cone = 0.035 + this.aim * 0.3;
    let best = null, bestScore = Infinity;
    for (const e of entities) {
      if (e === self || e.sim.dead || !e.connected || e.team != null && e.team === self.team) continue;
      _v.subVectors(e.sim.pos, origin);
      const d = _v.length();
      if (d > range) continue;
      const ang = dir.angleTo(_v);
      const lim = e === this.target ? cone * 1.5 : cone;
      const score = ang + d / 9000; // nearer wins ties
      if (ang < lim && score < bestScore) { bestScore = score; best = e; }
    }
    this.target = best;
    return best;
  }

  /** Gun swivel off the nose (radians): wider with aim assist, since the cursor leads the nose. */
  gunArc() { return 0.5 + this.aim * 0.25; }

  /** Missile seeker cone multiplier: with aim assist the lock builds on anything roughly ahead. */
  lockCone() { return 1 + this.aim * 4; }

  /**
   * Flight assist: nudge a copy of the stick to steer round obstacles ahead and, in a
   * dogfight with the stick near centre, ease the nose onto the soft target's lead.
   */
  nudge(sim, inp, world, { dt, battle, laserSpeed }) {
    const level = this.flight;
    if (level <= 0 || sim.dead) return inp;
    this.avoidT -= dt;
    if (this.avoidT <= 0) {
      this.avoidT = 0.08;
      this.avoid = null;
      const speed = sim.speed;
      if (speed > 15) {
        _x.copy(sim.vel).divideScalar(speed);
        const look = 30 + speed * 1.3;
        const hit = world.raycast(sim.pos, _w.copy(sim.pos).addScaledVector(_x, look), sim.p.radius + 4);
        const c = hit?.col;
        // Only things worth dodging: big rocks, structures, mines. Small breakables just smash.
        if (c && (c.item?.explosive || c.item?.maxHp == null || c.r > 7)) {
          const away = this.avoidDir.copy(sim.pos).addScaledVector(_x, hit.t).sub(_v.set(c.x, c.y, c.z));
          away.addScaledVector(_x, -away.dot(_x));
          if (away.lengthSq() < 0.5) away.set(0, 1, 0).cross(_x);
          away.normalize();
          this.avoid = { urgency: clamp(1 - hit.t / look, 0.25, 1) };
        }
      }
    }
    const inv = _q.copy(sim.quat).invert();
    if (this.avoid) {
      _v.copy(this.avoidDir).applyQuaternion(inv);
      const k = level * this.avoid.urgency * 0.9;
      inp.aimX = clamp(inp.aimX + _v.x * k, -1, 1);
      inp.aimY = clamp(inp.aimY + _v.y * k, -1, 1);
    }
    const t = this.target;
    const stick = Math.hypot(inp.aimX, inp.aimY);
    if (battle && t && !t.sim.dead && stick < 0.45 && !this.avoid) {
      leadPoint(sim.pos, sim.vel, t.sim.pos, t.sim.vel, laserSpeed, _v).sub(sim.pos).normalize().applyQuaternion(inv);
      const w = level * 0.55 * (1 - stick / 0.45);
      inp.aimX = clamp(inp.aimX + clamp(Math.atan2(_v.x, -_v.z) * 1.6, -0.6, 0.6) * w, -1, 1);
      inp.aimY = clamp(inp.aimY + clamp(Math.atan2(_v.y, -_v.z) * 1.6, -0.6, 0.6) * w, -1, 1);
    }
    return inp;
  }
}
