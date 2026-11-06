// Headless hazards check: plasmoids + the Vesk swarm, with the real AI pilots.
//
// Races (FlightAI, every preset, every course) and battles (BattleAI, 6 bots, every
// arena) are run with hazards off and at several intensities. Mirrors
// tools/flight-sim.mjs / tools/battle-sim.mjs, plus the hazard wiring a match needs:
//   - AI pilots get hazards.aiWorld(world) (their raycasts also see plasmoids) and
//     ships + hazards.targets (so they shoot at drones);
//   - lasers and missiles are tested against drones/plasmoids with hazards.hitTest()
//     before weapons.update() (the hit kills the bolt / detonates the missile);
//   - hazard events: damage/knock applied to ships, droneFire -> spawnBolt,
//     droneDown -> spawnHazardDrop (pickups), missile splash -> hazards.splash().
// Reports race times vs. baseline, DNFs, deaths caused by hazards per minute, drones
// killed, plasmoid pops; checks no drone gets stuck or leaves the tube/arena, runs
// a determinism check (same seed twice) and a host -> client replication check.
//
// Run: node tools/hazard-sim.mjs [intensities=0.3,0.6,1] [battleSeconds=180] [laps=2] [only]
import * as THREE from 'three';
import { COURSES } from '../js/flight/courseDefs.js';
import { ARENAS } from '../js/flight/arenaDefs.js';
import { Course } from '../js/flight/course.js';
import { Arena } from '../js/flight/arena.js';
import { SpaceWorld } from '../js/flight/world.js';
import { ShipSim } from '../js/flight/ship.js';
import { FlightAI } from '../js/flight/ai.js';
import { BattleAI } from '../js/flight/battleAI.js';
import { WeaponSystem, MISSILE, LASER, clampCone } from '../js/flight/weapons.js';
import { PRESETS, computeStats } from '../js/craft/parts.js';
import { Hazards, spawnHazardDrop } from '../js/flight/hazards.js';

const INTENS = (process.argv[2] || '0.3,0.6,1').split(',').map(Number);
const BATTLE_S = Number(process.argv[3] || 180);
const LAPS = Number(process.argv[4] || 2);
const only = process.argv[5] || null;
const DT = 1 / 120, LASER_DAMAGE = LASER.damage, RACE_LIMIT = 400;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _x = new THREE.Vector3(), _end = new THREE.Vector3();
const HAZ_KINDS = new Set(['plasmoid', 'alien']);

function applyPickup(sim, kind) {
  if (kind === 'boost') sim.boost = Math.min(1, sim.boost + 0.4);
  else if (kind === 'missile') sim.missiles = Math.min(4, sim.missiles + 1);
  else if (kind === 'shield') { sim.shield = sim.p.shield; sim.hull = Math.min(sim.p.hull, sim.hull + sim.p.hull * 0.3); }
}

