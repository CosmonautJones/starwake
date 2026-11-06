// Can a player who barely steers still get round? Pilots: 'handsoff' (throttle only,
// track assist on), 'flail' (random stick jerks + boosts), 'reverse' (turns round at
// the start). Each must finish a lap on every course with assist on.
// Run: node tools/assist-sim.mjs
import { COURSES } from '../js/flight/courseDefs.js';
import { Course } from '../js/flight/course.js';
import { SpaceWorld } from '../js/flight/world.js';
import { ShipSim } from '../js/flight/ship.js';
import { PRESETS, computeStats } from '../js/craft/parts.js';
import { mulberry32 } from '../js/core/util.js';

const DT = 1 / 120;
let bad = 0;
for (const def of COURSES) {
  const course = new Course(def);
  const world = new SpaceWorld(course);
  for (const pilot of ['handsoff', 'flail', 'reverse']) {
    for (const preset of [PRESETS[0], PRESETS[2]]) {
      const sim = new ShipSim(course, computeStats(preset).physics, course.gridSlot(0), 'p');
      sim.assist = 0.7;
      const rng = mulberry32(7);
      let t = 0, jerk = 0, jx = 0, jy = 0, scrapes = 0, resets = 0, deaths = 0;
      while (t < 180 && sim.lap < 1) {
        const inp = { throttle: 1, brake: 0, boost: false, roll: 0, aimX: 0, aimY: 0 };
        if (pilot === 'flail') {
          jerk -= DT;
          if (jerk <= 0) { jerk = 0.3 + rng() * 1.2; const on = rng() < 0.5; jx = on ? rng() * 2 - 1 : 0; jy = on ? rng() * 2 - 1 : 0; }
          inp.aimX = jx; inp.aimY = jy; inp.boost = rng() < 0.3;
        }
        if (pilot === 'reverse' && t < 2.2) inp.aimX = 1; // spin round on the grid
        sim.step(DT, inp, { world, racing: true, raceTime: t });
        for (const e of sim.events) { if (e.type === 'scrape') scrapes++; if (e.type === 'autoReset') resets++; if (e.type === 'destroyed') deaths++; }
        sim.events.length = 0;
        world.update(DT, [{ id: 'p', pos: sim.pos, dead: sim.dead, radius: sim.p.radius, local: true }]);
        world.events.length = 0;
        t += DT;
      }
      const ok = sim.lap >= 1;
      if (!ok) bad++;
      console.log(`${def.id.padEnd(8)} ${pilot.padEnd(9)} ${preset.name.padEnd(6)} ${ok ? 'lap ' + sim.lapTimes[0].toFixed(1) + 's' : 'STUCK at ' + sim.progress().toFixed(2)}  scrapes ${scrapes} resets ${resets} deaths ${deaths}`);
    }
  }
}
console.log(bad ? `${bad} failed` : 'All pilots got round');
process.exit(bad ? 1 : 0);
