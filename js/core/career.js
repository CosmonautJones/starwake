// Pilot career: medal targets per course, XP and pilot ranks, and the hangar unlock
// table. Everything here is local to this browser and purely cosmetic/progression: it
// never changes the simulation, never gates joining a lobby, and a locked item never
// stops a saved design (or a multiplayer peer's craft) from loading and flying.
//
// The rules are pure functions (tools/career-sim.mjs runs them in Node). The small
// load/save layer at the bottom goes through storage.js (key starwake.career.v1).

import { Course } from '../flight/course.js';
import { COURSES } from '../flight/courseDefs.js';
import { storage } from './storage.js';

export const CAREER_VERSION = 1;

// ================================================================== medals
// Targets are multiples of a course's "par": the time a normal-skill AI pilot takes
// flying alone. mul < 1 is faster than par. The Starwake medal stays hidden on a
// course until you hold gold there.
export const MEDALS = [
  { id: 'bronze', label: 'Bronze', mul: 1.25, xp: 100 },
  { id: 'silver', label: 'Silver', mul: 1.05, xp: 200 },
  { id: 'gold', label: 'Gold', mul: 0.88, xp: 350 },
  { id: 'starwake', label: 'Starwake', mul: 0.8, xp: 600, hidden: true },
];
export const MEDAL_TIER = { bronze: 1, silver: 2, gold: 3, starwake: 4 };

/**
 * Pace model, calibrated with tools/career-sim.mjs (solo AI, every preset, normal skill):
 *  - a flying lap costs MS_PER_M milliseconds per metre of racing line,
 *  - plus OBSTACLE per in-tunnel obstacle per km (fields, boulders, scattered props;
 *    a mine counts as MINE obstacles because pilots weave round them),
 *  - plus a bend load: extra time a craft turning at BEND_RATE rad/s would lose to
 *    curves tighter than its top speed allows (near zero for today's courses, but it
 *    keeps hairpin-heavy generated courses honest),
 *  - plus START seconds once per race for the standing start.
 * A course can override with def.medals = { lap: seconds } (flying-lap par) or
 * { scale: k } (multiplies the modelled lap), or through COURSE_TUNING below.
 */
export const PACE = { MS_PER_M: 6.95, OBSTACLE: 0.0032, MINE: 4, BEND_SPEED: 150, BEND_RATE: 1.2, START: 2.5 };
const COURSE_TUNING = {}; // id -> { lap?, scale? } — none needed for the built-in courses

const _pace = new Map();

/** Static facts about a course that set its par. Cached per course id. */
export function courseProfile(def) {
  const key = def.id + ':' + (def.points?.length || 0);
  if (_pace.has(key)) return _pace.get(key);
  const c = new Course(def);
  const n = c.sampleCount, V = PACE.BEND_SPEED;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = -5; j <= 5; j++) k = Math.max(k, c.curv[(i + j + n) % n]);
    v[i] = k > 1e-5 ? Math.min(V, PACE.BEND_RATE / k) : V;
  }
  // Acceleration / braking limits between bends (two passes round the loop).
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) { const p = v[(i - 1 + n) % n]; v[i] = Math.min(v[i], Math.sqrt(p * p + 120 * c.step)); }
    for (let i = n - 1; i >= 0; i--) { const q = v[(i + 1) % n]; v[i] = Math.min(v[i], Math.sqrt(q * q + 240 * c.step)); }
  }
  let t = 0;
  for (let i = 0; i < n; i++) t += c.step / v[i];
  const bendLoad = Math.max(0, t / (c.length / V) - 1);
  let obstacles = 0;
  for (const f of def.features || []) {
    if (f.type === 'field' || f.type === 'boulders' || f.type === 'scatter') obstacles += f.count || 0;
    else if (f.type === 'mines') obstacles += (f.count || 0) * PACE.MINE;
  }
  const density = obstacles / (c.length / 1000);
  const tune = { ...(COURSE_TUNING[def.id] || {}), ...(def.medals || {}) };
  let lap = (c.length * PACE.MS_PER_M / 1000) * (1 + PACE.OBSTACLE * density) * (1 + bendLoad);
  if (Number.isFinite(tune.scale) && tune.scale > 0) lap *= tune.scale;
  if (Number.isFinite(tune.lap) && tune.lap > 0) lap = tune.lap;
  const out = { length: c.length, density, bendLoad, lap };
  _pace.set(key, out);
  return out;
}

