// "Rough human" vs bots: how much do the player assists help a beginner?
// The human model steers its cursor at the nearest rival with a reaction delay and a
// wobbly hand (no lead), holds fire when the rival is roughly ahead, and fires a
// missile when locked. It uses the game's own assist code (js/flight/assist.js).
// Runs each arena with assists off and on, over several seeds, against bots.
//
// Run: node tools/player-sim.mjs [botSkill=easy] [seconds=150] [seeds=3] [bots=3]
import * as THREE from 'three';
import { ARENAS } from '../js/flight/arenaDefs.js';
import { Arena } from '../js/flight/arena.js';
import { SpaceWorld } from '../js/flight/world.js';
import { ShipSim } from '../js/flight/ship.js';
import { BattleAI } from '../js/flight/battleAI.js';
import { WeaponSystem, MISSILE, LASER, clampCone } from '../js/flight/weapons.js';
import { PlayerAssist, leadPoint } from '../js/flight/assist.js';
import { PRESETS, computeStats } from '../js/craft/parts.js';
import { mulberry32 } from '../js/core/util.js';

const botSkill = process.argv[2] || 'easy';
const SECONDS = Number(process.argv[3] || 150);
const SEEDS = Number(process.argv[4] || 3);
const NB = Number(process.argv[5] || 3);
const DT = 1 / 120;
const LASER_DAMAGE = LASER.damage;
const TAN = Math.tan(27 * Math.PI / 180); // full stick ~ 27 degrees off the camera axis
const _x = new THREE.Vector3(), _w = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _r = new THREE.Vector3();

function applyPickup(sim, kind) {
  if (kind === 'boost') sim.boost = Math.min(1, sim.boost + 0.4);
  else if (kind === 'missile') sim.missiles = Math.min(4, sim.missiles + 1);
  else if (kind === 'shield') { sim.shield = sim.p.shield; sim.hull = Math.min(sim.p.hull, sim.hull + sim.p.hull * 0.3); }
}

/** A beginner's hands: cursor on the nearest rival, late and wobbly. */
class Human {
  constructor(e, rng) { this.e = e; this.rng = rng; this.seen = new THREE.Vector3(); this.react = 0; this.wob = new THREE.Vector2(); this.input = { throttle: 1, brake: 0, boost: false, roll: 0, aimX: 0, aimY: 0, fire: false, missile: false, aimDir: new THREE.Vector3() }; this.tgt = null; }
  think(dt, ships) {
    const sim = this.e.sim, inp = this.input;
    this.react -= dt;
    if (this.react <= 0) {
      this.react = 0.22 + this.rng() * 0.1;
      let best = null, bd = Infinity;
      for (const s of ships) { if (s === this.e || s.sim.dead) continue; const d = s.sim.pos.distanceTo(sim.pos); if (d < bd) { bd = d; best = s; } }
      this.tgt = best;
      if (best) this.seen.copy(best.sim.pos);
      this.wob.x += (this.rng() - 0.5) * 0.12; this.wob.y += (this.rng() - 0.5) * 0.12; this.wob.multiplyScalar(0.85);
    }
    inp.fire = false; inp.missile = false;
    if (!this.tgt) { inp.aimX = inp.aimY = 0; return inp; }
    _q.copy(sim.quat).invert();
    _v.subVectors(this.seen, sim.pos).normalize().applyQuaternion(_q);
    let ax, ay;
    if (_v.z < -0.2) { ax = (_v.x / -_v.z) / TAN; ay = (_v.y / -_v.z) / TAN; }
    else { const m = Math.hypot(_v.x, _v.y) || 1; ax = _v.x / m; ay = _v.y / m; }
    ax += this.wob.x; ay += this.wob.y;
    const m = Math.hypot(ax, ay); if (m > 1) { ax /= m; ay /= m; }
    inp.aimX = ax; inp.aimY = ay;
    const dist = this.seen.distanceTo(sim.pos);
    inp.fire = dist < 700 && m < 0.9;
    return inp;
  }
}