/** Shared per-step hazard wiring (the part flightRace needs). */
function hazardStep(hz, world, weapons, ships, byId, t, st) {
  // Player weapons vs. drones / plasmoids, before the weapons move this step.
  for (const b of weapons.lasers) {
    if (!b.alive) continue;
    _end.copy(b.pos).addScaledVector(b.vel, DT);
    const h = hz.hitTest(b.pos, _end, 0.3);
    if (!h) continue;
    const w = world.raycast(b.pos, _end, 0.3);
    if (w && w.t < h.t) continue;
    b.alive = false;
    if (h.kind === 'drone') { st.droneHits++; hz.damageDrone(h.id, LASER_DAMAGE, b.owner); }
    else hz.hitPlasmoid(h.id, LASER_DAMAGE, b.owner);
  }
  for (const m of weapons.missiles) {
    if (!m.alive) continue;
    _end.copy(m.pos).addScaledVector(m.vel, DT);
    const h = hz.hitTest(m.pos, _end, 2.5);
    if (h) weapons.detonate(m.id, h.point);
  }
  return { after() {
    hz.update(DT, ships, t);
    for (const ev of hz.events) {
      switch (ev.type) {
        case 'damage': {
          const s = byId.get(ev.shipId);
          if (!s || !s.local) break;
          s.sim.damage(ev.amount, ev.kind, ev.byId);
          if (ev.stun) s.sim.stun = Math.max(s.sim.stun, ev.stun);
          st.dmg[ev.kind] = (st.dmg[ev.kind] || 0) + ev.amount;
          break;
        }
        case 'knock': { const s = byId.get(ev.shipId); if (s && s.local && !s.sim.dead) s.sim.vel.add(ev.impulse); break; }
        case 'droneFire': hz.spawnBolt(ev); if (st.net) st.net.push(Hazards.packEvent(ev)); break;
        case 'droneDown': if (spawnHazardDrop(world, ev)) st.drops++; if (ev.byId) st.kills++; if (st.net) st.net.push(Hazards.packEvent(ev)); break;
        case 'droneGone': if (st.net) st.net.push(Hazards.packEvent(ev)); break;
        case 'plasmoidPop': if (st.net && ev.net) st.net.push(Hazards.packEvent(ev)); break;
        case 'ambush': st.ambush++; break;
        case 'wave': st.waves++; break;
        default:
      }
    }
    hz.events.length = 0;
    // Watchdogs: drones inside the tube/arena and never stuck.
    for (const d of hz.drones) {
      if (!d.alive) continue;
      if (!Number.isFinite(d.pos.x + d.pos.y + d.pos.z)) st.nan++;
      if ((d.stuckT > 3 || (d.unsticks || 0) >= 4) && !st.stuck.has(d.id)) { st.stuck.add(d.id); st.stuckWhy.push(`#${d.id} ${d.type} ${d.state} t${d.stateT.toFixed(1)} v${d.vel.length().toFixed(1)} maxV${(d.maxV || 0).toFixed(0)}`); 
        if (process.env.HZ_DEBUG) {
          const tg = byId.get(d.target);
          let nc = null, ncd = Infinity; world.forEachNear(d.pos, 60, (c) => { const dd = Math.hypot(c.x - d.pos.x, c.y - d.pos.y, c.z - d.pos.z) - c.r; if (dd < ncd) { ncd = dd; nc = c; } });
          console.log('STUCK', d.id, 't', t.toFixed(1), 'pos', d.pos.toArray().map((x) => x.toFixed(0)).join(','), 'tgt', tg ? tg.sim.pos.distanceTo(d.pos).toFixed(0) + 'm v' + tg.sim.vel.length().toFixed(0) + (tg.sim.dead ? ' dead' : '') : 'none', 'collider', nc ? ncd.toFixed(1) + 'm r' + nc.r.toFixed(0) + ' ' + (nc.item?.type || '') : 'none', 'avoidT', d.avoidT.toFixed(2), 'slot', d.slotAlong.toFixed(0), d.slotAngle.toFixed(1));
        }
      }
      if (hz.battle) {
        const over = d.pos.distanceTo(hz.course.center) - hz.course.radius * (d.state === 'leave' ? 1.1 : 1.0);
        if (over > st.maxOut) st.maxOut = over;
      } else {
        const c = hz.course;
        const loc = c.locate(d.pos, d.i, st.loc);
        _v.subVectors(d.pos, loc.c); _v.addScaledVector(loc.t, -_v.dot(loc.t));
        const over = _v.length() + d.radius - c.tunnelRadiusAt(loc.u);
        if (over > st.maxOut) st.maxOut = over;
      }
    }
    for (const p of hz.plasmoids) {
      if (hz.battle) { const over = p.pos.distanceTo(hz.course.center) + p.r - hz.course.radius; if (over > st.pMaxOut) st.pMaxOut = over; }
      else {
        const c = hz.course;
        const loc = c.locate(p.pos, Math.round((p.u ?? 0) * c.sampleCount), st.loc);
        _v.subVectors(p.pos, loc.c); _v.addScaledVector(loc.t, -_v.dot(loc.t));
        const over = _v.length() + p.r - c.tunnelRadiusAt(loc.u);
        if (over > st.pMaxOut) st.pMaxOut = over;
      }
    }
  } };
}