/** Par race time (seconds) for a course and lap count. */
export function parTime(def, laps) {
  return PACE.START + Math.max(1, laps | 0) * courseProfile(def).lap;
}

/** [{ id, label, time, hidden }] slowest first, times rounded to 0.1 s. */
export function medalTargets(def, laps) {
  const par = parTime(def, laps);
  return MEDALS.map((m) => ({ id: m.id, label: m.label, time: Math.round(par * m.mul * 10) / 10, hidden: !!m.hidden }));
}

/** Best medal a race time earns (or null), plus the next one up and how far off it was. */
export function medalResult(time, targets) {
  if (time == null || !Number.isFinite(time)) return { medal: null, next: null };
  let medal = null;
  for (const t of targets) if (time <= t.time) medal = t;
  const nextIdx = medal ? targets.indexOf(medal) + 1 : 0;
  const nx = targets[nextIdx] || null;
  return { medal: medal?.id || null, next: nx ? { id: nx.id, label: nx.label, gap: Math.max(0.1, Math.round((time - nx.time) * 10) / 10), hidden: nx.hidden } : null };
}

// ================================================================== ranks and XP
export const RANKS = [
  { name: 'Cadet', xp: 0 },
  { name: 'Shuttle pilot', xp: 300 },
  { name: 'Courier', xp: 800 },
  { name: 'Interceptor', xp: 1500 },
  { name: 'Vanguard', xp: 2500 },
  { name: 'Wing leader', xp: 3800 },
  { name: 'Comet rider', xp: 5500 },
  { name: 'Voidrunner', xp: 7600 },
  { name: 'Star captain', xp: 10200 },
  { name: 'Starwake ace', xp: 13500 },
];

/** { rank (1-based), name, xp, floor, next (xp for the next rank or null), progress 0..1, toNext } */
export function rankInfo(xp) {
  const x = Math.max(0, Math.floor(xp || 0));
  let i = 0;
  while (i + 1 < RANKS.length && x >= RANKS[i + 1].xp) i++;
  const floor = RANKS[i].xp, next = RANKS[i + 1]?.xp ?? null;
  return { rank: i + 1, name: RANKS[i].name, xp: x, floor, next, progress: next == null ? 1 : (x - floor) / (next - floor), toNext: next == null ? 0 : next - x };
}

export const XP = {
  finish: 100, dnf: 30, lap: 20, cleanLap: 40, personalBest: 50, online: 50,
  place: [150, 100, 70], placeOther: 40,
  demolition: 60, kill: 25,
  battle: 80, battleKill: 30, battlePlace: [200, 100, 60], teamWin: 150,
};
const SKILL_MUL = { easy: 0.75, normal: 1, hard: 1.5 };

// ================================================================== unlocks
// Everything that shipped before careers is free and stays free; these add new things.
// req: { rank } or { medal, course } (course omitted = on any course).
export const UNLOCKS = [
  { kind: 'finish', key: 'metallic', label: 'Metallic paint', req: { rank: 2 } },
  { kind: 'trail', key: 'comet', label: 'Comet trail', req: { rank: 2 } },
  { kind: 'wings', key: 'forward', label: 'Forward swept wings', req: { rank: 3 } },
  { kind: 'trail', key: 'pulse', label: 'Pulse trail', req: { rank: 4 } },
  { kind: 'engines', key: 'tri', label: 'Tri engines', req: { rank: 4 } },
  { kind: 'finish', key: 'pearl', label: 'Pearl paint', req: { rank: 5 } },
  { kind: 'fins', key: 'quad', label: 'X tail fins', req: { rank: 6 } },
  { kind: 'trail', key: 'prism', label: 'Prism trail', req: { rank: 7 } },
  { kind: 'wings', key: 'blade', label: 'Blade wings', req: { rank: 8 } },
  { kind: 'finish', key: 'chrome', label: 'Chrome paint', req: { rank: 9 } },
  { kind: 'trail', key: 'aurora', label: 'Aurora trail', req: { rank: 10 } },
  { kind: 'trail', key: 'ember', label: 'Ember trail', req: { medal: 'silver', course: 'shatter' } },
  { kind: 'finish', key: 'iridescent', label: 'Iridescent paint', req: { medal: 'gold', course: 'veil' } },
  { kind: 'trail', key: 'starwake', label: 'Starwake trail', req: { medal: 'starwake' } },
];
const unlockId = (u) => `${u.kind}:${u.key}`;

