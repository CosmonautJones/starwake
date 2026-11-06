// Headless wormhole race: AI pilots in every preset craft on every course, with
// weapons live. Reports lap times, gates taken, wall scrapes, kills and resets.
// Also: nobody's place on the line may jump (crossovers), and on split lanes the AI must
// keep off the dividers. Includes today's daily run.
// Run: node tools/flight-sim.mjs [easy|normal|hard] [laps] [course id|daily]
import { COURSES, courseDefById, dailyCourseId } from '../js/flight/courseDefs.js';
import { Course } from '../js/flight/course.js';
import { SpaceWorld } from '../js/flight/world.js';
import { ShipSim } from '../js/flight/ship.js';
import { FlightAI } from '../js/flight/ai.js';
import { WeaponSystem, MISSILE } from '../js/flight/weapons.js';
import { PRESETS, computeStats } from '../js/craft/parts.js';
import * as THREE from 'three';

const skill = process.argv[2] || 'normal';
const LAPS = Number(process.argv[3] || 2);
const DT = 1 / 120, LIMIT = 300;
const only = process.argv[4];
let bad = 0;
for (const def of [...COURSES, courseDefById(dailyCourseId())]) {
  if (only && def.id !== only && !(only === 'daily' && def.daily)) continue;
  const course = new Course(def);
  const world = new SpaceWorld(course);
  const weapons = new WeaponSystem(world);
  const ships = PRESETS.map((d, i) => {
    const stats = computeStats(d);
    const sim = new ShipSim(course, stats.physics, course.gridSlot(i), d.id);
    const ship = { id: d.id, name: d.name, sim, connected: true, stats: { gates: 0, scrapes: 0, bumps: 0, deaths: 0, kills: 0, resets: 0, shots: 0, hits: 0, broke: 0, jumps: 0, divider: 0, risky: 0, safe: 0 } };
    ship.ai = new FlightAI(ship, world, { skill, seed: i + 3 });
    return ship;
  });
  const color = new THREE.Color('#ffffff');
  let t = 0;
  const racing = () => t > 0;
  while (t < LIMIT && ships.some((s) => !s.sim.finished)) {
    const lead = Math.max(...ships.map((s) => s.sim.progress()));
    for (const s of ships) {
      const inp = s.ai.think(DT, ships, lead);
      weapons.updateLock(s, s.sim.forward.clone(), ships, DT);
      const d0 = s.sim.dist, u0 = s.sim.trackU;
      s.sim.step(DT, inp, { world, racing: true, raceTime: t });
      // Progress along the line can only change as fast as the ship flies (respawns aside).
      const moved = Math.abs(s.sim.dist - d0), respawned = s.sim.events.some((e) => e.type === 'respawn' || e.type === 'autoReset');
      if (!respawned && moved > s.sim.vel.length() * DT * 3 + 15) s.stats.jumps++;
      if (course.splits.length && !s.sim.dead) {
        let touch = false;
        world.forEachNear(s.sim.pos, s.sim.p.radius + 0.5, (c) => { if (c.item?.type === 'divider') touch = true; });
        if (touch && !s.touching) s.stats.divider++;
        s.touching = touch;
        for (const sp of course.splits) {
          if (!(u0 < sp.at && s.sim.trackU >= sp.at && s.sim.trackU - u0 < 0.01)) continue;
          const f = course.frameAt(sp.at);
          const lat = s.sim.pos.clone().sub(f.pos).dot(sp.axis === 'up' ? f.U : f.R) * sp.side;
          if (lat > sp.offset) s.stats.risky++; else s.stats.safe++;
        }
      }
      if (inp.fire && weapons.tryFireLaser(s, inp.aimDir, color, true)) s.stats.shots++;
      if (inp.missile) weapons.tryFireMissile(s, s.sim.lock.id, true);
      for (const e of s.sim.events) {
        if (e.type === 'ring') s.stats.gates++;
        if (e.type === 'scrape') s.stats.scrapes++;
        if (e.type === 'bump') s.stats.bumps++;
        if (e.type === 'destroyed') s.stats.deaths++;
        if (e.type === 'autoReset') s.stats.resets++;
        if (e.type === 'lap' && s.sim.lap >= LAPS) { s.sim.finished = true; s.finishTime = t; }
      }
      s.sim.events.length = 0;
    }
    weapons.update(DT, ships);
    for (const e of weapons.events) {
      if (e.type === 'laserHit' && e.local) {
        const tgt = ships.find((x) => x.id === e.target);
        const owner = ships.find((x) => x.id === e.owner);
        owner.stats.hits++;
        if (tgt.sim.damage(7, 'laser', e.owner)) owner.stats.kills++;
      } else if (e.type === 'laserWorld' && e.item && e.local) {
        if (world.hitBreakable(e.item.id, 7, e.owner)) ships.find((x) => x.id === e.owner).stats.broke++;
      } else if (e.type === 'missileBoom' && e.local) {
        for (const s of ships) {
          const d = s.sim.pos.distanceTo(e.pos);
          if (s.id !== e.owner && d < MISSILE.splash) if (s.sim.damage(MISSILE.damage * (1 - d / MISSILE.splash * 0.6), 'missile', e.owner)) ships.find((x) => x.id === e.owner).stats.kills++;
        }
      }
    }
    weapons.events.length = 0;
    world.update(DT, ships.map((s) => ({ id: s.id, pos: s.sim.pos, dead: s.sim.dead, radius: s.sim.p.radius, local: true })));
    for (const e of world.events) {
      if (e.type === 'pickupTaken') {
        const s = ships.find((x) => x.id === e.by);
        if (e.pickup.kind === 'missile') s.sim.missiles = Math.min(4, s.sim.missiles + 1);
        if (e.pickup.kind === 'boost') s.sim.boost = Math.min(1, s.sim.boost + 0.35);
      }
      if (e.type === 'blast') for (const s of ships) if (s.sim.pos.distanceTo(e.pos) < e.radius) s.sim.damage(e.damage, 'blast', e.by);
    }
    world.events.length = 0;
    t += DT;
  }
  console.log(`\n${def.name} (${skill}, ${LAPS} laps) — ${world.items.length} objects, ${world.breakables.length} breakable`);
  for (const s of ships) {
    const st = s.stats;
    const laps = s.sim.lapTimes.map((v) => v.toFixed(1)).join(' / ');
    const extra = (course.splits.length ? `  splits risky ${st.risky}/safe ${st.safe} divider hits ${st.divider}` : '') + (st.jumps ? `  LINE JUMPS ${st.jumps}` : '');
    console.log(`  ${s.name.padEnd(6)} ${s.sim.finished ? 'done ' + s.finishTime.toFixed(1) + 's' : 'DNF at ' + s.sim.progress().toFixed(2)}  laps ${laps}  gates ${st.gates} scrapes ${st.scrapes} bumps ${st.bumps} deaths ${st.deaths} kills ${st.kills} resets ${st.resets} shots ${st.shots} hits ${st.hits} broke ${st.broke}${extra}`);
    if (!s.sim.finished || st.jumps) bad++;
  }
}
console.log(bad ? `\n${bad} DNF` : '\nAll AI finished');
process.exit(bad ? 1 : 0);
