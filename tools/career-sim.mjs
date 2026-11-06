// Headless checks for the pilot career (js/core/career.js): medal targets on every
// course (plus generated-looking ones), AI reference times against the targets, XP and
// rank math, unlock rules, and loading a save from nothing.
// Run: node tools/career-sim.mjs [synthetic course count, default 6]
import { COURSES } from '../js/flight/courseDefs.js';
import { Course } from '../js/flight/course.js';
import { SpaceWorld } from '../js/flight/world.js';
import { ShipSim } from '../js/flight/ship.js';
import { FlightAI } from '../js/flight/ai.js';
import { PRESETS, SLOTS, LOOK_SLOTS, computeStats, normalizeDesign } from '../js/craft/parts.js';
import { mulberry32 } from '../js/core/util.js';
import {
  MEDALS, RANKS, UNLOCKS, XP, medalTargets, medalResult, parTime, courseProfile, rankInfo,
  applyRun, newCareer, normalizeCareer, isUnlocked, lockNote, RunTracker, loadCareer, recordRun,
} from '../js/core/career.js';

const SYNTH = Number(process.argv[2] ?? 6);
let bad = 0;
const fail = (msg) => { console.log('  !! ' + msg); bad++; };
const check = (ok, msg) => { if (!ok) fail(msg); };

// ---------------------------------------------------------------- generated-looking courses
// A closed loop of noisy control points round an ellipse with vertical waves, a random
// tube radius and pinches, kept only if it passes the same geometry rules as
// tools/check-courses.mjs. Features include fields and mines so obstacle density varies.
function synthCourse(seed) {
  const rng = mulberry32(seed);
  for (let tries = 0; tries < 300; tries++) {
    const n = 12 + Math.floor(rng() * 7);
    const A = 600 + rng() * 700, B = A * (0.6 + rng() * 0.5);
    const amp = 80 + rng() * 340, ph = rng() * 6.28, f = 1 + Math.floor(rng() * 3);
    const points = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2, r = 1 + (rng() - 0.5) * 0.45;
      points.push([Math.cos(t) * A * r, Math.sin(t * f + ph) * amp + (rng() - 0.5) * 60, Math.sin(t) * B * r]);
    }
    const radius = 50 + Math.round(rng() * 22);
    const pinches = [];
    for (let k = Math.floor(rng() * 3); k > 0; k--) pinches.push({ at: 0.15 + rng() * 0.7, len: 0.03 + rng() * 0.02, radius: Math.round(radius * (0.65 + rng() * 0.15)) });
    const features = [];
    if (rng() < 0.7) features.push({ type: 'field', from: 0.1, to: 0.35, count: 10 + Math.floor(rng() * 35), kind: 'asteroid', spread: [20, 140], size: [3, 10] });
    if (rng() < 0.4) features.push({ type: 'mines', from: 0.6, to: 0.75, count: 4 + Math.floor(rng() * 10), spread: [6, 40] });
    const def = { id: `daily-test-${seed}`, name: 'Generated', points, tunnel: { radius, pinches }, ringRadius: 15, ringSpacing: 300, features, belts: [] };
    if (validGeometry(def)) return def;
  }
  throw new Error('could not generate a valid course for seed ' + seed);
}

function validGeometry(def) {
  const c = new Course(def), n = c.sampleCount, k = 5;
  for (let i = 0; i < n; i++) {
    const a = c.samples[(i - k + n) % n], b = c.samples[i], d = c.samples[(i + k) % n];
    const ab = a.distanceTo(b), bd = b.distanceTo(d), ad = a.distanceTo(d), s = (ab + bd + ad) / 2;
    const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bd) * (s - ad)));
    const R = area > 1e-6 ? (ab * bd * ad) / (4 * area) : Infinity;
    if (R / c.tunnelRadiusAt(i / n) < 1.6) return false;
  }
  for (let i = 0; i < n; i += 3) for (let j = i + 3; j < n; j += 3) {
    let ds = Math.abs(i - j) * (c.length / n); ds = Math.min(ds, c.length - ds);
    if (ds >= 400 && c.samples[i].distanceTo(c.samples[j]) - c.tunnelRadiusAt(i / n) - c.tunnelRadiusAt(j / n) < 25) return false;
  }
  return true;
}

