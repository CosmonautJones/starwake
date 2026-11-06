// Headless ghost + replay check. Runs a solo race with the flight-sim harness (AI pilots,
// one of them standing in for the player), records a ghost, round-trips it through JSON,
// races a second pilot against it, and checks that the replay buffer and highlight clips
// stay bounded however long the race runs.
// Run: node tools/replay-sim.mjs [courseId] [laps]
import { getCourseDef } from '../js/flight/courseDefs.js';
import { Course } from '../js/flight/course.js';
import { SpaceWorld } from '../js/flight/world.js';
import { ShipSim } from '../js/flight/ship.js';
import { FlightAI } from '../js/flight/ai.js';
import { PRESETS, computeStats } from '../js/craft/parts.js';
import { GhostRecorder, decodeGhost, pruneGhosts, ghostKey, GHOST_HZ } from '../js/flight/ghost.js';
import { ReplayBuffer, Highlights, MAX_HIGHLIGHTS, BUFFER_SECONDS, REC_HZ } from '../js/flight/replay.js';
import * as THREE from 'three';

const courseId = process.argv[2] || 'corona';
const LAPS = Number(process.argv[3] || 1);
const DT = 1 / 120, LIMIT = 240;
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

/** One race: `pilots` presets, the first is "the player". Calls onStep(t, ships) every fixed step. */
function race(def, pilots, seed, onStep) {
  const course = new Course(def);
  const world = new SpaceWorld(course);
  const ships = pilots.map((d, i) => {
    const sim = new ShipSim(course, computeStats(d).physics, course.gridSlot(i), 'p' + i);
    const e = { id: 'p' + i, index: i, design: d, sim, connected: true, input: {}, finishTime: null };
    e.ai = new FlightAI(e, world, { skill: 'hard', seed: seed + i });
    return e;
  });
  let t = 0;
  while (t < LIMIT && ships[0].finishTime == null) {
    for (const s of ships) {
      s.input = s.ai.think(DT, ships, 0);
      s.input.fire = false; s.input.missile = false;
      s.sim.step(DT, s.input, { world, racing: true, raceTime: t });
      for (const ev of s.sim.events) if (ev.type === 'lap' && s.sim.lap >= LAPS && s.finishTime == null) { s.sim.finished = true; s.finishTime = t; }
      s.sim.events.length = 0;
      s.visRoll = Math.sin(t * 3) * 0.3;
    }
    world.update(DT, ships.map((s) => ({ id: s.id, pos: s.sim.pos, dead: s.sim.dead, radius: s.sim.p.radius, local: true })));
    world.events.length = 0;
    t += DT;
    onStep(t, ships, course);
  }
  return { ships, course, t };
}

const def = getCourseDef(courseId);
console.log(`Replay + ghost check on ${def.name}, ${LAPS} lap${LAPS > 1 ? 's' : ''}`);

// ---------------------------------------------------------------- run 1: record
const rec = new GhostRecorder();
const raw = []; // full-rate truth for the player: [t, x, y, z, dist]
let buffer = null, hl = null, maxFrames = 0, bufBytes = 0, maxEvents = 0, maxClipBytes = 0, marks = 0;
const t0 = performance.now();
const run1 = race(def, [PRESETS[0], PRESETS[1], PRESETS[2], PRESETS[3]], 11, (t, ships) => {
  if (!buffer) { buffer = new ReplayBuffer(ships.length); hl = new Highlights(); bufBytes = buffer.data.byteLength; }
  const p = ships[0];
  if (p.finishTime == null) rec.tick(DT, p.sim);
  raw.push([rec.clock, p.sim.pos.x, p.sim.pos.y, p.sim.pos.z, p.sim.dist]);
  buffer.step(DT, ships);
  // A fake explosion now and then, and a highlight every few seconds of every kind.
  const step = Math.round(t / DT);
  if (step % 600 === 0) buffer.event('boom', step % 4, p.sim.pos, p.sim.vel, { demo: true });
  if (step % 420 === 0) { hl.mark(['nearMiss', 'demo', 'photo', 'demoed'][marks % 4], buffer.clock, 0); marks++; }
  hl.update(buffer);
  maxFrames = Math.max(maxFrames, buffer.size);
  maxEvents = Math.max(maxEvents, buffer.events.length);
  maxClipBytes = Math.max(maxClipBytes, hl.bytes);
});
const p1 = run1.ships[0];
check(p1.finishTime != null, `pilot finished in ${p1.finishTime?.toFixed(2)} s (${((performance.now() - t0) / 1000).toFixed(1)} s to simulate)`);
if (p1.finishTime == null) process.exit(1);

