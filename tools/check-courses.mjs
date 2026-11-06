// Validates wormhole course geometry: every bend wider than the tube, no two stretches
// of tube overlapping (except declared crossings), ships always located on their own
// stretch, gates and pads inside the tube, and the start straight clear. Also checks
// today's daily course and a spread of sample dates.
// Run: node tools/check-courses.mjs [dates]   (dates: how many sample daily dates, default 60)
import { COURSES, courseDefById } from '../js/flight/courseDefs.js';
import { dailyCourseId, dailyCourseDef } from '../js/flight/daily.js';
import { Course } from '../js/flight/course.js';
import { SpaceWorld } from '../js/flight/world.js';
import { BoostPads } from '../js/flight/pads.js';
import { checkCourse } from '../js/flight/courseCheck.js';

const DATES = Number(process.argv[2] ?? 60);
let problems = 0;

function run(def, verbose = true) {
  const c = new Course(def);
  const world = new SpaceWorld(c);
  const pads = new BoostPads(c, world);
  const r = checkCourse(c, { world, pads });
  const s = r.stats;
  if (verbose || !r.ok) {
    console.log(`${def.name}${def.daily ? ` [${def.id}, ${def.difficulty}${def.attempt ? `, seed ${def.attempt}` : ''}]` : ''}: length ${s.length}, tube ${def.tunnel.radius} (${(def.tunnel.pinches || []).length} pinches${c.splits.length ? `, ${c.splits.length} splits` : ''}), ${s.gates} gates, ${s.pads} pads, tightest bend ${s.tightest} at u=${s.tightestAt} (${s.worst}x tube at u=${s.worstAt}), start ${s.start}x, closest wall-to-wall gap ${s.minGap} at u=${s.gapAt}${s.crossGap != null ? `, declared crossing ${s.crossGap} m at u=${s.crossAt}` : ''}, locate err ${s.locateErr} m`);
  }
  for (const p of r.problems) console.log(`  !! ${p}`);
  problems += r.problems.length;
  return r;
}

for (const def of COURSES) run(def);

// Daily courses: today's, then a spread of dates (one line each unless something fails).
const today = dailyCourseId();
run(courseDefById(today));
const start = Date.UTC(2026, 0, 1);
const tally = {}, attempts = [];
let maxLen = 0, minLen = Infinity, failed = 0;
for (let k = 0; k < DATES; k++) {
  const id = dailyCourseId(new Date(start + k * 6 * 86400e3 + (k % 5) * 3600e3));
  const def = courseDefById(id);
  const before = problems;
  if (def.id !== id) { console.log(`  !! ${id} did not round-trip (got ${def.id})`); problems++; }
  // Deterministic: a fresh generation (bypassing the cache) gives the same course.
  const fresh = dailyCourseDef(id, { cache: false });
  if (JSON.stringify(fresh) !== JSON.stringify(def)) { console.log(`  !! ${id} is not deterministic`); problems++; }
  const r = run(def, false);
  if (problems > before) failed++;
  tally[def.difficulty] = (tally[def.difficulty] || 0) + 1;
  attempts.push(def.attempt || 0);
  maxLen = Math.max(maxLen, r.stats.length); minLen = Math.min(minLen, r.stats.length);
}
if (DATES) console.log(`Daily run: ${DATES} sample dates, ${failed} failed, lengths ${minLen}-${maxLen}, ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}, re-seeds max ${Math.max(...attempts)} avg ${(attempts.reduce((a, b) => a + b, 0) / attempts.length).toFixed(1)}`);

// The rules must still catch accidents: Helix Braid without its declared crossing, or with
// a clearance it doesn't meet, has to fail.
const braid = COURSES.find((c) => c.id === 'braid');
if (braid) {
  const undeclared = checkCourse(new Course({ ...braid, crossings: undefined }), { quick: true });
  const tooTight = checkCourse(new Course({ ...braid, crossings: braid.crossings.map((x) => ({ ...x, clearance: 30 })) }), { quick: true });
  const ok = !undeclared.ok && !tooTight.ok;
  console.log(`Self-test: undeclared close pass ${undeclared.ok ? 'NOT caught' : 'caught'}, crossing below its clearance ${tooTight.ok ? 'NOT caught' : 'caught'}`);
  if (!ok) problems++;
}

console.log(problems ? `${problems} problem(s)` : 'All courses OK');
process.exit(problems ? 1 : 0);