/** One AI pilot alone on the course (a time trial), weapons off. Returns race time or null. */
function soloRun(def, design, skill, seed, laps) {
  const course = new Course(def);
  const world = new SpaceWorld(course);
  const sim = new ShipSim(course, computeStats(design).physics, course.gridSlot(0), design.id);
  const ship = { id: design.id, name: design.name, sim, connected: true };
  ship.ai = new FlightAI(ship, world, { skill, seed });
  const DT = 1 / 120;
  for (let t = 0; t < 120 * laps; t += DT) {
    const inp = ship.ai.think(DT, [ship], 0);
    inp.fire = false; inp.missile = false;
    sim.step(DT, inp, { world, racing: true, raceTime: t });
    for (const e of sim.events) if (e.type === 'lap' && sim.lap >= laps) return t;
    sim.events.length = 0;
    world.update(DT, [{ id: ship.id, pos: sim.pos, dead: sim.dead, radius: sim.p.radius, local: true }]);
    world.events.length = 0;
  }
  return null;
}

const fmt = (s) => (s == null ? 'DNF' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);

// ---------------------------------------------------------------- 1. targets on every course
console.log('Medal targets');
const defs = [...COURSES];
for (let i = 1; i <= SYNTH; i++) defs.push(synthCourse(i * 7919 + 13));
for (const def of defs) {
  const prof = courseProfile(def);
  for (const laps of [1, 2, 3, 5]) {
    const t = medalTargets(def, laps);
    check(t.length === MEDALS.length && t.every((m) => Number.isFinite(m.time) && m.time > 0), `${def.id} ${laps} laps: bad targets`);
    for (let i = 1; i < t.length; i++) check(t[i].time < t[i - 1].time, `${def.id} ${laps} laps: ${t[i].id} not faster than ${t[i - 1].id}`);
    if (laps > 1) {
      const one = medalTargets(def, 1);
      // laps scale the lap part linearly; the standing start is counted once
      const perLap = t[0].time / laps / one[0].time;
      check(perLap > 0.9 && perLap <= 1, `${def.id}: bronze for ${laps} laps doesn't scale with laps (${perLap.toFixed(3)})`);
    }
  }
  const t2 = medalTargets(def, 2);
  console.log(`  ${def.id.padEnd(17)} ${Math.round(prof.length)} m, ${prof.density.toFixed(1)} obstacles/km, bend load ${(prof.bendLoad * 100).toFixed(1)}%, par ${fmt(parTime(def, 2))} (2 laps): ${t2.map((m) => `${m.label} ${fmt(m.time)}`).join(', ')}`);
}

// ---------------------------------------------------------------- 2. AI against the targets
console.log('\nAI time trials (2 laps): normal pilots must land between gold and bronze, nobody beats Starwake');
const LAPS = 2;
let rows = 0, ratios = [];
for (const def of defs) {
  const t = medalTargets(def, LAPS);
  const [bronze, , gold, star] = t.map((m) => m.time);
  const normal = PRESETS.map((d, i) => soloRun(def, d, 'normal', i + 3, LAPS));
  const hard = PRESETS.map((d, i) => soloRun(def, d, 'hard', i + 3, LAPS));
  const par = parTime(def, LAPS);
  normal.forEach((x, i) => {
    if (x == null) { fail(`${def.id}: ${PRESETS[i].name} (normal) did not finish`); return; }
    ratios.push(x / par);
    check(x > gold && x < bronze, `${def.id}: ${PRESETS[i].name} normal ${fmt(x)} outside gold ${fmt(gold)} .. bronze ${fmt(bronze)}`);
  });
  hard.forEach((x, i) => { if (x != null) check(x > star, `${def.id}: ${PRESETS[i].name} hard ${fmt(x)} beats the Starwake target ${fmt(star)}`); });
  const nn = normal.filter((x) => x != null), hh = hard.filter((x) => x != null);
  const med = [...nn].sort((a, b) => a - b)[nn.length >> 1];
  console.log(`  ${def.id.padEnd(17)} normal ${fmt(Math.min(...nn))}..${fmt(Math.max(...nn))} (median ${(med / par).toFixed(3)} of par)  hard best ${fmt(Math.min(...hh))}  | gold ${fmt(gold)} bronze ${fmt(bronze)} starwake ${fmt(star)}  [tube ${def.tunnel.radius}]`);
  rows++;
}
ratios.sort((a, b) => a - b);
console.log(`  normal AI / par: min ${ratios[0].toFixed(3)}, median ${ratios[ratios.length >> 1].toFixed(3)}, max ${ratios[ratios.length - 1].toFixed(3)} over ${ratios.length} runs on ${rows} courses`);

// ---------------------------------------------------------------- 3. XP and ranks
console.log('\nXP and ranks');
check(RANKS.length === 10, 'expected 10 ranks');
for (let i = 1; i < RANKS.length; i++) check(RANKS[i].xp > RANKS[i - 1].xp, `rank ${i + 1} threshold not above rank ${i}`);
check(rankInfo(0).rank === 1 && rankInfo(0).progress === 0, 'fresh pilot should be rank 1 at 0%');
check(rankInfo(RANKS[1].xp - 1).rank === 1 && rankInfo(RANKS[1].xp).rank === 2, 'rank 2 boundary');
check(rankInfo(1e9).rank === 10 && rankInfo(1e9).next == null && rankInfo(1e9).progress === 1, 'max rank');
check(rankInfo(-5).xp === 0 && rankInfo(NaN).rank === 1, 'bad XP clamps to 0');

