// AI pilot for battle (arena deathmatch). Produces the same inputs a player does
// (stick, throttle, brake, boost, roll, fire, missile) plus a world-space gun
// direction, so bots are bound by their craft's stats and the same weapons.
//
// Behaviour is a small state machine with hysteresis (timers + cooldowns, so a
// bot commits to a decision for a moment instead of flip-flopping):
//
//   patrol   no target: collect pickups, shoot breakables that hold drops, wander.
//   pursue   lead pursuit onto a target's six, speed-matched in close, boost to
//            close long gaps; guns in bursts when the lead point is in the cone.
//   extend   after an overshoot / merge, or when a fight has gone nowhere for a
//            while (two bots circling): fly out straight, then come back in.
//   defend   someone is on our six and hitting us: break turn into them, jink,
//            brake-check (hard), then turn the tables.
//   evade    a missile is homing on us: beam it (fly across its line), jink,
//            burn boost, skim cover so it detonates on a rock.
//   retreat  low hull and no shield: run for a shield pickup or away from the
//            fight until the shield has recharged.
//
// Always on top of the state: obstacle avoidance along the velocity and the
// desired heading (throttled raycasts), mine-blast avoidance, and a soft keep-in
// that turns us back well before the arena edge.
//
// Usage:
//   const ai = new BattleAI(entity, world, { skill: 'normal', seed: 7, weapons });
//   const input = ai.think(dt, ships, { weapons });   // same object every call
//
// `weapons` (the WeaponSystem) lets the bot see missiles homing on it. Pass it
// once in the constructor options or per call via ctx; without it bots never
// evade missiles. The third think() argument may be anything else (the race
// passes its leader progress there) and is ignored unless it is an object.

import * as THREE from 'three';
import { clamp, mulberry32 } from '../core/util.js';
import { LASER } from './weapons.js';

export const BATTLE_SKILL = {
  // Slow to notice, sloppy aim, long pauses, rarely uses missiles, sometimes
  // forgets who it was chasing. Never breaks off to heal.
  easy: {
    react: 0.55, think: 0.14, gain: 2.3, velLag: 0.07, accelLead: 0, spread: 0.028, jitter: 0.012,
    fireCone: 0.4, range: 520, burstOn: [0.6, 1.2], burstOff: [0.3, 0.6], heatCap: 0.97,
    missile: 0.12, missileMin: 300, missileRange: 650, loseTrack: 0.025, dodge: 0.35, corner: 0.45, diag: false, feedForward: 0.7,
    boost: 0.35, jink: 0.4, mineTrap: false, retreatHull: 0, brakeCheck: 0, holdGhost: true, defend: 0.2, cover: 0.15,
  },
  normal: {
    react: 0.32, think: 0.1, gain: 2.8, velLag: 0.06, accelLead: 0.7, spread: 0.015, jitter: 0.007,
    fireCone: 0.47, range: 620, burstOn: [0.8, 1.6], burstOff: [0.15, 0.35], heatCap: 0.86,
    missile: 0.4, missileMin: 250, missileRange: 800, loseTrack: 0.006, dodge: 0.75, corner: 0.85, diag: true, feedForward: 0.9,
    boost: 0.75, jink: 0.5, mineTrap: true, retreatHull: 0.28, brakeCheck: 0.25, holdGhost: true, defend: 0.35, cover: 0.5,
  },
  hard: {
    react: 0.15, think: 0.07, gain: 3.4, velLag: 0.02, accelLead: 1, spread: 0.0075, jitter: 0.004,
    fireCone: 0.48, range: 760, burstOn: [0.8, 1.6], burstOff: [0.12, 0.3], heatCap: 0.86,
    missile: 0.9, missileMin: 130, missileRange: 900, loseTrack: 0, dodge: 1, corner: 1, diag: true, feedForward: 1,
    boost: 1, jink: 0.8, mineTrap: true, retreatHull: 0.34, brakeCheck: 0.6, holdGhost: true, defend: 0.9, cover: 1,
  },
};