// ---------------------------------------------------------------- ghost round trip
const packed = rec.finish({ course: def.id, laps: LAPS, time: p1.finishTime, design: PRESETS[0] });
const json = JSON.stringify(packed);
const track = decodeGhost(JSON.parse(json));
check(!!track, `ghost decodes (${packed.n} samples at ${GHOST_HZ} Hz)`);
const perMin = json.length / (p1.finishTime / 60);
check(perMin < 16_000, `ghost is compact: ${(json.length / 1024).toFixed(1)} KB, ${(perMin / 1024).toFixed(1)} KB per minute`);
let maxErr = 0, minDot = 1;
for (let i = 0; i < packed.n; i++) {
  const s = rec.samples[i];
  const k = i * 3;
  maxErr = Math.max(maxErr, Math.hypot(track.pos[k] - s[0], track.pos[k + 1] - s[1], track.pos[k + 2] - s[2]));
  const q = track.quat;
  minDot = Math.min(minDot, Math.abs(q[i * 4] * s[3] + q[i * 4 + 1] * s[4] + q[i * 4 + 2] * s[5] + q[i * 4 + 3] * s[6]));
}
check(maxErr < 0.1, `position error after packing ${maxErr.toFixed(3)} (no drift)`);
check(minDot > 0.999, `orientation error ${(Math.acos(Math.min(1, minDot)) * 2 * 180 / Math.PI).toFixed(2)}°`);
const P = new THREE.Vector3(), Q = new THREE.Quaternion();
let interpErr = 0;
for (let j = 0; j < raw.length; j += 7) {
  const [t, x, y, z] = raw[j];
  if (t > track.duration || !track.sample(t, P, Q)) continue;
  interpErr = Math.max(interpErr, Math.hypot(P.x - x, P.y - y, P.z - z));
}
check(interpErr < 6, `interpolated ghost stays on the real path (max gap ${interpErr.toFixed(2)})`);
let selfDelta = 0;
for (let j = 240; j < raw.length; j += 60) {
  const [t, , , , d] = raw[j];
  if (t >= track.duration) break;
  const dd = track.delta(t, d);
  if (dd != null) selfDelta = Math.max(selfDelta, Math.abs(dd));
}
check(selfDelta < 0.12, `racing your own ghost reads ±${selfDelta.toFixed(3)} s`);

// ---------------------------------------------------------------- run 2: race the ghost
let lastDelta = null;
const run2 = race(def, [PRESETS[4], PRESETS[1], PRESETS[2], PRESETS[3]], 29, (t, ships) => {
  const p = ships[0];
  if (p.finishTime == null) { const d = track.delta(t, p.sim.dist); if (d != null) lastDelta = d; }
});
const p2 = run2.ships[0];
if (p2.finishTime != null) {
  const real = p2.finishTime - track.time;
  check(lastDelta != null && Math.abs(lastDelta - real) < 0.25, `live delta at the line ${lastDelta?.toFixed(2)} vs finish gap ${real.toFixed(2)} (${real < 0 ? 'ahead' : 'behind'})`);
} else check(false, 'second pilot finished');

// ---------------------------------------------------------------- buffer + highlights bounded
const cap = Math.ceil(BUFFER_SECONDS * REC_HZ) + 1;
check(maxFrames <= cap && buffer.data.byteLength === bufBytes, `replay buffer holds ${maxFrames}/${cap} frames, fixed ${(bufBytes / 1024).toFixed(0)} KB for ${buffer.count} ships`);
const span = buffer.frameTime(buffer.size - 1) - buffer.frameTime(0);
check(span <= BUFFER_SECONDS + 0.05 && Math.abs(buffer.frameTime(buffer.size - 1) - buffer.clock) < 1 / REC_HZ + 1e-6, `buffer covers the last ${span.toFixed(2)} s, up to now`);
check(maxEvents <= 48, `effect events kept: max ${maxEvents}`);
hl.update(buffer, true);
check(hl.clips.length <= MAX_HIGHLIGHTS && hl.clips.length > 0, `${marks} moments marked, ${hl.clips.length} clips kept (${hl.clips.map((c) => c.kind).join(', ')})`);
check(maxClipBytes < 400_000, `highlight clips peak at ${(maxClipBytes / 1024).toFixed(0)} KB`);
const clip = buffer.slice(buffer.clock - 4, buffer.clock, { kind: 'finish', at: buffer.clock - 0.8 });
const s = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
clip.sample(clip.t1, 0, s);
const newest = buffer._slot(buffer.size - 1) * buffer.stride + 1; // ship 0 in the newest frame
const lastP = new THREE.Vector3().fromArray(buffer.data, newest);
check(clip.duration > 3.8 && clip.duration < 4.2 && s.pos.distanceTo(lastP) < 0.01, `finish clip ${clip.duration.toFixed(2)} s ends on the newest frame`);
clip.sample((clip.t0 + clip.t1) / 2, 0, s);
check(Number.isFinite(s.pos.x) && Math.abs(s.quat.length() - 1) < 1e-3 && s.thrust >= 0 && s.thrust <= 1.2, 'clip samples interpolate cleanly');

// ---------------------------------------------------------------- storage budget
const all = {};
for (let i = 0; i < 40; i++) all[ghostKey('c' + (i % 7), i)] = { ...packed, course: 'c' + (i % 7), laps: i, savedAt: 1000 + i };
const keep = ghostKey('c0', 0);
pruneGhosts(all, 200_000, keep);
const size = JSON.stringify(all).length, keys = Object.keys(all);
check(size <= 200_000 && keys.includes(keep), `ghost store pruned to ${keys.length} runs, ${(size / 1024).toFixed(0)} KB, the run just saved kept`);
check(!keys.includes(ghostKey('c1', 1)) && keys.includes(ghostKey('c4', 39)), 'oldest ghosts go first');

console.log(fails ? `\n${fails} check${fails > 1 ? 's' : ''} failed` : '\nGhosts and replays OK');
process.exit(fails ? 1 : 0);