export function unlockFor(kind, key) { return UNLOCKS.find((u) => u.kind === kind && u.key === key) || null; }

function meets(req, career) {
  if (req.rank) return rankInfo(career.xp).rank >= req.rank;
  if (req.medal) {
    const need = MEDAL_TIER[req.medal] || 99;
    if (req.course) return (career.medals[req.course] || 0) >= need;
    return Object.values(career.medals).some((t) => t >= need);
  }
  return true;
}

/** Items with no entry in UNLOCKS are always available. */
export function isUnlocked(kind, key, career) {
  const u = unlockFor(kind, key);
  return !u || meets(u.req, career);
}

/** Short reason a locked item is locked, e.g. "Reach rank 4" or "Gold on Ice Veil". */
export function lockNote(kind, key, career) {
  const u = unlockFor(kind, key);
  if (!u || meets(u.req, career)) return '';
  const r = u.req;
  if (r.rank) return `Reach rank ${r.rank}`;
  const m = MEDALS.find((x) => x.id === r.medal);
  if (m?.hidden && !Object.values(career.medals).some((t) => t >= MEDAL_TIER.gold)) return 'Earn a secret medal';
  if (!r.course) return `Earn a ${m.label} medal`;
  const name = COURSES.find((c) => c.id === r.course)?.name || r.course;
  return `${m.label} on ${name}`;
}

export function unlockedIds(career) { return UNLOCKS.filter((u) => meets(u.req, career)).map(unlockId); }

// ================================================================== career state
export function newCareer() { return { v: CAREER_VERSION, xp: 0, races: 0, battles: 0, medals: {} }; }

/**
 * Validate (and migrate) whatever was stored. With no saved career, existing personal
 * bests (starwake.records.v1) are turned into medals, and their XP is credited once,
 * so returning players start with what they've already flown.
 */
export function normalizeCareer(raw, records = null, getDef = defaultDef) {
  const c = newCareer();
  if (raw && typeof raw === 'object') {
    c.xp = Math.max(0, Math.floor(Number(raw.xp) || 0));
    c.races = Math.max(0, Math.floor(Number(raw.races) || 0));
    c.battles = Math.max(0, Math.floor(Number(raw.battles) || 0));
    if (raw.medals && typeof raw.medals === 'object') {
      for (const [id, t] of Object.entries(raw.medals)) {
        const tier = Math.floor(Number(t));
        if (tier >= 1 && tier <= MEDALS.length) c.medals[String(id).slice(0, 64)] = tier;
      }
    }
    return c;
  }
  if (records && typeof records === 'object') {
    for (const [id, r] of Object.entries(records)) {
      const def = getDef(id);
      if (!def || !r || typeof r !== 'object') continue;
      let best = 0;
      for (const [k, time] of Object.entries(r)) {
        const m = /^race(\d+)$/.exec(k);
        if (!m || !Number.isFinite(time)) continue;
        const { medal } = medalResult(time, medalTargets(def, Number(m[1])));
        best = Math.max(best, MEDAL_TIER[medal] || 0);
      }
      if (best) {
        c.medals[id] = best;
        for (let t = 1; t <= best; t++) c.xp += MEDALS[t - 1].xp;
      }
    }
  }
  return c;
}

function defaultDef(id) { return COURSES.find((c) => c.id === id) || null; }

/**
 * Score one finished race or battle. Pure: returns { career: next state, award }.
 * run: {
 *   game: 'race'|'battle', mode: 'solo'|'multi', def (course def, races), laps,
 *   skill, finished, time, rank, field (entrants), personalBest,
 *   lapsDone, cleanLaps, demolitions, kills, team: 'win'|'loss'|'draw'|null
 * }
 * award: { items: [{label, xp}], total, before, after (rankInfo), medal, next,
 *          newMedals: [ids], targets, unlocked: [{kind, key, label}], courseId }
 */