function newStats() {
  return { dmg: {}, drops: 0, kills: 0, droneHits: 0, ambush: 0, waves: 0, stuck: new Set(), stuckWhy: [], maxOut: -Infinity, pMaxOut: -Infinity, nan: 0, loc: { i: 0, u: 0, c: new THREE.Vector3(), t: new THREE.Vector3() }, net: null };
}

// ------------------------------------------------------------------------------ race
function runRace(def, intensity, seed = 1, replicate = false) {
  const course = new Course(def);
  const world = new SpaceWorld(course);
  const weapons = new WeaponSystem(world);
  const hz = intensity == null ? null : new Hazards(course, world, { seed, game: 'race', intensity, authority: true });
  const aiWorld = hz ? hz.aiWorld(world) : world;
  const ships = PRESETS.map((d, i) => {
    const sim = new ShipSim(course, computeStats(d).physics, course.gridSlot(i), d.id);
    const s = { id: d.id, name: d.name, sim, connected: true, local: true, deaths: 0, hzDeaths: 0, lastKind: null, finishTime: null };
    s.ai = new FlightAI(s, aiWorld, { skill: 'normal', seed: i + 3 + seed * 31 });
    return s;
  });
  const byId = new Map(ships.map((s) => [s.id, s]));
  const st = newStats();
  // Replication: a non-authority client fed snapshots (10 Hz, 60 ms latency) and events.
  let client = null, clock = 0, inbox = [], repErr = { sum: 0, n: 0, max: 0 }, plErr = 0;
  if (hz && replicate) {
    client = new Hazards(new Course(def), new SpaceWorld(new Course(def)), { seed, game: 'race', intensity, authority: false, clock: () => clock });
    st.net = [];
  }
  const aiShips = [];
  const color = new THREE.Color('#ffffff');
  let t = 0, snapT = 0;
  while (t < RACE_LIMIT && ships.some((s) => !s.sim.finished)) {
    const lead = Math.max(...ships.map((s) => s.sim.progress()));
    aiShips.length = 0;
    for (const s of ships) aiShips.push(s);
    if (hz) for (const p of hz.targets) aiShips.push(p);
    for (const s of ships) {
      const inp = s.ai.think(DT, aiShips, lead);
      weapons.updateLock(s, s.sim.forward.clone(), ships, DT);
      s.sim.step(DT, inp, { world, racing: true, raceTime: t });
      if (!s.sim.dead && !s.sim.finished) {
        if (inp.fire) weapons.tryFireLaser(s, inp.aimDir, color, true);
        if (inp.missile) weapons.tryFireMissile(s, s.sim.lock.id, true);
      }
    }
    const hstep = hz ? hazardStep(hz, world, weapons, ships, byId, t, st) : null;
    weapons.update(DT, ships);
    for (const e of weapons.events) {
      if (e.type === 'laserHit' && e.local) byId.get(e.target)?.sim.damage(LASER_DAMAGE, 'laser', e.owner);
      else if (e.type === 'laserWorld' && e.item && e.local) world.hitBreakable(e.item.id, LASER_DAMAGE, e.owner);
      else if (e.type === 'missileBoom' && e.local) {
        for (const s of ships) {
          const d = s.sim.pos.distanceTo(e.pos);
          if (s.id !== e.owner && d < MISSILE.splash) s.sim.damage(MISSILE.damage * (1 - d / MISSILE.splash * 0.6), 'missile', e.owner);
        }
        if (hz) hz.splash(e.pos, MISSILE.splash, MISSILE.damage, e.owner);
      }
    }
    weapons.events.length = 0;
    world.update(DT, ships.map((s) => ({ id: s.id, pos: s.sim.pos, dead: s.sim.dead, radius: s.sim.p.radius, local: true })));
    for (const e of world.events) {
      if (e.type === 'pickupTaken') applyPickup(byId.get(e.by).sim, e.pickup.kind);
      if (e.type === 'blast') for (const s of ships) if (s.sim.pos.distanceTo(e.pos) < e.radius) s.sim.damage(e.damage, 'blast', e.by);
    }
    world.events.length = 0;
    if (hstep) hstep.after();
    for (const s of ships) {
      for (const e of s.sim.events) {
        if (e.type === 'damaged') s.lastKind = e.kind;
        if (e.type === 'destroyed') { s.deaths++; if (HAZ_KINDS.has(s.lastKind)) s.hzDeaths++; }
        if (e.type === 'lap' && s.sim.lap >= LAPS) { s.sim.finished = true; s.finishTime = t; }
      }
      s.sim.events.length = 0;
    }
    // --- replication
    if (client) {
      clock = t * 1000;
      snapT += DT;
      if (snapT >= 0.1) { snapT = 0; inbox.push({ at: clock + 60, kind: 'snap', data: JSON.parse(JSON.stringify(hz.snapshot())) }); }
      for (const ev of st.net) inbox.push({ at: clock + 60, kind: 'ev', data: JSON.parse(JSON.stringify(ev)) });
      st.net.length = 0;
      for (let k = 0; k < inbox.length; k++) {
        const m = inbox[k];
        if (m.at > clock) continue;
        if (m.kind === 'snap') client.applySnapshot(m.data, clock); else client.applyRemote(m.data, 0.06);
        inbox.splice(k--, 1);
      }
      const remoteShips = ships.map((s) => ({ id: s.id, sim: s.sim, connected: true, local: false }));
      client.update(DT, remoteShips, t);
      for (const ev of client.events) if (ev.type === 'droneFire') client.spawnBolt(ev);
      client.events.length = 0;
      for (const d of client.drones) {
        const h = hz.droneById.get(d.id);
        if (!h || !d.buf || d.buf.length < 2 || h.vis < 1) continue;
        const e = d.pos.distanceTo(h.pos);
        repErr.sum += e; repErr.n++; repErr.max = Math.max(repErr.max, e);
      }
      for (let k = 0; k < hz.plasmoids.length; k++) plErr = Math.max(plErr, hz.plasmoids[k].pos.distanceTo(client.plasmoids[k].pos) + (hz.plasmoids[k].state === client.plasmoids[k].state ? 0 : 1000 * 0));
    }
    t += DT;
  }
  const fin = ships.filter((s) => s.sim.finished);
  const res = {
    course: def.id, intensity, dnf: ships.length - fin.length, time: t,
    times: ships.map((s) => s.finishTime), mean: fin.reduce((a, s) => a + s.finishTime, 0) / Math.max(1, fin.length),
    deaths: ships.reduce((a, s) => a + s.deaths, 0), hzDeaths: ships.reduce((a, s) => a + s.hzDeaths, 0),
    hz: hz ? { ...hz.stats, kills: st.kills, drops: st.drops, ambush: st.ambush, droneHits: st.droneHits, dmg: st.dmg, stuck: st.stuck.size, stuckWhy: st.stuckWhy, maxOut: st.maxOut, pMaxOut: st.pMaxOut, nan: st.nan, plasmoids: hz.plasmoids.length, nests: hz.nests.length, packs: hz.nests.map((n) => n.slots.length).join('/') } : null,
  };
  if (client) res.rep = { meanErr: repErr.sum / Math.max(1, repErr.n), maxErr: repErr.max, samples: repErr.n, plasmoidErr: plErr, clientPops: client.stats.pops, hostPops: hz.stats.pops, clientDrones: client.drones.length, hostDrones: hz.drones.length };
  return res;
}

