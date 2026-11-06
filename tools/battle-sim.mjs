// Headless battle (arena deathmatch): 6 BattleAI bots per arena, weapons, damage,
// missile splash, mine blasts and pickups live, mirroring FlightRace._step /
// _weaponEvents / _worldEvents / applyPickup. Reports per bot: kills, deaths,
// crashes (deaths with no killer), shots, hit %, missiles fired/hit, pickups,
// time outside the arena, plus engagement quality: maxDry (longest stretch alive
// without a shot at a ship), closeDry (longest stretch with our target inside
// 500 m, not sat on our own tail, and no shot - i.e. stuck circling), fight%
// (alive time within 3 s of a shot), time per AI state, missiles dodged, and
// damaging obstacle hits / self-triggered mine blasts.
//
// Run: node tools/battle-sim.mjs [easy|normal|hard|mixed] [seconds] [arenaId] [seed]
import * as THREE from 'three';
import { ARENAS } from '../js/flight/arenaDefs.js';
import { Arena } from '../js/flight/arena.js';
import { SpaceWorld } from '../js/flight/world.js';
import { ShipSim } from '../js/flight/ship.js';
import { BattleAI } from '../js/flight/battleAI.js';
import { WeaponSystem, MISSILE, LASER, clampCone } from '../js/flight/weapons.js';
import { PRESETS, computeStats } from '../js/craft/parts.js';

const skillArg = process.argv[2] || 'normal';
const SECONDS = Number(process.argv[3] || 180);
const only = process.argv[4];
const seed0 = Number(process.argv[5] || 1);
const DT = 1 / 120, N = 6;
const LASER_DAMAGE = LASER.damage;
// Mixed lineup: hard and easy each get one agile and one mid craft (Wasp+Comet vs Skiff+Comet).
const MIXED = ['easy', 'hard', 'normal', 'normal', 'easy', 'hard'];

const _x = new THREE.Vector3(), _w = new THREE.Vector3(), _v = new THREE.Vector3();

// Same as flightRace.applyPickup (kept local: flightRace pulls in rendering code).
function applyPickup(sim, kind) {
  if (kind === 'boost') sim.boost = Math.min(1, sim.boost + 0.4);
  else if (kind === 'missile') sim.missiles = Math.min(4, sim.missiles + 1);
  else if (kind === 'shield') { sim.shield = sim.p.shield; sim.hull = Math.min(sim.p.hull, sim.hull + sim.p.hull * 0.3); }
}