const FWD = new THREE.Vector3(0, 0, -1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const HALF_PI = Math.PI / 2;
const _fwd = new THREE.Vector3(), _vd = new THREE.Vector3(), _D = new THREE.Vector3();
const _rel = new THREE.Vector3(), _los = new THREE.Vector3(), _tf = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _e = new THREE.Vector3();
const _gun = new THREE.Vector3(), _ql = new THREE.Vector3(), _inv = new THREE.Quaternion();

/** Inverse of ship.js stickCurve, so the AI can ask for an exact turn-rate fraction. */
function invCurve(f) {
  const a = Math.min(1, Math.abs(f));
  if (a < 1e-4) return 0;
  const t = (-0.35 + Math.sqrt(0.1225 + 2.6 * a)) / 1.3;
  return Math.sign(f) * (0.035 + 0.965 * t);
}

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Any unit vector perpendicular to unit `v`, written to `out`. */
function anyPerp(v, out) {
  out.crossVectors(v, Math.abs(v.y) < 0.9 ? WORLD_UP : _e.set(1, 0, 0));
  return out.normalize();
}

/** A ship we may shoot at / chase. */
function hostile(s, me) {
  return s !== me && s.id !== me.id && s.connected && !s.sim.dead && !(s.sim.ghost > 0) && !(me.team != null && s.team === me.team);
}

export class BattleAI {
  /**
   * @param {{id, sim, connected}} entity
   * @param {import('./world.js').SpaceWorld} world
   * @param {{skill?: 'easy'|'normal'|'hard', seed?: number, weapons?: import('./weapons.js').WeaponSystem, humanBias?: number}} opts
   *   humanBias 0..0.6: how much more readily this bot picks human pilots (entity.kind 'player'/'remote').
   */
  constructor(entity, world, { skill = 'normal', seed = 1, weapons = null, humanBias = 0 } = {}) {
    this.ship = entity;
    this.world = world;
    this.skill = BATTLE_SKILL[skill] ? skill : 'normal';
    this.cfg = BATTLE_SKILL[this.skill];
    this.weapons = weapons;
    this.humanBias = clamp(humanBias, 0, 0.6);
    this.rng = mulberry32(((seed >>> 0) * 2654435761 + 0x5bd1e995) >>> 0);
    this.input = { throttle: 0, brake: 0, boost: false, roll: 0, aimX: 0, aimY: 0, fire: false, missile: false, aimDir: new THREE.Vector3(0, 0, -1) };

    // Personality (stable for the bot's life).
    const r = this.rng;
    this.prefRange = 130 + r() * 100;      // where it likes to sit behind a target
    this.caution = 0.8 + r() * 0.45;       // scales the retreat threshold
    this.circleLimit = 6 + r() * 4;        // seconds of fruitless turning before changing plan

    // Static lookups from the world.
    this.mines = world.items.filter((i) => i.explosive);
    this.drops = world.items.filter((i) => i.maxHp != null && !i.explosive && i.drop);
    // Anything solid enough to stop a missile (they detonate on any collider).
    this.cover = world.items.filter((i) => !i.explosive && i.radius >= 6);

    // Persistent vectors.
    this.pv = new THREE.Vector3();       // perceived target velocity (lagged)
    this.pa = new THREE.Vector3();       // perceived target acceleration
    this.tPrevV = new THREE.Vector3();
    this.lead = new THREE.Vector3();     // gun intercept point for the target
    this.aimErr = new THREE.Vector3();
    this.avoidDir = new THREE.Vector3();
    this.goal = new THREE.Vector3();
    this.extendDir = new THREE.Vector3();
    this.jinkV = new THREE.Vector3();
    this.prevD = new THREE.Vector3();
    this.ffW = new THREE.Vector3();      // angular velocity of the wanted heading (feed-forward)

    this.state = 'patrol';
    this.stateT = 0;
    this.time = 0;
    this.target = null;
    this.targetId = null;      // read by other bots to spread out their targets
    this.frustrated = new Map();
    this.wasDead = false;
    this._resetLife();
  }

  _resetLife() {
    const sim = this.ship.sim;
    this._setState('patrol');
    this.target = null;
    this.targetId = null;
    this.holdT = 0;
    this.retargetT = 0;
    this.lostT = 0;
    this.dmg = 0;
    this.lastEhp = sim.hull + sim.shield;
    this.revengeId = null;
    this.revengeT = 0;
    this.gunThreat = null;
    this.gunThreatT = 0;
    this.missile = null;
    this.missileT = 0;
    this.dodgeThis = true;
    this.missileSeen = null;
    this.mergeCd = 0;
    this.defendCd = 0;
    this.retreatCd = 0;
    this.forageCd = 3;
    this.coverT = 0;
    this.coverPick = null;
    this.turnBackT = 0;
    this.dry = 0;
    this.burstOn = false;
    this.burstT = 0;
    this.aimErrT = 0;
    this.rayT = 0;
    this.rayFlip = false;
    this.avoidU = 0;
    this.avoidHold = 0;
    this.avoidBig = false;
    this.blockItem = null;
    this.shootItem = null;
    this.pickup = null;
    this.pickupT = 0;
    this.goalT = 0;
    this.jinkT = 0;
    this.rollJink = 0;
    this.brakeT = 0;
    this.attacker = null;
    this.losId = null;
    this.losT = 0;
    this.losOk = true;
    this.leadOk = false;
    this.leadR = Infinity;
    this.boostGate = false;
    this.boostGateT = 0;
    this.turnX = 0;
    this.turnY = 1;
    this.firedAt = null;
    this.hasPrevD = false;
    this.ffW.set(0, 0, 0);
  }

  _setState(s) {
    if (this.state !== s) { this.state = s; this.stateT = 0; }
  }

  /**
   * @param {number} dt fixed step
   * @param {{id, sim, connected}[]} ships every entity in the match (self included)
   * @param {{weapons?: import('./weapons.js').WeaponSystem}} [ctx]
   */
  think(dt, ships, ctx) {
    const me = this.ship, sim = me.sim, cfg = this.cfg, inp = this.input;
    if (ctx && typeof ctx === 'object' && ctx.weapons) this.weapons = ctx.weapons;
    this.time += dt;
    this._dt = dt;
    this.firedAt = null;
    if (sim.dead) {
      inp.throttle = 0; inp.brake = 0; inp.boost = false; inp.roll = 0; inp.aimX = 0; inp.aimY = 0;
      inp.fire = false; inp.missile = false;
      this.wasDead = true;
      return inp;
    }
    if (this.wasDead) { this.wasDead = false; this._resetLife(); }
    this.stateT += dt;

    const fwd = _fwd.copy(FWD).applyQuaternion(sim.quat);
    const speed = sim.vel.length();
    if (speed > 1) _vd.copy(sim.vel).divideScalar(speed); else _vd.copy(fwd);

    // --- Senses: damage taken, who's shooting, incoming missiles.
    const ehp = sim.hull + sim.shield;
    if (ehp < this.lastEhp - 0.01) {
      this.dmg += this.lastEhp - ehp;
      if (sim.lastHitBy != null && sim.lastHitBy !== me.id) { this.revengeId = sim.lastHitBy; this.revengeT = 5; }
    }
    this.lastEhp = ehp;
    this.dmg *= Math.exp(-dt / 1.2);
    if (this.revengeT > 0) this.revengeT -= dt;
    if (this.mergeCd > 0) this.mergeCd -= dt;
    if (this.defendCd > 0) this.defendCd -= dt;
    if (this.retreatCd > 0) this.retreatCd -= dt;
    if (this.forageCd > 0) this.forageCd -= dt;
    if (this.turnBackT > 0) this.turnBackT -= dt;
    if (this.lostT > 0) this.lostT -= dt;
    if (this.brakeT > 0) this.brakeT -= dt;
    this._senseThreats(ships, dt);

    // --- Decide.
    this._chooseTarget(dt, ships, fwd);
    if (this.target) this._updateLead(dt, speed);
    this._transitions(ships, fwd);

    // --- Fly the state: writes _D, throttle, brake, boost; returns "precise".
    inp.boost = false;
    inp.brake = 0;
    this.rollJink = 0;
    let precise = false;
    switch (this.state) {
      case 'pursue': precise = this._pursue(dt, fwd, speed); break;
      case 'extend': this._extend(dt, fwd); break;
      case 'defend': precise = this._defend(dt, fwd, speed); break;
      case 'evade': precise = this._evade(dt, fwd, speed); break;
      case 'retreat': this._retreat(dt, ships, fwd); break;
      case 'forage': precise = this._forage(dt, fwd); break;
      default: this._patrol(dt, ships, fwd); break;
    }
    this._pickupDetour(dt, fwd);
    this._keepIn(sim);
    precise = this._avoid(dt, sim, speed) ? false : precise;
    if (inp.boost) {
      // Boost is scarce (it barely regenerates): only burn it when it's worth it.
      if (sim.boost < 0.04 || this.avoidU > 0.5) inp.boost = false;
    }
    this._steer(sim, speed, precise);
    this._fireControl(dt, ships, fwd);
    return inp;
  }

  // ------------------------------------------------------------------ senses
  _senseThreats(ships, dt) {
    const me = this.ship, sim = me.sim;
    let best = null, bestD = 650;
    for (const s of ships) {
      if (s === me || s.id === me.id || !s.connected || s.sim.dead) continue;
      _rel.subVectors(sim.pos, s.sim.pos);
      const d = _rel.length();
      if (d > bestD || d < 1) continue;
      _tf.copy(FWD).applyQuaternion(s.sim.quat);
      if (_tf.dot(_rel) / d > 0.94) { bestD = d; best = s; }
    }
    if (best && best === this.gunThreat) this.gunThreatT += dt;
    else if (best) { this.gunThreat = best; this.gunThreatT = dt; }
    else { this.gunThreatT = Math.max(0, this.gunThreatT - dt * 2); if (this.gunThreatT === 0) this.gunThreat = null; }

    this.missile = null;
    const w = this.weapons;
    if (w) {
      let md = Infinity;
      for (const m of w.missiles) {
        if (!m.alive || m.target !== me.id) continue;
        const d = m.pos.distanceTo(sim.pos);
        if (d < md) { md = d; this.missile = m; }
      }
    }
    if (this.missile) {
      if (this.missileSeen !== this.missile) {
        this.missileSeen = this.missile;
        this.missileT = 0;
        this.dodgeThis = this.rng() < this.cfg.dodge;
      }
      this.missileT += dt;
    } else { this.missileT = 0; this.missileSeen = null; }
  }

  _byId(ships, id) {
    if (id == null) return null;
    for (const s of ships) if (s.id === id) return s;
    return null;
  }

  // ------------------------------------------------------------------ targets
  _chooseTarget(dt, ships, fwd) {
    const me = this.ship, sim = me.sim, cfg = this.cfg;
    const cur = this.target && hostile(this.target, me) ? this.target : null;
    if (!cur && this.target) { this.target = null; this.retargetT = 0; }
    if (cur && cfg.loseTrack > 0 && this.dmg < 5 && this.rng() < cfg.loseTrack * dt) {
      // Easy pilots lose the plot now and then.
      this.target = null;
      this.lostT = 1.5 + this.rng() * 2;
      this.targetId = null;
      return;
    }
    if (this.lostT > 0 && this.dmg < 6) { this.target = null; this.targetId = null; return; }
    if (this.holdT > 0) this.holdT -= dt;
    this.retargetT -= dt;
    if (cur && this.retargetT > 0) return;
    this.retargetT = 0.25 + cfg.react * 0.8;
    for (const [id, t] of this.frustrated) { if (t - this.retargetT <= 0) this.frustrated.delete(id); else this.frustrated.set(id, t - this.retargetT); }

    const A = sim.course;
    let best = null, bestCost = Infinity, curCost = Infinity;
    for (const s of ships) {
      if (!hostile(s, me)) continue;
      _rel.subVectors(s.sim.pos, sim.pos);
      const d = _rel.length();
      if (d < 1) continue;
      const ang = Math.acos(clamp(fwd.dot(_rel) / d, -1, 1));
      let cost = d * (1 + 0.55 * ang);
      const hp = (s.sim.hull + s.sim.shield) / (s.sim.p.hull + s.sim.p.shield);
      cost *= 0.45 + 0.55 * hp; // finish off the wounded
      if (s.id === this.revengeId && this.revengeT > 0) cost *= 0.55;
      if (s === cur) cost *= 0.7;
      let crowd = 0;
      for (const o of ships) if (o !== me && o.ai && o.ai !== this && o.ai.targetId === s.id) crowd++;
      cost *= 1 + 0.3 * crowd;
      if (A && A.center && s.sim.pos.distanceTo(A.center) > A.radius * 0.93) cost *= 1.6;
      if (this.frustrated.has(s.id)) cost *= 2.2;
      if (this.humanBias && (s.kind === 'player' || s.kind === 'remote')) cost *= 1 - this.humanBias;
      if (s === cur) curCost = cost;
      if (cost < bestCost) { bestCost = cost; best = s; }
    }
    if (!best) { this.target = null; this.targetId = null; return; }
    if (cur && best !== cur && (this.holdT > 0 || bestCost > curCost * 0.65)) return;
    if (best !== cur) this._setTarget(best);
  }

  _setTarget(s) {
    this.target = s;
    this.targetId = s ? s.id : null;
    this.holdT = 3.5 + this.rng() * 2;
    this.dry = 0;
    this.leadOk = false;
    if (s) { this.pv.copy(s.sim.vel); this.pa.set(0, 0, 0); this.tPrevV.copy(s.sim.vel); }
  }

  /** Perceived target motion (lagged by skill) and the gun intercept point. */
  _updateLead(dt, speed) {
    const sim = this.ship.sim, T = this.target.sim, cfg = this.cfg;
    const k = 1 - Math.exp(-dt / Math.max(0.02, cfg.velLag));
    this.pv.lerp(T.vel, k);
    if (cfg.accelLead > 0) {
      _a.subVectors(T.vel, this.tPrevV).divideScalar(Math.max(dt, 1e-4));
      if (_a.lengthSq() > 640 * 640) _a.setLength(640); // respawns, bumps
      this.pa.lerp(_a, 1 - Math.exp(-dt / 0.15));
    }
    this.tPrevV.copy(T.vel);
    _rel.subVectors(T.pos, sim.pos);
    const R = _rel.length();
    const S = LASER.speed + Math.max(0, sim.vel.dot(_rel) / Math.max(R, 1));
    let t = R / S;
    for (let i = 0; i < 3; i++) {
      this.lead.copy(T.pos).addScaledVector(this.pv, t);
      if (cfg.accelLead > 0) this.lead.addScaledVector(this.pa, 0.5 * t * t * cfg.accelLead);
      t = this.lead.distanceTo(sim.pos) / S;
    }
    this.leadR = R;
    this.leadOk = t < LASER.life * 0.95;
    void speed;
  }

  // ------------------------------------------------------------------ state machine
  _transitions(ships, fwd) {
    const me = this.ship, sim = me.sim, cfg = this.cfg;
    const st = this.state;

    // Missile on us: evade (after a reaction delay; weak pilots sometimes don't).
    if (this.missile && this.dodgeThis && this.missileT > cfg.react * 1.2 && this.missile.pos.distanceTo(sim.pos) < 1000) {
      if (st !== 'evade') this._setState('evade');
      return;
    }
    if (st === 'evade') this._setState(this.target ? 'pursue' : 'patrol');

    // Badly hurt with shields gone: break off and heal.
    if (st !== 'retreat' && cfg.retreatHull > 0 && this.retreatCd <= 0 && sim.hullN < cfg.retreatHull * this.caution && sim.shield < 12) {
      this._setState('retreat');
      this.goalT = 0;
      return;
    }
    if (st === 'retreat') {
      const healed = sim.shield >= sim.p.shield * 0.85 && this.stateT > 2.5;
      if (healed || this.stateT > 9) { this.retreatCd = 10; this._setState(this.target ? 'pursue' : 'patrol'); }
      else return;
    }

    // Someone on our six and hitting us: defend.
    const att = this.gunThreat || (this.revengeT > 4 ? this._byId(ships, this.revengeId) : null);
    const underFire = this.dmg > 12 || (this.gunThreat && this.gunThreatT > cfg.react + 0.6 && this.gunThreat.sim.pos.distanceTo(sim.pos) < 350);
    if (st !== 'defend' && underFire && att && !att.sim.dead && this.defendCd <= 0) {
      _rel.subVectors(att.sim.pos, sim.pos).normalize();
      if (fwd.dot(_rel) < -0.05) { // behind the wing line
        if (this.rng() > cfg.defend) { this.defendCd = 4; return; } // didn't react in time: press on
        this.attacker = att;
        this._setState('defend');
        this.defendDur = 0.9 + this.rng() * 0.8;
        this.jinkT = 0;
        return;
      }
      // In front of us: just fight them.
      if (hostile(att, me) && att !== this.target && this.holdT <= 1.5) {
        const T = this.target && this.target.sim;
        const tHp = T ? (T.hull + T.shield) / (T.p.hull + T.p.shield) : 1;
        if (!T || (tHp > 0.7 && att.sim.pos.distanceTo(sim.pos) < this.leadR * 0.8)) this._setTarget(att);
      }
    }
    if (st === 'defend') {
      const a = this.attacker;
      if (!a || a.sim.dead || this.stateT > this.defendDur) {
        this.defendCd = 2.5;
        if (a && hostile(a, me)) this._setTarget(a);
        this._setState(this.target ? 'pursue' : 'patrol');
      }
      return;
    }

    if (st === 'extend') {
      if (!this.target || this.stateT > this.extendDur || this.leadR > 750) {
        this.mergeCd = 2;
        this._setState(this.target ? 'pursue' : 'patrol');
      }
      return;
    }
    if (st === 'forage') {
      if (this.shootItem && !this.shootItem.alive) {
        // It broke: the drop spawns where it was; fly through it (the magnet does the rest).
        this.shootItem = null;
        this.pickup = this._findPickup(300, false);
      }
      const it = this.shootItem;
      const pk = this.pickup;
      const busy = (it && it.alive) || (pk && pk.alive);
      if (!busy || this.stateT > 6 || this.dmg > 6 || (this.target && this.leadR < 260)) {
        this.forageCd = 7 + this.rng() * 4;
        this.shootItem = null;
        this._setState(this.target ? 'pursue' : 'patrol');
      }
      return;
    }
    // Out of missiles (or hurt) with nobody close: crack open a crate on the way.
    if (st === 'pursue' && this.forageCd <= 0 && this.leadR > 450 && !this.gunThreat && this.dmg < 3 &&
        (sim.missiles === 0 || sim.hullN < 0.6)) {
      const it = this._findDrop(450, fwd, 0.3);
      if (it) { this.shootItem = it; this.pickup = null; this._setState('forage'); return; }
      this.forageCd = 1.5;
    }
    if (this.target) { if (st !== 'pursue') this._setState('pursue'); }
    else if (st !== 'patrol') this._setState('patrol');
  }

  /** The best breakable holding something we want, within range and roughly ahead. */
  _findDrop(range, fwd, minDot) {
    const sim = this.ship.sim;
    let best = null, bd = Infinity;
    for (const it of this.drops) {
      if (!it.alive) continue;
      const d = it.pos.distanceTo(sim.pos);
      if (d > range || d < 60) continue;
      if (_a.subVectors(it.pos, sim.pos).divideScalar(d).dot(fwd) < minDot) continue;
      let w = 1;
      if (it.drop === 'missile') w = sim.missiles === 0 ? 0.5 : sim.missiles < 4 ? 0.8 : 1.6;
      else if (it.drop === 'shield') w = sim.hullN < 0.6 ? 0.5 : 1.2;
      else if (it.drop === 'boost') w = sim.boost < 0.5 ? 0.9 : 1.4;
      const c = d * w * (it.hp > 60 ? 1.5 : 1);
      if (c < bd) { bd = c; best = it; }
    }
    return best;
  }

  _forage(dt, fwd) {
    const sim = this.ship.sim, inp = this.input;
    if (this.shootItem) {
      this.goal.copy(this.shootItem.pos);
      const d = this.goal.distanceTo(sim.pos);
      _D.subVectors(this.goal, sim.pos).divideScalar(Math.max(d, 1));
      if (d < 120 && fwd.dot(_D) < 0.85) {
        // Too close to line up: open the range, then come round again.
        _D.negate().add(fwd).normalize();
        inp.throttle = 1;
        return false;
      }
      inp.throttle = d < 200 ? 0.5 : 0.85;
      return d < 500;
    } else if (this.pickup && this.pickup.alive) {
      _D.subVectors(this.pickup.pos, sim.pos).normalize();
      inp.throttle = 0.8;
    } else { _D.copy(fwd); inp.throttle = 0.8; }
    void dt;
    return false;
  }

  _startExtend(fwd, awayFrom, dur) {
    // Out along our heading, away from the target, with a climb or dive so the
    // next pass comes from a new angle.
    _a.subVectors(this.ship.sim.pos, awayFrom).normalize();
    this.extendDir.copy(fwd).add(_a);
    anyPerp(fwd, _b);
    this.extendDir.addScaledVector(_b.applyAxisAngle(fwd, this.rng() * Math.PI * 2), 0.5);
    if (this.extendDir.lengthSq() < 1e-4) this.extendDir.copy(fwd);
    this.extendDir.normalize();
    this.extendDur = dur;
    this._setState('extend');
  }

  // ------------------------------------------------------------------ behaviours
  _pursue(dt, fwd, speed) {
    const sim = this.ship.sim, cfg = this.cfg, inp = this.input;
    const T = this.target.sim;
    _rel.subVectors(T.pos, sim.pos);
    const R = Math.max(1, _rel.length());
    _los.copy(_rel).divideScalar(R);
    const cosAta = clamp(fwd.dot(_los), -1, 1);
    const ata = Math.acos(cosAta);
    _tf.copy(FWD).applyQuaternion(T.quat);
    const theyPoint = -_tf.dot(_los);     // ~1: their nose is on us
    const closing = -_a.subVectors(T.vel, sim.vel).dot(_los);

    // Merge / overshoot: they're beside or behind us at close range.
    if (R < 260 && ata > 1.65 && this.mergeCd <= 0) {
      this.mergeCd = 3;
      if (theyPoint > 0.85 && this.rng() < 0.4 + 0.6 * cfg.defend) {
        this.attacker = this.target;
        this._setState('defend');
        this.defendDur = 1 + this.rng() * 0.8;
        this.jinkT = 0;
        return this._defend(dt, fwd, speed);
      }
      const agile = sim.p.turnRate >= T.p.turnRate * 0.95;
      if (this.rng() < (agile ? 0.75 : 0.35)) this.turnBackT = 2.5;
      else { this._startExtend(fwd, T.pos, 1.6 + this.rng()); this._extend(dt, fwd); return false; }
    }

    // Fruitless fight (circling with no shot): change the plan.
    if (R < 800) {
      this.dry += dt;
      if (this.dry > this.circleLimit) {
        this.dry = 0;
        if (this.rng() < 0.5) { this._startExtend(fwd, T.pos, 2 + this.rng()); this._extend(dt, fwd); return false; }
        this.frustrated.set(this.target.id, 8);
        this.holdT = 0;
        this.retargetT = 0;
      }
    } else this.dry = Math.max(0, this.dry - dt);

    // Where to point.
    let precise = false;
    if (this.leadOk && (ata < 0.6 || R < 700)) {
      // Guns range: put the nose on the lead point (the gimbal does the rest).
      _D.subVectors(this.lead, sim.pos).normalize();
      precise = R < 700;
    } else {
      const tl = clamp(R / Math.max(150, speed + 80), 0, 2) * 0.7;
      _D.copy(T.pos).addScaledVector(this.pv, tl).sub(sim.pos).normalize();
    }
    // Very close and closing fast: lag pursuit (aim at them, not ahead) and brake.
    if (R < 140 && closing > 35 && ata < 1.2) { _D.copy(_los); precise = true; }

    // Speed.
    const top = sim.p.topSpeed;
    let want;
    const corner = top * (0.95 - 0.35 * cfg.corner);  // tighter radius for the turning fight
    if (this.turnBackT > 0) want = corner;
    else if (ata < 0.45) want = T.vel.length() + (R - this.prefRange) * 0.7;
    else if (R < 650) want = top + (corner - top) * clamp((ata - 0.45) / 0.4, 0, 1);
    else want = top;
    want = clamp(want, 60, top);
    inp.throttle = want / top;
    if (speed > want + 18) inp.brake = clamp((speed - want - 18) / 60, 0, 1);
    if (R < 130 && closing > 35 && ata < 1.2) inp.brake = Math.max(inp.brake, 0.6);
    this.boostGateT -= dt;
    if (this.boostGateT <= 0) { this.boostGateT = 0.6; this.boostGate = this.rng() < cfg.boost; }
    inp.boost = this.boostGate && R > 750 && ata < 0.3 && sim.boost > 0.4;
    return precise;
  }

  _extend(dt, fwd) {
    const inp = this.input, sim = this.ship.sim;
    _D.copy(this.extendDir);
    inp.throttle = 1;
    this.boostGateT -= dt;
    if (this.boostGateT <= 0) { this.boostGateT = 0.6; this.boostGate = this.rng() < this.cfg.boost; }
    inp.boost = this.boostGate && sim.boost > 0.3 && this.stateT < 1.2;
    void fwd;
  }

  _defend(dt, fwd, speed) {
    const inp = this.input, sim = this.ship.sim, cfg = this.cfg;
    const A = this.attacker.sim;
    _rel.subVectors(A.pos, sim.pos);
    const d = Math.max(1, _rel.length());
    _los.copy(_rel).divideScalar(d);
    // Break turn into the attacker: across our nose toward their side.
    _D.copy(_los).addScaledVector(fwd, -fwd.dot(_los));
    if (_D.lengthSq() < 1e-4) anyPerp(fwd, _D);
    _D.normalize().addScaledVector(fwd, 0.15);
    // Jink: change the turn plane every so often so they can't settle the aim.
    this.jinkT -= dt;
    if (this.jinkT <= 0) {
      this.jinkT = 0.3 + this.rng() * 0.45;
      anyPerp(fwd, this.jinkV).applyAxisAngle(fwd, this.rng() * Math.PI * 2);
      this.rollSign = this.rng() < 0.5 ? -1 : 1;
    }
    _D.addScaledVector(this.jinkV, 0.8 * cfg.jink).normalize();
    this.rollJink = this.rollSign * 0.6 * cfg.jink;
    inp.throttle = 1;
    // Brake check: they're right behind and closing - make them overshoot.
    const closing = _a.subVectors(A.vel, sim.vel).dot(_los) * -1;
    if (this.brakeT <= 0 && d < 150 && closing > 30 && this.rng() < cfg.brakeCheck * dt * 4) this.brakeT = 0.45;
    if (this.brakeT > 0) { inp.brake = 1; inp.throttle = 0.3; }
    else {
      this.boostGateT -= dt;
      if (this.boostGateT <= 0) { this.boostGateT = 0.5; this.boostGate = this.rng() < cfg.boost * 0.7; }
      inp.boost = this.boostGate && d < 320 && sim.boost > 0.25;
    }
    void speed;
    return true;
  }

  _evade(dt, fwd, speed) {
    const inp = this.input, sim = this.ship.sim, cfg = this.cfg;
    const m = this.missile;
    _rel.subVectors(m.pos, sim.pos);
    const d = Math.max(1, _rel.length());
    _los.copy(_rel).divideScalar(d);
    // Beam it: fly across the missile's line of sight, keeping our side.
    _D.copy(_vd).addScaledVector(_los, -_vd.dot(_los));
    if (_D.lengthSq() < 0.02) anyPerp(_los, _D);
    _D.normalize();
    // Late: hard break with jinks.
    if (d < 180) {
      this.jinkT -= dt;
      if (this.jinkT <= 0) { this.jinkT = 0.25 + this.rng() * 0.3; anyPerp(_los, this.jinkV).applyAxisAngle(_los, this.rng() * Math.PI * 2); this.rollSign = this.rng() < 0.5 ? -1 : 1; }
      _D.addScaledVector(this.jinkV, 0.6 * cfg.jink).normalize();
      this.rollJink = this.rollSign * 0.7 * cfg.jink;
    }
    // Cover: get a rock between us and the missile - it detonates on whatever it hits.
    // (Weak pilots only think of it sometimes; re-chosen a few times a second.)
    this.coverT -= dt;
    if (this.coverT <= 0) {
      this.coverT = 0.3;
      this.coverPick = null;
      if (this.rng() < cfg.cover) {
        let bd = Math.min(450, d * 0.8);
        for (const c of this.cover) {
          if (!c.alive) continue;
          const cd = c.pos.distanceTo(sim.pos) - c.radius;
          if (cd > bd || cd < 8) continue;
          _a.subVectors(c.pos, sim.pos).divideScalar(cd + c.radius);
          if (_a.dot(_vd) < -0.1 || _a.dot(_los) > 0.5) continue; // behind us, or toward the missile
          bd = cd; this.coverPick = c;
        }
      }
    }
    const cv = this.coverPick;
    if (cv && cv.alive) {
      // The far side of the cover as seen from the missile.
      _a.subVectors(cv.pos, m.pos).normalize();
      _b.copy(cv.pos).addScaledVector(_a, cv.radius + sim.p.radius + 14).sub(sim.pos);
      const bl = _b.length();
      if (bl > 1) _D.lerp(_b.divideScalar(bl), d < 120 ? 0.4 : 0.8).normalize();
    }
    inp.throttle = 1;
    inp.boost = sim.boost > 0.05 && d < 700 && this.rng() < 0.5 + 0.5 * cfg.dodge;
    void speed;
    return true;
  }

  _retreat(dt, ships, fwd) {
    const inp = this.input, me = this.ship, sim = me.sim;
    this.goalT -= dt;
    if (this.goalT <= 0) {
      this.goalT = 0.8;
      this.pickup = this._findPickup(1100, true);
      if (!this.pickup) {
        // Away from the nearest enemy, toward the middle of the arena.
        let near = null, nd = Infinity;
        for (const s of ships) {
          if (!hostile(s, me)) continue;
          const d = s.sim.pos.distanceToSquared(sim.pos);
          if (d < nd) { nd = d; near = s; }
        }
        // (pull toward the centre grows with how far out we are)
        this.goal.copy(sim.course.center).sub(sim.pos).multiplyScalar(1.2 / Math.max(1, sim.course.radius));
        if (near) this.goal.add(_a.subVectors(sim.pos, near.sim.pos).normalize());
        if (this.goal.lengthSq() < 1e-4) this.goal.copy(fwd);
        this.goal.normalize().multiplyScalar(400).add(sim.pos);
      }
    }
    if (this.pickup && this.pickup.alive) this.goal.copy(this.pickup.pos);
    _D.subVectors(this.goal, sim.pos).normalize();
    if (this.gunThreat && this.gunThreatT > 0.2) {
      this.jinkT -= dt;
      if (this.jinkT <= 0) { this.jinkT = 0.35 + this.rng() * 0.4; anyPerp(fwd, this.jinkV).applyAxisAngle(fwd, this.rng() * Math.PI * 2); }
      _D.addScaledVector(this.jinkV, 0.6 * this.cfg.jink).normalize();
      inp.boost = sim.boost > 0.25;
    }
    inp.throttle = 1;
  }

  _patrol(dt, ships, fwd) {
    const inp = this.input, sim = this.ship.sim, A = sim.course;
    this.goalT -= dt;
    if (this.goalT <= 0 || (this.shootItem && !this.shootItem.alive)) {
      this.goalT = 1;
      this.pickup = this._findPickup(900, false);
      this.shootItem = null;
      if (!this.pickup) {
        // A breakable with a drop, ahead of us.
        let best = null, bd = 600;
        for (const it of this.drops) {
          if (!it.alive) continue;
          const d = it.pos.distanceTo(sim.pos);
          if (d < bd && d > 70 && _a.subVectors(it.pos, sim.pos).divideScalar(d).dot(fwd) > 0.2) { bd = d; best = it; }
        }
        this.shootItem = best;
        if (!best && (this.goal.distanceTo(sim.pos) < 150 || this.wanderT === undefined || this.time > this.wanderT)) {
          this.wanderT = this.time + 5 + this.rng() * 4;
          const r = A.radius * 0.5 * Math.cbrt(this.rng());
          anyPerp(fwd, _a).applyAxisAngle(fwd, this.rng() * Math.PI * 2).addScaledVector(fwd, 1.2).normalize();
          this.goal.copy(A.center).addScaledVector(_a, r);
        }
      }
    }
    if (this.pickup && this.pickup.alive) this.goal.copy(this.pickup.pos);
    else if (this.shootItem) this.goal.copy(this.shootItem.pos);
    _D.subVectors(this.goal, sim.pos).normalize();
    inp.throttle = 0.8;
    void ships;
  }

  /** Nearest pickup worth having. `urgent`: shields first, at any range given. */
  _findPickup(range, urgent) {
    const sim = this.ship.sim, pickups = this.world.pickups;
    if (!pickups || !pickups.size) return null;
    let best = null, bd = range;
    for (const pk of pickups.values()) {
      if (!pk.alive) continue;
      let want = 0;
      if (pk.kind === 'shield') want = sim.hullN < 0.85 || sim.shield < sim.p.shield * 0.6 ? (urgent ? 2 : 1.4) : 0.4;
      else if (pk.kind === 'missile') want = sim.missiles < 4 ? (sim.missiles === 0 ? 1.3 : 0.9) : 0;
      else if (pk.kind === 'boost') want = sim.boost < 0.8 ? 1 : 0;
      if (urgent && pk.kind !== 'shield') want *= 0.4;
      if (want <= 0) continue;
      const d = pk.pos.distanceTo(sim.pos) / want;
      if (d < bd) { bd = d; best = pk; }
    }
    return best;
  }

  /** While fighting: grab pickups that are nearly on the way. */
  _pickupDetour(dt, fwd) {
    if (this.state !== 'pursue' && this.state !== 'extend') return;
    const sim = this.ship.sim;
    this.pickupT -= dt;
    if (this.pickupT <= 0) {
      this.pickupT = 0.3;
      const pk = this._findPickup(this.state === 'extend' ? 400 : 240, sim.hullN < 0.5);
      this.pickup = pk && _a.subVectors(pk.pos, sim.pos).normalize().dot(_D) > 0.45 ? pk : null;
    }
    if (this.pickup && this.pickup.alive && (this.leadR > 280 || this.state === 'extend')) {
      _a.subVectors(this.pickup.pos, sim.pos).normalize();
      _D.lerp(_a, 0.5).normalize();
    }
    void fwd;
  }

  // ------------------------------------------------------------------ safety
  /** Soft keep-in: turn back well before the arena edge, never chase past it. */
  _keepIn(sim) {
    const A = sim.course;
    if (!A || !A.center || !A.radius) return;
    _a.subVectors(sim.pos, A.center);
    const r = _a.length();
    if (r < 1) return;
    const n = _a.divideScalar(r);
    _b.copy(sim.pos).addScaledVector(sim.vel, 1.6).sub(A.center);
    const ahead = Math.max(r, _b.length());
    const w = clamp((ahead - A.radius * 0.8) / (A.radius * 0.12), 0, 1);
    if (r > A.radius * 0.96) { _D.copy(n).negate(); this.input.boost = false; return; }
    if (w <= 0) return;
    const out = _D.dot(n);
    const inward = out * (1 - w) - 0.7 * w;
    if (out > inward) _D.addScaledVector(n, inward - out).normalize();
    if (w > 0.6) this.input.boost = false;
  }

  /** Throttled raycasts along the velocity and the wanted heading, plus mines. Returns true if dodging. */
  _avoid(dt, sim, speed) {
    const inp = this.input, cfg = this.cfg;
    this.rayT -= dt;
    if (this.avoidHold > 0) this.avoidHold -= dt;
    if (this.rayT <= 0) {
      this.rayT = cfg.think;
      this.blockItem = null;
      const look = 70 + speed * 1.4;
      const pad = sim.p.radius + 6;
      let found = false;
      // Velocity ray every check; heading ray on alternate checks.
      for (let k = 0; k < 2 && !found; k++) {
        const dir = k === 0 ? _vd : _D;
        if (k === 1 && (this.rayFlip = !this.rayFlip)) break;
        if (k === 1 && dir.dot(_vd) > 0.97) break;
        _c.copy(sim.pos).addScaledVector(dir, k === 0 ? look : look * 0.85);
        const hit = this.world.raycast(sim.pos, _c, pad);
        if (!hit || !hit.col) continue;
        const col = hit.col;
        if (col.item && col.item === this.shootItem && hit.t > 90) { this.blockItem = col.item; continue; }
        // Sideways away from the obstacle's centre, relative to the ray.
        _a.copy(sim.pos).addScaledVector(dir, hit.t).sub(_b.set(col.x, col.y, col.z));
        _a.addScaledVector(dir, -_a.dot(dir));
        if (_a.lengthSq() < 0.25) anyPerp(dir, _a).applyAxisAngle(dir, this.rng() * 6.283);
        this.avoidDir.copy(_a.normalize());
        const u = clamp(1 - hit.t / look, 0, 1);
        this.avoidU = Math.max(k === 0 ? 0.35 + 0.65 * u : 0.25 + 0.5 * u, this.avoidHold > 0 ? this.avoidU * 0.8 : 0);
        this.avoidHold = 0.35;
        this.avoidBig = col.r > 14;
        const it = col.item;
        if (it && it.maxHp != null && it.alive && !it.explosive && it.hp <= 45 && hit.t > 70) this.blockItem = it;
        found = true;
      }
      // Mines: their blast reaches ~32 m, so give them a wide berth.
      const T = 1.6;
      for (const m of this.mines) {
        if (!m.alive) continue;
        _a.subVectors(m.pos, sim.pos);
        const along = clamp(_a.dot(sim.vel) / Math.max(1, speed * speed), 0, T);
        _b.copy(sim.pos).addScaledVector(sim.vel, along).sub(m.pos);
        const miss = _b.length();
        if (miss > 46) continue;
        const dist = _a.length();
        if (_b.lengthSq() < 0.25) anyPerp(_vd, _b);
        _b.addScaledVector(_vd, -_b.dot(_vd));
        if (_b.lengthSq() < 0.25) anyPerp(_vd, _b);
        const u = clamp(1 - miss / 46, 0.3, 1) * clamp(1.4 - along / T, 0.4, 1);
        if (u > this.avoidU || this.avoidHold <= 0) { this.avoidDir.copy(_b.normalize()); this.avoidU = u; this.avoidHold = 0.35; this.avoidBig = false; }
        if (cfg.mineTrap && dist > 110 && dist < 420) this.blockItem = m; // pop it from a safe distance
        break;
      }
      if (!found && this.avoidHold <= 0) this.avoidU = 0;
    }
    if (this.avoidHold <= 0 || this.avoidU <= 0) return false;
    _D.addScaledVector(this.avoidDir, this.avoidU * 3).normalize();
    if (this.avoidU > 0.8 && this.avoidBig && speed > 110) { inp.brake = Math.max(inp.brake, 0.6); inp.boost = false; }
    return true;
  }

  // ------------------------------------------------------------------ controls
  /** Turn the desired world heading _D into stick + roll. */
  _steer(sim, speed, precise) {
    const inp = this.input, cfg = this.cfg;
    _ql.copy(_D);
    if (!precise && speed > 30) {
      // Steer the velocity, not the nose: point past the target by the current slip.
      _ql.multiplyScalar(1.9).addScaledVector(_vd, -0.9);
      if (_ql.lengthSq() < 1e-6) _ql.copy(_D);
      _ql.normalize();
    }
    _inv.copy(sim.quat).invert();
    _ql.applyQuaternion(_inv);
    const lx = _ql.x, ly = _ql.y, lz = _ql.z;
    // Feed-forward: how fast the wanted heading itself is turning, so we track a
    // crossing target without a steady lag (a plain P loop trails it by a fixed angle).
    const dt = this._dt;
    if (this.hasPrevD && dt > 0) {
      const dot = this.prevD.dot(_D);
      if (dot > 0.97) {
        _a.crossVectors(this.prevD, _D).divideScalar(dt);
        this.ffW.lerp(_a, 1 - Math.exp(-dt / 0.08));
      } else this.ffW.set(0, 0, 0); // heading jumped (new state/target): no feed-forward
    }
    this.prevD.copy(_D);
    this.hasPrevD = true;
    _a.copy(this.ffW).applyQuaternion(_inv);
    const tr = Math.max(0.5, sim.p.turnRate);
    const ffx = clamp(_a.x, -tr * 1.2, tr * 1.2), ffy = clamp(_a.y, -tr * 1.2, tr * 1.2);
    const side = Math.hypot(lx, ly);
    if (lz > 0.4 && side < 0.3) {
      // Almost straight behind: keep turning the way we were (no dithering).
      inp.aimX = this.turnX;
      inp.aimY = this.turnY;
    } else {
      const yawErr = Math.atan2(lx, -lz);
      const pitchErr = Math.atan2(ly, Math.hypot(lx, lz) * (lz > 0 ? -1 : 1));
      const gn = cfg.gain;
      const ff = cfg.feedForward;
      inp.aimX = invCurve(clamp(yawErr * gn + (sim.angVel.y - ffy * ff) * 0.25 - ffy * ff / tr, -1, 1));
      inp.aimY = invCurve(clamp(pitchErr * gn - (sim.angVel.x - ffx * ff) * 0.25 + ffx * ff / tr, -1, 1));
      if (side > 0.05) { this.turnX = Math.sign(lx) * (Math.abs(lx) / side > 0.38 ? 1 : 0); this.turnY = Math.sign(ly) * (Math.abs(ly) / side > 0.38 ? 1 : 0); }
      if (lz > 0.2) { inp.aimX = this.turnX || inp.aimX; inp.aimY = this.turnY || inp.aimY; }
    }

    // Roll: bank into big turns (good pilots put the turn on the diagonal, where
    // pitch and yaw add up), level out toward arena "up" when lined up.
    const err = Math.acos(clamp(-lz, -1, 1));
    const bankW = clamp((err - 0.25) / 0.35, 0, 1);
    let roll = 0;
    if (bankW > 0 && side > 0.05) {
      const phi = Math.atan2(lx, ly);
      let goal;
      if (cfg.diag) goal = Math.floor(phi / HALF_PI) * HALF_PI + HALF_PI / 2;
      else goal = Math.abs(phi) < 2 ? 0 : Math.PI;
      roll += clamp(wrap(phi - goal) * 1.8, -1, 1) * bankW;
    }
    if (bankW < 1) {
      _a.copy(WORLD_UP).applyQuaternion(_inv);
      roll += clamp(Math.atan2(_a.x, _a.y) * 1.0, -1, 1) * 0.4 * (1 - bankW);
    }
    inp.roll = clamp(roll + this.rollJink, -1, 1);
  }

  _fireControl(dt, ships, fwd) {
    const me = this.ship, sim = me.sim, cfg = this.cfg, inp = this.input;
    inp.fire = false;
    inp.missile = false;
    // Aim error drifts (whole bursts go a bit wide), plus a little per-shot jitter.
    this.aimErrT -= dt;
    if (this.aimErrT <= 0) {
      this.aimErrT = 0.22 + this.rng() * 0.2;
      const g = (this.rng() + this.rng() + this.rng()) / 1.5 - 1; // ~[-1,1], centre-weighted
      anyPerp(fwd, this.aimErr).applyAxisAngle(fwd, this.rng() * Math.PI * 2).multiplyScalar(cfg.spread * (0.4 + Math.abs(g) * 1.2));
    }
    if (sim.ghost > 0 && cfg.holdGhost) { inp.aimDir.copy(fwd); this.burstOn = false; return; }

    // --- Pick what to shoot: the target if its lead point is in the cone, else
    // any enemy we happen to have a snap shot on.
    let cand = null, R = 0;
    if (this.target && this.leadOk && hostile(this.target, me)) {
      _gun.subVectors(this.lead, sim.pos);
      R = _gun.length();
      _gun.divideScalar(Math.max(R, 1));
      if (R < cfg.range && fwd.dot(_gun) > Math.cos(cfg.fireCone)) cand = this.target;
    }
    if (!cand) {
      let bd = cfg.range * 0.75;
      for (const s of ships) {
        if (!hostile(s, me) || s === this.target) continue;
        _rel.subVectors(s.sim.pos, sim.pos);
        const d = _rel.length();
        if (d > bd || d < 5) continue;
        const t = d / (LASER.speed + Math.max(0, sim.vel.dot(_rel) / d));
        _a.copy(s.sim.pos).addScaledVector(s.sim.vel, t).sub(sim.pos);
        const ad = _a.length();
        if (fwd.dot(_a) / ad < Math.cos(cfg.fireCone * 0.8)) continue;
        bd = d; cand = s; R = ad; _gun.copy(_a).divideScalar(ad);
      }
    }

    // Mine trap: a mine next to our target, far from us - pop it.
    if (cand && cfg.mineTrap) {
      for (const m of this.mines) {
        if (!m.alive || m.pos.distanceTo(cand.sim.pos) > 24) continue;
        _a.subVectors(m.pos, sim.pos);
        const md = _a.length();
        if (md < 110 || md > cfg.range) continue;
        if (fwd.dot(_a) / md < Math.cos(cfg.fireCone)) continue;
        _gun.copy(_a).divideScalar(md);
        R = md;
        cand = null;
        this._pullTrigger(dt, _gun, 'item');
        return;
      }
    }

    if (cand) {
      // Line of sight (cached briefly): don't waste heat on rocks, never shoot a
      // mine that's close to us.
      this.losT -= dt;
      if (this.losId !== cand.id || this.losT <= 0) {
        this.losId = cand.id;
        this.losT = 0.15;
        const hit = this.world.raycast(sim.pos, cand.sim.pos, 0.4);
        this.losOk = true;
        if (hit && hit.t < cand.sim.pos.distanceTo(sim.pos) - 4) {
          const it = hit.item;
          if (!it || it.maxHp == null) this.losOk = false;
          else if (it.explosive) this.losOk = hit.t > 110 && it.pos.distanceTo(cand.sim.pos) < 30;
          else this.losOk = it.hp <= 21;
        }
      }
      if (this.losOk) {
        this._pullTrigger(dt, _gun, 'ship');
        if (cand === this.target && inp.fire) this.dry = 0;
      } else { inp.aimDir.copy(_gun); this.burstOn = false; }
    } else {
      // Nothing to shoot: clear a breakable in the way, or one holding a drop.
      const it = this.blockItem && this.blockItem.alive ? this.blockItem : this.shootItem && this.shootItem.alive ? this.shootItem : null;
      let shot = false;
      if (it) {
        _a.subVectors(it.pos, sim.pos);
        const d = _a.length();
        const minD = it.explosive ? 110 : 45;
        if (d > minD && d < 480 && fwd.dot(_a) / d > Math.cos(0.45)) {
          _gun.copy(_a).divideScalar(d);
          this._pullTrigger(dt, _gun, 'item');
          shot = true;
        }
      }
      if (!shot) {
        inp.aimDir.copy(fwd);
        this.burstOn = false;
        this.burstT = Math.min(this.burstT, cfg.react * 0.5);
      }
    }

    // --- Missiles: locked, sensible range, none already chasing that ship.
    const lock = sim.lock;
    if (lock && lock.t >= 1 && lock.id != null && sim.missiles > 0 && sim.missileCd <= 0) {
      const t = this._byId(ships, lock.id);
      if (t && hostile(t, me)) {
        const d = t.sim.pos.distanceTo(sim.pos);
        let inFlight = false;
        if (this.weapons) for (const m of this.weapons.missiles) if (m.alive && m.owner === me.id && m.target === lock.id) { inFlight = true; break; }
        const keen = (t.sim.hull + t.sim.shield) < 80 ? 2.5 : 1;
        if (!inFlight && d > cfg.missileMin && d < cfg.missileRange && (t.id !== this.losId || this.losOk) && this.rng() < cfg.missile * keen * dt) inp.missile = true;
      }
    }
  }

  /** Burst-fire along `dir` (world unit), with aim error and heat discipline. */
  _pullTrigger(dt, dir, kind) {
    const sim = this.ship.sim, cfg = this.cfg, inp = this.input;
    inp.aimDir.copy(dir).add(this.aimErr);
    inp.aimDir.x += (this.rng() - 0.5) * cfg.jitter * 2;
    inp.aimDir.y += (this.rng() - 0.5) * cfg.jitter * 2;
    inp.aimDir.z += (this.rng() - 0.5) * cfg.jitter * 2;
    inp.aimDir.normalize();
    this.burstT -= dt;
    if (this.burstT <= 0) {
      this.burstOn = !this.burstOn;
      const r = this.burstOn ? cfg.burstOn : cfg.burstOff;
      this.burstT = r[0] + this.rng() * (r[1] - r[0]);
      if (!this.burstOn && sim.heat > 0.6) this.burstT += 0.3; // let the guns cool
    }
    const cool = sim.heat + LASER.heat < cfg.heatCap && !sim.overheated;
    inp.fire = this.burstOn && cool;
    if (inp.fire && sim.fireCd <= 0) this.firedAt = kind;
  }
}