// ------------------------------------------------------------------------------ battle
function runBattle(def, intensity, seconds, seed = 1) {
  const arena = new Arena(def);
  const world = new SpaceWorld(arena);
  const weapons = new WeaponSystem(world);
  const hz = intensity == null ? null : new Hazards(arena, world, { seed, game: 'battle', intensity, authority: true });
  const aiWorld = hz ? hz.aiWorld(world) : world;
  const ships = [];
  for (let i = 0; i < 6; i++) {
    const d = PRESETS[i % PRESETS.length];
    const sim = new ShipSim(arena, computeStats(d).physics, arena.gridSlot(i), 'bot' + i);
    const e = { id: 'bot' + i, name: d.name, sim, connected: true, local: true, kind: 'ai', color: new THREE.Color('#fff'), deaths: 0, hzDeaths: 0, kills: 0, lastKind: null, pickups: 0 };
    sim.spawnPicker = () => arena.pickSpawn(ships.filter((o) => o !== e && !o.sim.dead).map((o) => o.sim.pos));
    e.ai = new BattleAI(e, aiWorld, { skill: 'normal', seed: seed * 101 + i * 7 + 3, weapons });
    ships.push(e);
  }
  const byId = new Map(ships.map((s) => [s.id, s]));
  const proxies = ships.map((s) => ({ id: s.id, pos: s.sim.pos, dead: false, radius: s.sim.p.radius, local: true }));
  const st = newStats();
  const aiShips = [];
  let t = 0;
  while (t < seconds) {
    aiShips.length = 0;
    for (const s of ships) aiShips.push(s);
    if (hz) for (const p of hz.targets) aiShips.push(p);
    for (const e of ships) {
      e.input = e.ai.think(DT, aiShips, { weapons });
      e.sim.step(DT, e.input, { world, racing: true, raceTime: t });
      if (e.sim.dead) continue;
      const aimDir = _x.set(0, 0, -1).applyQuaternion(e.sim.quat);
      weapons.updateLock(e, aimDir, ships, DT);
      if (e.input.fire) {
        const dir = _w.copy(e.input.aimDir || aimDir);
        clampCone(dir.normalize(), _v.set(0, 0, -1).applyQuaternion(e.sim.quat), 0.5);
        weapons.tryFireLaser(e, dir, e.color, true);
      }
      if (e.input.missile) weapons.tryFireMissile(e, e.sim.lock.t >= 1 ? e.sim.lock.id : null, true);
    }
    for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i], b = ships[j];
      if (a.sim.dead || b.sim.dead || a.sim.ghost > 0 || b.sim.ghost > 0) continue;
      _v.subVectors(b.sim.pos, a.sim.pos);
      const d = _v.length(), min = (a.sim.p.radius + b.sim.p.radius) * 0.9;
      if (d >= min || d < 1e-4) continue;
      _v.divideScalar(d);
      const pen = min - d;
      a.sim.pos.addScaledVector(_v, -pen / 2); b.sim.pos.addScaledVector(_v, pen / 2);
    }
    const hstep = hz ? hazardStep(hz, world, weapons, ships, byId, t, st) : null;
    weapons.update(DT, ships);
    for (let i = 0; i < ships.length; i++) proxies[i].dead = ships[i].sim.dead;
    world.update(DT, proxies);
    for (const ev of weapons.events) {
      if (ev.type === 'laserHit' && ev.local) byId.get(ev.target)?.sim.damage(LASER_DAMAGE, 'laser', ev.owner);
      else if (ev.type === 'laserWorld' && ev.local && ev.item && ev.item.maxHp != null) world.hitBreakable(ev.item.id, LASER_DAMAGE, ev.owner);
      else if (ev.type === 'missileBoom' && ev.local) {
        for (const s of ships) {
          if (s.id === ev.owner || s.sim.dead) continue;
          const d = s.sim.pos.distanceTo(ev.pos);
          if (d > MISSILE.splash) continue;
          s.sim.damage(MISSILE.damage * (s.id === ev.direct ? 1 : 1 - (d / MISSILE.splash) * 0.6), 'missile', ev.owner);
          s.sim.stun = Math.max(s.sim.stun, 0.8);
        }
        world.forEachNear(ev.pos, MISSILE.splash, (c) => { if (c.ref && !c.dead) world.hitBreakable(c.ref.id, 70, ev.owner); });
        if (hz) hz.splash(ev.pos, MISSILE.splash, MISSILE.damage, ev.owner);
      }
    }
    weapons.events.length = 0;
    for (const ev of world.events) {
      if (ev.type === 'blast') {
        for (const s of ships) {
          if (s.sim.dead) continue;
          const d = s.sim.pos.distanceTo(ev.pos);
          if (d < ev.radius) { s.sim.damage(ev.damage * (1 - (d / ev.radius) * 0.5), 'blast', ev.by); s.sim.stun = Math.max(s.sim.stun, 0.6); }
        }
      } else if (ev.type === 'pickupTaken') { const e = byId.get(ev.by); if (e) { applyPickup(e.sim, ev.pickup.kind); e.pickups++; if (String(ev.pickup.id).startsWith('vk')) st.dropTaken = (st.dropTaken || 0) + 1; } }
    }
    world.events.length = 0;
    if (hstep) hstep.after();
    for (const e of ships) {
      for (const ev of e.sim.events) {
        if (ev.type === 'damaged') e.lastKind = ev.kind;
        if (ev.type === 'destroyed') {
          e.deaths++;
          if (HAZ_KINDS.has(e.lastKind) && (ev.by == null || !byId.has(ev.by))) e.hzDeaths++;
          const k = ev.by != null && ev.by !== e.id ? byId.get(ev.by) : null;
          if (k) k.kills++;
        }
      }
      e.sim.events.length = 0;
    }
    t += DT;
  }
  return {
    arena: def.id, intensity, seconds,
    kills: ships.reduce((a, s) => a + s.kills, 0), deaths: ships.reduce((a, s) => a + s.deaths, 0), hzDeaths: ships.reduce((a, s) => a + s.hzDeaths, 0),
    pickups: ships.reduce((a, s) => a + s.pickups, 0),
    hz: hz ? { ...hz.stats, kills: st.kills, drops: st.drops, dropTaken: st.dropTaken || 0, waves: st.waves, droneHits: st.droneHits, dmg: st.dmg, stuck: st.stuck.size, stuckWhy: st.stuckWhy, maxOut: st.maxOut, pMaxOut: st.pMaxOut, nan: st.nan, plasmoids: hz.plasmoids.length, alive: hz.drones.length } : null,
  };
}

