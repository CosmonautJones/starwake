// The daily run: a wormhole generated from the UTC date. The id (`daily-YYYY-MM-DD`) is the
// only input, so every client builds the same course from it (it travels in the lobby like
// any course id). Each attempt draws a layout, a backdrop and features from a seeded RNG,
// then validates it with the same rules as tools/check-courses.mjs; an invalid layout is
// re-seeded (id + attempt) until one passes.
//
// Generation only uses + - * / and Math.sqrt (exact in IEEE arithmetic) plus a polynomial
// sine, so control points come out identical in every browser.

import { mulberry32, hashString } from '../core/util.js';
import { Course } from './course.js';
import { checkCourse } from './courseCheck.js';

const ID_RE = /^daily-(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_ATTEMPTS = 60;
const TAU = 6.283185307179586;

const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** Today's (or `date`'s) daily course id, by the UTC calendar. */
export function dailyCourseId(date = new Date()) {
  const d = new Date(date);
  return `daily-${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Is this a well-formed daily id for a real calendar date? */
export function isDailyId(id) {
  const m = typeof id === 'string' && ID_RE.exec(id);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** "6 Nov" for daily-2026-11-06. */
export function dailyLabel(id) {
  const m = ID_RE.exec(id || '');
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : '';
}

// Deterministic sine (no Math.sin, whose last bits differ between engines).
function dsin(x) {
  x -= TAU * Math.floor(x / TAU + 0.5);            // [-pi, pi]
  if (x > TAU / 4) x = TAU / 2 - x; else if (x < -TAU / 4) x = -TAU / 2 - x;  // [-pi/2, pi/2]
  const x2 = x * x;
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110)))));
}
const dcos = (x) => dsin(x + TAU / 4);

// Backdrops: tunnel accent, sky and a planet palette that suit each other. Accents avoid amber,
// which is reserved for gates and boost pads.
const PALETTES = [
  { name: 'tide', accent: '#5effc1', space: '#030a0a', nebula: ['#1f6b5a', '#2a3f8f'], fog: '#08131a', ambient: '#2f4a4a', sun: '#e8fff6',
    planets: [{ type: 'gas', color: '#4fa89a', color2: '#1f4a52', atmosphere: '#8fffe0', ring: '#bff0e0' }, { type: 'rocky', color: '#8a9a94', color2: '#3f4a48', atmosphere: '#c8fff0' }], kind: 'rock' },
  { name: 'orchid', accent: '#c08cff', space: '#06040c', nebula: ['#5a2a8f', '#8f2a5e'], fog: '#100a1c', ambient: '#3f3460', sun: '#f4e8ff',
    planets: [{ type: 'gas', color: '#a86bc9', color2: '#4a2a6a', atmosphere: '#e0b0ff', ring: '#d8c0f0' }, { type: 'rocky', color: '#9a8aa8', color2: '#4a3f58', atmosphere: '#e8d0ff' }], kind: 'rock' },
  { name: 'rose', accent: '#ff86c0', space: '#0a0408', nebula: ['#8f2a4a', '#2a2f8f'], fog: '#180a12', ambient: '#4a3040', sun: '#ffe8ee',
    planets: [{ type: 'rocky', color: '#c98a7a', color2: '#5a3a32', atmosphere: '#ffc0b0' }, { type: 'gas', color: '#d9a0a8', color2: '#6a3a48', atmosphere: '#ffd0e0', ring: '#f0d0d8' }], kind: 'rock' },
  { name: 'glacier', accent: '#8fe0ff', space: '#03060c', nebula: ['#2a5fa8', '#6ab0c8'], fog: '#0a1424', ambient: '#3a4a6a', sun: '#e6f0ff',
    planets: [{ type: 'ice', color: '#b4dcff', color2: '#4f7fb0', atmosphere: '#c8ecff', ring: '#d8ecff' }, { type: 'rocky', color: '#b0a8a0', color2: '#605850', atmosphere: '#ffffff' }], kind: 'ice' },
  { name: 'azure', accent: '#5ea8ff', space: '#04050d', nebula: ['#1f3f8f', '#5e2f8f'], fog: '#0a0e1f', ambient: '#33405f', sun: '#fff1dc',
    planets: [{ type: 'gas', color: '#d9a86b', color2: '#7a5a2a', atmosphere: '#ffd09a', ring: '#e8c89a' }, { type: 'rocky', color: '#8d97a8', color2: '#4b5262', atmosphere: '#9fc4ff' }], kind: 'rock' },
  { name: 'verdant', accent: '#b8ff6a', space: '#05080a', nebula: ['#2f6b1f', '#1f4a6b'], fog: '#0a120c', ambient: '#34463a', sun: '#f6ffe8',
    planets: [{ type: 'rocky', color: '#7a8a5a', color2: '#3a4228', atmosphere: '#d8ffb0' }, { type: 'gas', color: '#9ab86b', color2: '#3f5a2a', atmosphere: '#e0ffb0', ring: '#d8e8b0' }], kind: 'rock' },
];

const BANDS = {
  Easy: { radius: [64, 70], pinches: [1, 1], squeeze: [0.7, 0.76], wobble: 0.14, jitter: 0.08, points: [13, 15], height: 160, density: 0.7 },
  Medium: { radius: [58, 64], pinches: [1, 2], squeeze: [0.66, 0.72], wobble: 0.22, jitter: 0.14, points: [14, 17], height: 240, density: 1 },
  Hard: { radius: [54, 58], pinches: [2, 3], squeeze: [0.64, 0.7], wobble: 0.28, jitter: 0.2, points: [15, 19], height: 320, density: 1.2 },
};

const cache = new Map();

/** The generated def for a daily id (cached). Returns null for an id that isn't a daily one. */
export function dailyCourseDef(id, { cache: useCache = true } = {}) {
  if (!isDailyId(id)) return null;
  let def = useCache ? cache.get(id) : null;
  if (def) return def;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !def; attempt++) {
    const cand = generate(id, attempt);
    if (validate(cand)) def = cand;
  }
  if (!def) def = generate(id, 0, true); // a plain safe oval: never reached in testing
  if (!useCache) return def;
  if (cache.size > 16) cache.delete(cache.keys().next().value);
  cache.set(id, def);
  return def;
}

function validate(def) {
  const c = new Course(def);
  if (c.length < 5200 || c.length > 7600) return false;
  const r = checkCourse(c, { quick: true });
  if (!r.ok || r.stats.start < 3.5) return false;
  // Stations stand well clear of every other stretch of tube.
  for (const f of def.features) {
    if (f.type !== 'station') continue;
    const p = c.pointAt(f.at);
    for (let i = 0; i < c.sampleCount; i += 2) {
      const along = Math.abs(((i / c.sampleCount - f.at) % 1 + 1.5) % 1 - 0.5) * c.length;
      if (along > 300 && c.samples[i].distanceTo(p) < 260) return false;
    }
  }
  return true;
}

function generate(id, attempt, fallback = false) {
  // The day fixes difficulty and backdrop; each attempt re-draws the layout.
  const day = mulberry32(hashString(id));
  const roll = day();
  const difficulty = fallback ? 'Easy' : roll < 0.25 ? 'Easy' : roll < 0.7 ? 'Medium' : 'Hard';
  const band = BANDS[difficulty];
  const pal = PALETTES[Math.floor(day() * PALETTES.length) % PALETTES.length];
  const rng = mulberry32(hashString(`${id}#${attempt}`));
  const pick = (list) => list[Math.floor(rng() * list.length) % list.length];
  const range = (a, b) => a + rng() * (b - a);
  const irange = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const R = Math.round(range(band.radius[0], band.radius[1]));

  // ---- the loop: a lumpy ellipse with rolling height, one control point every ~400 m.
  const N = irange(band.points[0], band.points[1]);
  const base = range(880, 1060);
  const squash = range(0.7, 1);
  const a2 = fallback ? 0 : range(0, band.wobble), p2 = rng() * TAU;
  const a3 = fallback ? 0 : range(0, band.wobble * 0.6), p3 = rng() * TAU;
  const h1 = range(0.3, 1) * band.height, q1 = rng() * TAU;
  const h2 = range(0, 0.6) * band.height, q2 = rng() * TAU;
  const h3 = fallback ? 0 : range(0, 0.35) * band.height, q3 = rng() * TAU;
  const rot = rng() * TAU, mirror = rng() < 0.5 ? -1 : 1;
  let pts = [];
  for (let k = 0; k < N; k++) {
    const th = (k / N) * TAU + (fallback ? 0 : (rng() - 0.5) * (TAU / N) * 0.35);
    const r = base * (1 + a2 * dsin(2 * th + p2) + a3 * dsin(3 * th + p3)) * (1 + (fallback ? 0 : (rng() - 0.5) * 2 * band.jitter));
    const x = r * dcos(th), z = r * dsin(th) * squash;
    const y = h1 * dsin(th + q1) + h2 * dsin(2 * th + q2) + h3 * dsin(3 * th + q3);
    // rotate the whole loop, and fly it either way round
    pts.push([x * dcos(rot) - z * dsin(rot), y, mirror * (x * dsin(rot) + z * dcos(rot))]);
  }
  const o = pts[0];
  pts = pts.map((p) => [Math.round(p[0] - o[0]), Math.round(p[1] - o[1]), Math.round(p[2] - o[2])]);

  // ---- pinches, one of them maybe threading a station.
  const pinches = [];
  const nP = irange(band.pinches[0], band.pinches[1]);
  for (let tries = 0; pinches.length < nP && tries < 40; tries++) {
    const at = Math.round(range(0.14, 0.88) * 1000) / 1000;
    if (pinches.some((p) => Math.abs(p.at - at) < 0.16)) continue;
    pinches.push({ at, len: Math.round(range(0.035, 0.05) * 1000) / 1000, radius: Math.round(R * range(band.squeeze[0], band.squeeze[1])) });
  }
  pinches.sort((a, b) => a.at - b.at);
  const station = pinches.find((p) => p.radius <= 46 && rng() < 0.7) || null;

  // ---- what fills the tube: zones between the start and the pinches.
  const kind = pal.kind;
  const features = [{ type: 'beacons', from: 0, to: 0.06, every: 0.02 }];
  if (station) features.push({ type: 'station', at: station.at });
  const blocked = pinches.map((p) => [p.at - p.len - 0.02, p.at + p.len + 0.02]);
  const zones = [];
  let from = 0.07;
  for (const [a, b] of [...blocked, [0.95, 1]]) {
    // long stretches are cut into chunks of 0.1-0.18 of a lap, each with its own feature
    const parts = Math.max(1, Math.round((a - from) / 0.14));
    for (let k = 0; k < parts && a - from > 0.06; k++) zones.push([from + ((a - from) * k) / parts, from + ((a - from) * (k + 1)) / parts]);
    from = Math.max(from, b);
  }
  const words = new Set();
  const choices = difficulty === 'Easy' ? ['field', 'field', 'scatter', 'boulders'] : difficulty === 'Medium' ? ['field', 'field', 'scatter', 'boulders', 'mines'] : ['field', 'boulders', 'mines', 'mines', 'scatter', 'field'];
  let fields = 0;
  zones.forEach(([a, b], zi) => {
    const span = b - a;
    // at least one field of rocks or ice in every course
    const t = zi === zones.length - 1 && !fields ? 'field' : pick(choices);
    if (t === 'field') fields++;
    const k = band.density * span;
    const rd = (v) => Math.round(v * 1000) / 1000;
    if (t === 'field') {
      features.push({ type: 'field', from: rd(a), to: rd(b), count: Math.max(8, Math.round(170 * k)), kind: kind === 'ice' ? 'ice' : 'asteroid', spread: [20, 140], size: [3, kind === 'ice' ? 9 : 11] });
      words.add(kind === 'ice' ? 'drifting ice' : 'drifting rocks');
    } else if (t === 'boulders') {
      features.push({ type: 'boulders', from: rd(a), to: rd(b), count: Math.max(4, Math.round(40 * k)), size: [24, 60], clear: R, ...(kind === 'ice' ? { kind: 'ice' } : {}) });
      words.add(kind === 'ice' ? 'ice pillars' : 'rock pillars');
    } else if (t === 'mines') {
      features.push({ type: 'mines', from: rd(a), to: rd(b), count: Math.max(6, Math.round(60 * k)), spread: [6, 40] });
      words.add('a minefield');
    } else {
      const prop = pick(['cargo', 'crystal', 'satellite']);
      features.push({ type: 'scatter', prop, from: rd(a), to: rd(b), count: Math.max(3, Math.round(24 * k)), spread: [30, 110] });
      words.add({ cargo: 'cargo pods', crystal: 'crystals', satellite: 'old satellites' }[prop]);
    }
  });
  features.push({ type: 'landmark', prop: 'monolith', at: Math.round(range(0.1, 0.9) * 100) / 100, side: rng() < 0.5 ? -1 : 1, offset: R + 90, scale: 1.4 + rng() });
  const lead = rng() < 0.4;
  if (lead) features.push({ type: 'wreck', at: Math.round(range(0.15, 0.85) * 100) / 100, side: rng() < 0.5 ? -1 : 1, offset: R + 140 });

  // ---- sky and planets.
  const big = pick(pal.planets), small = pal.planets.find((p) => p !== big) || big;
  const far = (d) => [Math.round(dcos(d) * 6000), Math.round(range(-2400, 1800)), Math.round(dsin(d) * 6000)];
  const dir = rng() * TAU;
  const planets = [{ pos: far(dir), radius: Math.round(range(2200, 3000)), type: big.type, color: big.color, color2: big.color2, atmosphere: big.atmosphere,
    ...(big.ring && rng() < 0.7 ? { ring: { inner: 1.3, outer: Math.round(range(1.8, 2.3) * 10) / 10, color: big.ring, tilt: [Math.round(range(0.2, 0.6) * 100) / 100, 0, Math.round(range(-0.4, 0.4) * 100) / 100] } } : {}) }];
  if (rng() < 0.7) planets.push({ pos: far(dir + range(1.8, 4.4)), radius: Math.round(range(300, 600)), type: small.type, color: small.color, color2: small.color2, atmosphere: small.atmosphere });
  const sd = [Math.round(range(-0.6, 0.6) * 100) / 100, Math.round(range(0.3, 0.85) * 100) / 100, Math.round(range(-0.7, 0.7) * 100) / 100];
  const theme = {
    space: pal.space, nebula: pal.nebula, nebulaStrength: Math.round(range(0.4, 0.62) * 100) / 100, starDensity: Math.round(range(1, 1.4) * 10) / 10,
    sun: { dir: sd, color: pal.sun, intensity: 3.1, size: 1 },
    ambient: pal.ambient, ambientIntensity: 0.55,
    fog: { color: pal.fog, density: 0.00013 },
    planets,
    ring: pal.accent, ringNext: '#ffffff', accent: pal.accent,
  };
  const belts = [{ center: [Math.round(range(-400, 400)), 0, Math.round(range(-400, 400))], radius: 2500, thickness: 700, count: 600, inner: 1600, kind, shape: 'cloud', sizeRange: [6, 70] }];

  const width = R >= 64 ? 'A wide' : R >= 58 ? 'A' : 'A narrow';
  const planetWord = big.type === 'gas' ? (planets[0].ring ? 'a ringed gas giant' : 'a gas giant') : big.type === 'ice' ? 'an ice giant' : 'a rocky world';
  const extras = [...words].slice(0, 2);
  if (station) extras.unshift('an orbital station');
  const blurb = `${width} tube past ${planetWord}, with ${extras.length > 1 ? extras.slice(0, -1).join(', ') + ' and ' + extras[extras.length - 1] : extras[0] || 'open space'}. New every day.`;

  return {
    id, name: 'Daily run', daily: true, date: id.slice(6), dateLabel: dailyLabel(id), attempt, palette: pal.name,
    difficulty, blurb,
    tunnel: { radius: R, pinches },
    ringRadius: Math.round(Math.min(17, R * 0.26)),
    ringSpacing: Math.round(260 + (R - 54) * 5),
    points: pts,
    crossings: [], // none allowed: also turns on the "nothing pokes into another stretch" rule
    features, belts, theme,
  };
}