export function applyRun(career, run) {
  const c = { ...career, medals: { ...career.medals } };
  const items = [];
  const add = (label, xp) => { if (xp > 0) items.push({ label, xp: Math.round(xp) }); };
  const before = rankInfo(c.xp);
  const unlockedBefore = new Set(unlockedIds(c));
  const field = Math.max(1, run.field | 0);
  const skillMul = run.mode === 'solo' ? (SKILL_MUL[run.skill] ?? 1) : 1;
  const place = (n) => `${n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'} place`;
  let medal = null, next = null, targets = null;
  const newMedals = [];

  if (run.game === 'battle') {
    c.battles++;
    add('Battle flown', XP.battle);
    if (run.kills) add(`${run.kills} kill${run.kills > 1 ? 's' : ''}`, run.kills * XP.battleKill);
    if (run.demolitions) add(`${run.demolitions} demolition${run.demolitions > 1 ? 's' : ''}`, run.demolitions * XP.demolition);
    if (run.team === 'win') add('Your crew won', XP.teamWin * skillMul);
    else if (!run.team && field > 1 && run.rank >= 1 && run.rank <= 3) add(place(run.rank), XP.battlePlace[run.rank - 1] * skillMul);
  } else {
    c.races++;
    if (run.finished) add('Finished', XP.finish);
    else add('Flew the course', XP.dnf);
    if (run.lapsDone) add(`${run.lapsDone} lap${run.lapsDone > 1 ? 's' : ''}`, run.lapsDone * XP.lap);
    if (run.cleanLaps) add(`${run.cleanLaps} clean lap${run.cleanLaps > 1 ? 's' : ''}`, run.cleanLaps * XP.cleanLap);
    if (run.finished && field > 1 && run.rank >= 1) add(place(run.rank), (XP.place[run.rank - 1] ?? XP.placeOther) * skillMul);
    if (run.demolitions) add(`${run.demolitions} demolition${run.demolitions > 1 ? 's' : ''}`, run.demolitions * XP.demolition);
    if (run.kills) add(`${run.kills} kill${run.kills > 1 ? 's' : ''}`, run.kills * XP.kill);
    if (run.finished && run.personalBest) add('Personal best', XP.personalBest);
    // Medals: solo races (with or without AI) on any course, first time per tier.
    if (run.def && run.mode === 'solo') {
      targets = medalTargets(run.def, run.laps);
      if (run.finished) {
        const res = medalResult(run.time, targets);
        medal = res.medal; next = res.next;
        const had = c.medals[run.def.id] || 0, got = MEDAL_TIER[medal] || 0;
        for (let t = had + 1; t <= got; t++) {
          const m = MEDALS[t - 1];
          newMedals.push(m.id);
          add(`${m.label} medal`, m.xp);
        }
        if (got > had) c.medals[run.def.id] = got;
      }
    }
  }
  if (run.mode === 'multi') add('Online match', XP.online);

  const total = items.reduce((s, x) => s + x.xp, 0);
  c.xp += total;
  const after = rankInfo(c.xp);
  const unlocked = UNLOCKS.filter((u) => !unlockedBefore.has(unlockId(u)) && meets(u.req, c)).map(({ kind, key, label }) => ({ kind, key, label }));
  return { career: c, award: { items, total, before, after, medal, next, newMedals, targets, unlocked, courseId: run.def?.id || null } };
}

/** Tracks one player's race as events arrive (laps, clean laps, demolitions). */
export class RunTracker {
  constructor() { this.lapsDone = 0; this.cleanLaps = 0; this.demolitions = 0; this.kills = 0; this.dirty = false; this.done = false; }

  event(e) {
    if (this.done) return;
    switch (e.type) {
      case 'scrape': case 'destroyed': case 'autoReset': this.dirty = true; break;
      case 'lap': this._lap(); break;
      case 'finish': this._lap(); this.done = true; break;
      case 'kill': if (e.demo) this.demolitions++; else this.kills++; break;
      default: break;
    }
  }

  _lap() { this.lapsDone++; if (!this.dirty) this.cleanLaps++; this.dirty = false; }

  summary() { return { lapsDone: this.lapsDone, cleanLaps: this.cleanLaps, demolitions: this.demolitions, kills: this.kills }; }
}

// ================================================================== persistence
let _cache = null;

export function loadCareer() {
  if (_cache) return _cache;
  const raw = storage.loadCareerRaw();
  _cache = normalizeCareer(raw, raw ? null : storage.records());
  if (!raw) storage.saveCareerRaw(_cache);
  return _cache;
}

/** Score a run against the saved career, save the result, and return the award. */
export function recordRun(run) {
  const { career, award } = applyRun(loadCareer(), run);
  _cache = career;
  storage.saveCareerRaw(career);
  return award;
}

/** Medal tier held on a course: 0 none, 1 bronze … 4 Starwake. */
export function medalOn(courseId, career = loadCareer()) { return career.medals[courseId] || 0; }