const corona = COURSES[0];
const goldTime = medalTargets(corona, 2)[2].time - 0.5;
const raceRun = { game: 'race', mode: 'solo', def: corona, laps: 2, skill: 'normal', finished: true, time: goldTime, rank: 1, field: 6, personalBest: true, lapsDone: 2, cleanLaps: 1, demolitions: 1, kills: 0 };
let { career: c1, award: a1 } = applyRun(newCareer(), raceRun);
const expect1 = XP.finish + 2 * XP.lap + XP.cleanLap + XP.place[0] + XP.demolition + XP.personalBest + MEDALS[0].xp + MEDALS[1].xp + MEDALS[2].xp;
check(a1.total === expect1, `first gold race: expected ${expect1} XP, got ${a1.total}`);
check(a1.medal === 'gold' && a1.newMedals.join() === 'bronze,silver,gold' && c1.medals.corona === 3, 'gold race should earn bronze, silver and gold');
check(a1.next?.id === 'starwake' && a1.next.gap > 0, 'after gold, the next target is Starwake');
check(a1.after.rank > a1.before.rank, 'a first gold should rank you up');
check(a1.items.reduce((s, x) => s + x.xp, 0) === a1.total, 'breakdown adds up');
const { award: a2 } = applyRun(c1, raceRun);
check(a2.newMedals.length === 0 && !a2.items.some((x) => /medal/.test(x.label)), 'medal XP is paid once per tier');
check(a2.total === expect1 - MEDALS[0].xp - MEDALS[1].xp - MEDALS[2].xp, 'repeat race XP');
const slow = applyRun(newCareer(), { ...raceRun, time: medalTargets(corona, 2)[0].time + 3, rank: 6 }).award;
check(slow.medal === null && slow.next?.id === 'bronze' && Math.abs(slow.next.gap - 3) < 0.11, 'no medal: shows the gap to bronze');
const withAI = applyRun(newCareer(), { ...raceRun, mode: 'multi' }).award;
check(withAI.medal === null && withAI.items.some((x) => x.label === 'Online match'), 'online races give XP but no medals');
const dnf = applyRun(newCareer(), { ...raceRun, finished: false, time: null, lapsDone: 1, cleanLaps: 0, demolitions: 0 }).award;
check(dnf.total === XP.dnf + XP.lap && dnf.medal === null, 'did not finish: small XP, no medal');
const battle = applyRun(newCareer(), { game: 'battle', mode: 'solo', skill: 'hard', rank: 1, field: 6, kills: 7, demolitions: 1, team: null }).award;
check(battle.total === XP.battle + 7 * XP.battleKill + XP.demolition + XP.battlePlace[0] * 1.5, `battle XP (got ${battle.total})`);
// A fresh pilot ranks up after their first race or two.
let early = newCareer();
for (let i = 0; i < 2; i++) early = applyRun(early, { ...raceRun, time: medalTargets(corona, 2)[0].time - 1, rank: 3, cleanLaps: 0, demolitions: 0, personalBest: i === 0 }).career;
check(rankInfo(early.xp).rank >= 2, `two bronze-pace races should reach rank 2 (xp ${early.xp})`);
console.log(`  first gold on Corona Run: ${a1.total} XP (${a1.items.map((x) => `${x.label} ${x.xp}`).join(', ')}), rank ${a1.before.rank} -> ${a1.after.rank}`);
console.log(`  same race again: ${a2.total} XP; hard battle win with 7 kills: ${battle.total} XP; two bronze races: ${early.xp} XP`);

const tr = new RunTracker();
for (const e of [{ type: 'scrape' }, { type: 'lap' }, { type: 'kill', demo: true }, { type: 'kill' }, { type: 'lap' }, { type: 'destroyed' }, { type: 'finish' }, { type: 'scrape' }, { type: 'lap' }]) tr.event(e);
const sm = tr.summary();
check(sm.lapsDone === 3 && sm.cleanLaps === 1 && sm.demolitions === 1 && sm.kills === 1, `run tracker: ${JSON.stringify(sm)}`);