// ------------------------------------------------------------------------------ main
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL: ' + msg); };
const t0 = performance.now();

console.log(`=== Races (${LAPS} laps, normal AI, 5 presets) ===`);
for (const def of COURSES) {
  if (only && def.id !== only) continue;
  const base = runRace(def, null);
  console.log(`\n${def.name} [${def.id}]  baseline mean ${f1(base.mean)}s, deaths ${base.deaths}, DNF ${base.dnf}`);
  for (const I of INTENS) {
    const r = runRace(def, I, 1, I === 0.6);
    const h = r.hz;
    const pct = ((r.mean / base.mean - 1) * 100);
    const raceMin = (r.mean * ships(r)) / 60;
    console.log(`  @${I.toFixed(1)}  mean ${f1(r.mean)}s (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)  per-ship ${r.times.map((x) => (x == null ? 'DNF' : x.toFixed(1))).join(' ')}  DNF ${r.dnf}`);
    console.log(`        deaths ${r.deaths} (hazard ${r.hzDeaths} = ${(r.hzDeaths / raceMin).toFixed(2)}/pilot-min)  plasmoids ${h.plasmoids} nests ${h.nests} (packs ${h.packs})  ambushes ${h.ambush}`);
    console.log(`        drones spawned ${h.spawned} killed ${h.kills} (${h.droneHits} laser hits)  fired ${h.fired} bolt hits ${h.boltHits}  plasmoid contacts ${h.contacts} pops ${h.pops} reforms ${h.reforms}  drops ${h.drops}`);
    console.log(`        damage taken: ${Object.entries(h.dmg).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') || 'none'}  | watchdog: stuck ${h.stuck} (re-slotted ${h.unsticks}), drone max over wall ${f1(h.maxOut)} m, plasmoid max over wall ${f1(h.pMaxOut)} m, NaN ${h.nan}`);
    if (r.rep) console.log(`        replication (10 Hz, 60 ms): drone pos err mean ${f1(r.rep.meanErr)} m max ${f1(r.rep.maxErr)} m (${r.rep.samples} samples; 130 ms interp delay expected), plasmoid err ${r.rep.plasmoidErr.toFixed(4)} m, pops host/client ${r.rep.hostPops}/${r.rep.clientPops}, drones host/client ${r.rep.hostDrones}/${r.rep.clientDrones}`);
    if (r.dnf) fail(`${def.id}@${I}: ${r.dnf} DNF`);
    if (h.stuck) fail(`${def.id}@${I}: ${h.stuck} drones stuck: ${h.stuckWhy.join('; ')}`);
    if (h.maxOut > 0.5) fail(`${def.id}@${I}: drone outside the tube by ${h.maxOut.toFixed(1)} m`);
    if (h.pMaxOut > 0) fail(`${def.id}@${I}: plasmoid outside the tube by ${h.pMaxOut.toFixed(1)} m`);
    if (h.nan) fail(`${def.id}@${I}: NaN drone positions`);
    if (I === 0.6 && (pct > 18 || pct < -3)) fail(`${def.id}@0.6: time change ${pct.toFixed(1)}% outside the target band`);
    if (r.rep && r.rep.plasmoidErr > 1e-6) fail(`${def.id}: plasmoids differ between host and client`);
  }
}
function ships() { return PRESETS.length; }