const results = [];
for (const mode of ['off', 'on']) {
  let K = 0, D = 0, shots = 0, hits = 0, mf = 0, mh = 0;
  for (const def of ARENAS) for (let seed = 1; seed <= SEEDS; seed++) {
    const arena = new Arena(def);
    const world = new SpaceWorld(arena);
    const weapons = new WeaponSystem(world);
    const ships = [];
    const N = NB + 1;
    for (let i = 0; i < N; i++) {
      const d = PRESETS[i % PRESETS.length];
      const sim = new ShipSim(arena, computeStats(d).physics, arena.gridSlot(i), 'p' + i);
      const e = { id: 'p' + i, name: i ? 'bot' + i : 'human', sim, connected: true, local: true, kind: i ? 'ai' : 'player', color: new THREE.Color('#fff'), st: { kills: 0, deaths: 0, shots: 0, hits: 0, mFired: 0, mHit: 0 } };
      sim.spawnPicker = () => arena.pickSpawn(ships.filter((o) => o !== e && !o.sim.dead).map((o) => o.sim.pos));
      if (i) e.ai = new BattleAI(e, world, { skill: botSkill, seed: seed * 101 + i * 7, weapons });
      ships.push(e);
    }
    const human = ships[0];
    const hands = new Human(human, mulberry32(seed * 977));
    const pa = new PlayerAssist();
    pa.aim = mode === 'on' ? 1 : 0; pa.flight = mode === 'on' ? 0.7 : 0;
    human.sim.levelAssist = pa.flight;
    const byId = new Map(ships.map((s) => [s.id, s]));
    const proxies = ships.map((s) => ({ id: s.id, pos: s.sim.pos, dead: false, radius: s.sim.p.radius, local: true }));
    const missileHit = new Set();
    let t = 0;
    while (t < SECONDS) {
      for (const e of ships) {
        const isH = e === human;
        let inp;
        if (isH) {
          const raw = hands.think(DT, ships);
          // Aim ray: from the ship through the cursor (the camera sits close behind).
          _r.set(raw.aimX * TAN, raw.aimY * TAN, -1).normalize().applyQuaternion(e.sim.quat);
          const tgt = pa.softTarget(e.sim.pos, _r, e, ships);
          if (tgt) leadPoint(e.sim.pos, e.sim.vel, tgt.sim.pos, tgt.sim.vel, LASER.speed, raw.aimDir).sub(e.sim.pos).normalize();
          else raw.aimDir.copy(_r);
          inp = pa.nudge(e.sim, Object.assign(hands.copy || (hands.copy = {}), raw), world, { dt: DT, battle: true, laserSpeed: LASER.speed });
        } else inp = e.ai.think(DT, ships, { weapons });
        e.input = inp;
        e.sim.step(DT, inp, { world, racing: true, raceTime: t });
        if (e.sim.dead) continue;
        const aimDir = isH ? inp.aimDir : _x.set(0, 0, -1).applyQuaternion(e.sim.quat);
        weapons.updateLock(e, aimDir, ships, DT, isH ? pa.lockCone() : 1);
        if (isH && e.sim.lock.t >= 1) inp.missile = true;
        if (inp.fire) {
          const dir = _w.copy(inp.aimDir || aimDir).normalize();
          const nose = _v.set(0, 0, -1).applyQuaternion(e.sim.quat);
          const arc = isH ? pa.gunArc() : 0.5;
          const outOfArc = isH && pa.aim > 0 && pa.target && dir.angleTo(nose) > arc;
          clampCone(dir, nose, arc);
          if (!outOfArc && weapons.tryFireLaser(e, dir, e.color, true)) e.st.shots++;
        }
        if (inp.missile && weapons.tryFireMissile(e, e.sim.lock.t >= 1 ? e.sim.lock.id : null, true)) e.st.mFired++;
      }
    // FlightRace._collideShips (everyone local)
    for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i], b = ships[j];
      if (a.sim.dead || b.sim.dead || a.sim.ghost > 0 || b.sim.ghost > 0) continue;
      _v.subVectors(b.sim.pos, a.sim.pos);
      const d = _v.length(), min = (a.sim.p.radius + b.sim.p.radius) * 0.9;
      if (d >= min || d < 1e-4) continue;
      _v.divideScalar(d);
      const pen = min - d, ma = 0.6 + a.sim.p.armor, mb = 0.6 + b.sim.p.armor;
      const sa = mb / (ma + mb), sb = ma / (ma + mb);
      const rel = _w.subVectors(b.sim.vel, a.sim.vel).dot(_v);
      a.sim.pos.addScaledVector(_v, -pen * sa); if (rel < 0) a.sim.vel.addScaledVector(_v, rel * sa);
      b.sim.pos.addScaledVector(_v, pen * sb); if (rel < 0) b.sim.vel.addScaledVector(_v, -rel * sb);
    }
    weapons.update(DT, ships);
    for (let i = 0; i < ships.length; i++) proxies[i].dead = ships[i].sim.dead;
    world.update(DT, proxies);

    // --- FlightRace._weaponEvents
    for (const ev of weapons.events) {
      if (ev.type === 'laserHit' && ev.local) {
        const tgt = byId.get(ev.target), own = byId.get(ev.owner);
        if (!tgt) continue;
        if (own && !tgt.sim.dead && !(tgt.sim.ghost > 0)) own.st.hits++;
        tgt.sim.damage(LASER_DAMAGE, 'laser', ev.owner);
      } else if (ev.type === 'laserWorld' && ev.local && ev.item && ev.item.maxHp != null) {
        world.hitBreakable(ev.item.id, LASER_DAMAGE, ev.owner);
      } else if (ev.type === 'missileSpawn') {
        const tg = byId.get(ev.missile.target);
        if (tg) tg.st.mIn = (tg.st.mIn || 0) + 1;
      } else if (ev.type === 'missileBoom' && ev.local) {
        let hitSomeone = false;
        const tg = ev.missile && byId.get(ev.missile.target);
        if (tg && !tg.sim.dead && tg.sim.pos.distanceTo(ev.pos) > MISSILE.splash) tg.st.mDodged = (tg.st.mDodged || 0) + 1;
        for (const s of ships) {
          if (s.id === ev.owner || s.sim.dead || !s.connected) continue;
          const d = s.sim.pos.distanceTo(ev.pos);
          if (d > MISSILE.splash) continue;
          const dmg = MISSILE.damage * (s.id === ev.direct ? 1 : 1 - (d / MISSILE.splash) * 0.6);
          if (!(s.sim.ghost > 0)) hitSomeone = true;
          s.sim.damage(dmg, 'missile', ev.owner);
          s.sim.stun = Math.max(s.sim.stun, 0.8);
        }
        if (hitSomeone && ev.missile && !missileHit.has(ev.missile.id)) { missileHit.add(ev.missile.id); const o = byId.get(ev.owner); if (o) o.st.mHit++; }
        world.forEachNear(ev.pos, MISSILE.splash, (c) => { if (c.ref && !c.dead) world.hitBreakable(c.ref.id, 70, ev.owner); });
      }
    }
    weapons.events.length = 0;

    // --- FlightRace._worldEvents
    for (const ev of world.events) {
      if (ev.type === 'blast') {
        for (const s of ships) {
          if (s.sim.dead) continue;
          const d = s.sim.pos.distanceTo(ev.pos);
          if (d < ev.radius) { s.sim.damage(ev.damage * (1 - (d / ev.radius) * 0.5), 'blast', ev.by); s.sim.stun = Math.max(s.sim.stun, 0.6); }
        }
      } else if (ev.type === 'pickupTaken') {
        const e = byId.get(ev.by);
        if (e) { applyPickup(e.sim, ev.pickup.kind); e.st.pickups++; }
      }
    }
    world.events.length = 0;

      for (const e of ships) {
        for (const ev of e.sim.events) {
          if (ev.type === 'destroyed') {
            e.st.deaths++;
            const k = byId.get(ev.by);
            if (k && k !== e) k.st.kills++;
          }
        }
        e.sim.events.length = 0;
      }
      t += DT;
    }
    const st = human.st;
    K += st.kills; D += st.deaths; shots += st.shots; hits += st.hits; mf += st.mFired; mh += st.mHit;
  }
  const n = ARENAS.length * SEEDS;
  results.push({ mode, K, D, n, hit: shots ? hits / shots : 0, mf, mh });
  console.log(`assists ${mode.padEnd(3)}: ${(K / n).toFixed(1)} kills / ${(D / n).toFixed(1)} deaths per ${SECONDS}s match vs ${NB} ${botSkill} bots  |  laser hit ${(100 * hits / Math.max(1, shots)).toFixed(0)}% (${shots} shots)  |  missiles ${mh}/${mf}`);
}