let failures = 0;
const summary = [];
for (const def of ARENAS) {
  if (only && def.id !== only) continue;
  const arena = new Arena(def);
  const world = new SpaceWorld(arena);
  const weapons = new WeaponSystem(world);
  const ships = [];
  for (let i = 0; i < N; i++) {
    const d = PRESETS[i % PRESETS.length];
    const skill = skillArg === 'mixed' ? MIXED[i] : skillArg;
    const sim = new ShipSim(arena, computeStats(d).physics, arena.gridSlot(i), 'bot' + i);
    const e = {
      id: 'bot' + i, name: `${d.name}-${skill[0].toUpperCase()}${i}`, skill, sim, connected: true, local: true, kind: 'ai',
      color: new THREE.Color('#ffffff'),
      st: { kills: 0, deaths: 0, crashes: 0, shots: 0, itemShots: 0, hits: 0, mFired: 0, mHit: 0, pickups: 0, outside: 0, alive: 0, sinceShot: 0, maxDry: 0, fight: 0, closeDry: 0, maxCloseDry: 0, stuck: 0, dryTgt: null, lastKind: null, causes: {}, states: {} },
    };
    sim.spawnPicker = () => arena.pickSpawn(ships.filter((o) => o !== e && !o.sim.dead).map((o) => o.sim.pos));
    e.ai = new BattleAI(e, world, { skill, seed: seed0 * 101 + i * 7 + 3, weapons });
    ships.push(e);
  }
  const byId = new Map(ships.map((s) => [s.id, s]));
  const proxies = ships.map((s) => ({ id: s.id, pos: s.sim.pos, dead: false, radius: s.sim.p.radius, local: true }));
  const missileHit = new Set();
  let t = 0, thinkMs = 0, thinks = 0;

  while (t < SECONDS) {
    // --- FlightRace._step
    for (const e of ships) {
      const t0 = performance.now();
      e.input = e.ai.think(DT, ships, { weapons });
      thinkMs += performance.now() - t0; thinks++;
      e.sim.step(DT, e.input, { world, racing: true, raceTime: t });
      if (e.sim.dead) continue;
      const aimDir = _x.set(0, 0, -1).applyQuaternion(e.sim.quat);
      weapons.updateLock(e, aimDir, ships, DT);
      if (e.input.fire) {
        const dir = _w.copy(e.input.aimDir || aimDir);
        clampCone(dir.normalize(), _v.set(0, 0, -1).applyQuaternion(e.sim.quat), 0.5);
        if (weapons.tryFireLaser(e, dir, e.color, true)) {
          if (e.ai.firedAt === 'item') e.st.itemShots++;
          else { e.st.shots++; e.st.sinceShot = 0; e.st.closeDry = 0; }
        }
      }
      if (e.input.missile) {
        if (weapons.tryFireMissile(e, e.sim.lock.t >= 1 ? e.sim.lock.id : null, true)) e.st.mFired++;
      }
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

    // --- FlightRace._processEvents (kills) + stats
    for (const e of ships) {
      const st = e.st;
      for (const ev of e.sim.events) {
        if (ev.type === 'damaged') {
          st.lastKind = ev.kind + (ev.by === e.id ? '(self)' : '');
          if (ev.kind === 'collision') st.bumps = (st.bumps || 0) + 1;
          if (ev.kind === 'blast' && ev.by === e.id) st.selfBlast = (st.selfBlast || 0) + 1;
        }
        if (ev.type === 'destroyed') {
          st.deaths++;
          const killer = ev.by != null && ev.by !== e.id ? byId.get(ev.by) : null;
          if (killer) killer.st.kills++;
          else { st.crashes++; st.causes[st.lastKind] = (st.causes[st.lastKind] || 0) + 1; }
          st.sinceShot = 0;
        }
      }
      e.sim.events.length = 0;
      if (!e.sim.dead) {
        st.alive += DT;
        st.sinceShot += DT;
        if (st.sinceShot > st.maxDry) st.maxDry = st.sinceShot;
        if (st.sinceShot < 3) st.fight += DT;
        // Circling check: our target within 500 m, not sat on our own tail (being
        // hunted is a different problem), and no shot at a ship for a long time.
        const tg = e.ai.target;
        const hunted = tg && _v.subVectors(e.sim.pos, tg.sim.pos).normalize().dot(_w.set(0, 0, -1).applyQuaternion(tg.sim.quat)) > 0.8;
        if (tg && !tg.sim.dead && !hunted && tg.sim.pos.distanceTo(e.sim.pos) < 500 && tg === st.dryTgt) {
          st.closeDry += DT;
          if (st.closeDry > st.maxCloseDry) st.maxCloseDry = st.closeDry;
          if (st.closeDry >= 10 && st.closeDry - DT < 10) st.stuck++;
        } else { st.closeDry = 0; st.dryTgt = tg; }
        st.states[e.ai.state] = (st.states[e.ai.state] || 0) + DT;
        if (e.sim.pos.distanceTo(arena.center) > arena.radius) st.outside += DT;
      }
    }
    t += DT;
  }

  // --- Report
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) : '-').padStart(3) + '%';
  console.log(`\n${def.name} [${def.id}] — ${skillArg}, ${SECONDS}s, ${N} bots, seed ${seed0}`);
  console.log('  bot          K   D  crash  shots  hit%  msl f/h  pick  outside  maxDry closeDry fight%  states (pursue/defend/evade/extend/retreat/forage/patrol %)');
  let K = 0, D = 0, C = 0, out = 0, dryMax = 0, closeMax = 0, stuck = 0, bumps = 0, selfBlast = 0;
  const bySkill = {};
  const causes = {};
  for (const e of ships) {
    const s = e.st;
    K += s.kills; D += s.deaths; C += s.crashes; out += s.outside; dryMax = Math.max(dryMax, s.maxDry); closeMax = Math.max(closeMax, s.maxCloseDry); stuck += s.stuck; bumps += s.bumps || 0; selfBlast += s.selfBlast || 0;
    for (const [k, v] of Object.entries(s.causes)) causes[k] = (causes[k] || 0) + v;
    const g = (bySkill[e.skill] ||= { k: 0, d: 0, n: 0, shots: 0, hits: 0, mIn: 0, mDodged: 0 });
    g.k += s.kills; g.d += s.deaths; g.n++; g.shots += s.shots; g.hits += s.hits; g.mIn += s.mIn || 0; g.mDodged += s.mDodged || 0;
    const sp = (k) => pct(s.states[k] || 0, s.alive).trim();
    console.log(`  ${e.name.padEnd(10)} ${String(s.kills).padStart(3)} ${String(s.deaths).padStart(3)} ${String(s.crashes).padStart(5)}  ${String(s.shots).padStart(5)}  ${pct(s.hits, s.shots)}  ${String(s.mFired).padStart(3)}/${String(s.mHit).padEnd(3)} ${String(s.pickups).padStart(5)}  ${s.outside.toFixed(1).padStart(6)}s  ${s.maxDry.toFixed(1).padStart(5)}s  ${s.maxCloseDry.toFixed(1).padStart(5)}s ${pct(s.fight, s.alive)}   ${['pursue', 'defend', 'evade', 'extend', 'retreat', 'forage', 'patrol'].map(sp).join('/')}`);
  }
  const skills = Object.entries(bySkill).map(([k, g]) => `${k}: ${g.k}K/${g.d}D (hit ${pct(g.hits, g.shots).trim()}, dodged ${g.mDodged}/${g.mIn} missiles)`).join('  ');
  console.log(`  TOTAL kills ${K}, deaths ${D}, crashes ${C} (${pct(C, D).trim()} of deaths${C ? ': ' + Object.entries(causes).map(([k, v]) => `${k} ${v}`).join(', ') : ''}), outside ${out.toFixed(1)}s, longest dry spell ${dryMax.toFixed(1)}s, longest close-range no-shot spell (not hunted) ${closeMax.toFixed(1)}s (${stuck} spells >10s)`);
  console.log(`  by skill  ${skills}`);
  console.log(`  damaging obstacle hits ${bumps}, mine blasts set off on themselves ${selfBlast}`);
  console.log(`  think() ${(thinkMs / thinks * 1000).toFixed(1)} µs avg per bot per step`);
  summary.push({ arena: def.id, K, D, C, out });
  if (skillArg === 'normal' && SECONDS >= 150 && (K < 20 || C > D * 0.2 || out > 10)) failures++;
}
process.exit(failures ? 1 : 0);