console.log(`\n=== Battles (${BATTLE_S}s, 6 normal BattleAI bots) ===`);
for (const def of ARENAS) {
  if (only && def.id !== only) continue;
  const base = runBattle(def, null, BATTLE_S);
  console.log(`\n${def.name} [${def.id}]  baseline kills ${base.kills}, deaths ${base.deaths}`);
  for (const I of INTENS) {
    const r = runBattle(def, I, BATTLE_S);
    const h = r.hz;
    const pilotMin = (6 * BATTLE_S) / 60;
    console.log(`  @${I.toFixed(1)}  ship kills ${r.kills}, deaths ${r.deaths} (hazard ${r.hzDeaths} = ${(r.hzDeaths / pilotMin).toFixed(2)}/pilot-min)  waves ${h.waves}  drones spawned ${h.spawned} killed ${h.kills} (alive at end ${h.alive})`);
    console.log(`        fired ${h.fired} bolt hits ${h.boltHits}  plasmoids ${h.plasmoids} contacts ${h.contacts} pops ${h.pops} reforms ${h.reforms}  drops ${h.drops} (taken ${h.dropTaken}), pickups total ${r.pickups}`);
    console.log(`        damage taken: ${Object.entries(h.dmg).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') || 'none'}  | watchdog: stuck ${h.stuck} (re-slotted ${h.unsticks}), drone max outside ${f1(h.maxOut)} m, plasmoid max outside ${f1(h.pMaxOut)} m, NaN ${h.nan}`);
    if (h.stuck) fail(`${def.id}@${I}: ${h.stuck} drones stuck: ${h.stuckWhy.join('; ')}`);
    if (h.maxOut > 1) fail(`${def.id}@${I}: drone outside the arena by ${h.maxOut.toFixed(1)} m`);
    if (h.nan) fail(`${def.id}@${I}: NaN drone positions`);
    if (h.waves < Math.floor((BATTLE_S - 40) / 60)) fail(`${def.id}@${I}: only ${h.waves} waves`);
  }
}

// Determinism: same seed, same result.
console.log('\n=== Determinism ===');
{
  const c = COURSES.find((x) => x.id === (only || 'shatter')) || COURSES[1];
  const a = JSON.stringify(runRace(c, 0.6, 7)), b = JSON.stringify(runRace(c, 0.6, 7));
  console.log(`  race ${c.id} seed 7 twice: ${a === b ? 'identical' : 'DIFFERENT'}`);
  if (a !== b) fail('race not deterministic');
  const ar = ARENAS.find((x) => x.id === only) || ARENAS[0];
  const x = JSON.stringify(runBattle(ar, 0.6, 60, 3)), y = JSON.stringify(runBattle(ar, 0.6, 60, 3));
  console.log(`  battle ${ar.id} seed 3 twice (60 s): ${x === y ? 'identical' : 'DIFFERENT'}`);
  if (x !== y) fail('battle not deterministic');
}
console.log(`\n${failures ? failures + ' FAILURE(S)' : 'All hazard checks passed'} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failures ? 1 : 0);