// ---------------------------------------------------------------- 4. unlocks
console.log('\nUnlocks');
const fresh = newCareer();
for (const p of PRESETS) for (const s of SLOTS) check(isUnlocked(s.key, p[s.key], fresh), `preset ${p.name} ${s.key} must stay free`);
for (const s of LOOK_SLOTS) check(isUnlocked(s.key, s.fallback, fresh), `default ${s.key} must be free`);
for (const s of SLOTS) for (const key of ['swept', 'delta', 'broad', 'xwing', 'none', 'single', 'twin', 'quad', 'ion', 'tall', 'tri', 'bubble', 'canopy', 'visor', 'armored', 'dart', 'arrow', 'hauler', 'glider', 'bike']) {
  if (s.options[key] && !(s.key === 'fins' && key === 'quad') && !(s.key === 'engines' && key === 'tri')) check(isUnlocked(s.key, key, fresh), `${s.key} ${key} existed before careers and must stay free`);
}
for (const u of UNLOCKS) {
  const slot = [...SLOTS, ...LOOK_SLOTS].find((s) => s.key === u.kind);
  check(slot && slot.options[u.key], `unlock ${u.kind}:${u.key} is not a real option`);
  check(!isUnlocked(u.kind, u.key, fresh) && lockNote(u.kind, u.key, fresh).length > 0, `${u.label} should start locked with a note`);
}
check(lockNote('engines', 'tri', fresh) === 'Reach rank 4', `rank note: "${lockNote('engines', 'tri', fresh)}"`);
check(lockNote('finish', 'iridescent', fresh) === 'Gold on Ice Veil', `medal note: "${lockNote('finish', 'iridescent', fresh)}"`);
check(lockNote('trail', 'starwake', fresh) === 'Earn a secret medal', 'the Starwake medal stays secret before any gold');
check(lockNote('trail', 'starwake', c1) === 'Earn a Starwake medal', 'after a gold the Starwake medal is named');
const rank4 = { ...fresh, xp: RANKS[3].xp };
check(isUnlocked('engines', 'tri', rank4) && !isUnlocked('fins', 'quad', rank4), 'rank 4 unlocks tri engines but not X tail');
check(isUnlocked('finish', 'iridescent', { ...fresh, medals: { veil: 3 } }) && !isUnlocked('finish', 'iridescent', { ...fresh, medals: { veil: 2, corona: 3 } }), 'gold on Ice Veil unlocks iridescent');
check(isUnlocked('trail', 'starwake', { ...fresh, medals: { 'daily-2026-11-06': 4 } }), 'a Starwake medal on any course (even a daily) unlocks the Starwake trail');
check(a1.unlocked.some((u) => u.key === 'metallic'), 'first gold race announces rank 2 unlocks');
// Locked items never break a design: normalizeDesign keeps them, and bad values fall back.
const lockedDesign = normalizeDesign({ ...PRESETS[0], wings: 'blade', engines: 'tri', fins: 'quad', finish: 'chrome', trail: 'starwake' });
check(lockedDesign.wings === 'blade' && lockedDesign.engines === 'tri' && lockedDesign.trail === 'starwake' && lockedDesign.finish === 'chrome', 'a design using locked items still loads as is');
check(computeStats(lockedDesign).physics.topSpeed > 0, 'a design using locked items still flies');
const junk = normalizeDesign({ ...PRESETS[0], trail: 'toString', finish: 42 });
check(junk.trail === 'glow' && junk.finish === 'standard', 'unknown trail/finish fall back to defaults');
check(normalizeDesign(PRESETS[2]).trail === 'glow', 'presets fly the default trail');

// ---------------------------------------------------------------- 5. saves
console.log('\nSaves');
const empty = normalizeCareer(null, null);
check(empty.v === 1 && empty.xp === 0 && Object.keys(empty.medals).length === 0, 'no data: fresh career');
const veteran = normalizeCareer(null, { corona: { race2: medalTargets(corona, 2)[1].time - 0.2, lap: 40 }, veil: { race1: 9999 }, gone: { race2: 10 } });
check(veteran.medals.corona === 2 && !veteran.medals.veil && !veteran.medals.gone && veteran.xp === MEDALS[0].xp + MEDALS[1].xp, `old personal bests become medals: ${JSON.stringify(veteran)}`);
const cleaned = normalizeCareer({ xp: '120', medals: { corona: 9, veil: 2, shatter: 'x' }, races: -3 });
check(cleaned.xp === 120 && cleaned.medals.veil === 2 && !cleaned.medals.corona && !cleaned.medals.shatter && cleaned.races === 0, `bad save values are dropped: ${JSON.stringify(cleaned)}`);
check(normalizeCareer('garbage').xp === 0 && normalizeCareer([1, 2]).xp === 0, 'garbage save loads as a fresh career');
// storage.js falls back to memory in Node, so the real load/record path runs here too.
const live = loadCareer();
check(live.xp === 0, 'first load in a clean environment');
const rec = recordRun(raceRun);
check(rec.total === expect1 && loadCareer().medals.corona === 3, 'recordRun saves medals and XP');

console.log(bad ? `\n${bad} career problem(s)` : '\nCareer OK');
process.exit(bad ? 1 : 0);
