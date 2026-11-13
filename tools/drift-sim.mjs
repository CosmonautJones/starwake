// Racing weight checks: a drift turns tighter than plain steering and pays out a kick on
// release; a slipstream raises top speed and lingers after pulling out.
// Run: node tools/drift-sim.mjs
import * as THREE from 'three';
import { ShipSim, DRIFT } from '../js/flight/ship.js';
import { PRESETS, computeStats } from '../js/craft/parts.js';

const DT = 1 / 120;
// A dead-straight, wall-less stretch, so only the ship's own physics is under test.
const L = 1e6;
const course = {
  kind: 'course', length: L, sampleCount: 1000, step: 6, rings: [],
  locate(pos, i, out) { out.i = 0; out.u = ((-pos.z / L) % 1 + 1) % 1; out.c.set(0, 0, pos.z); out.t.set(0, 0, -1); return out; },
  tunnelRadiusAt: () => 1e5,
  pointAt: (u, v) => v.set(0, 0, -u * L),
  frameAt: (u) => ({ pos: new THREE.Vector3(0, 0, -u * L), R: new THREE.Vector3(1, 0, 0), U: new THREE.Vector3(0, 1, 0), T: new THREE.Vector3(0, 0, -1) }),
};
const SPAWN = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), u: 0 };
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`); if (!ok) bad++; };
const FWD = new THREE.Vector3(0, 0, -1);

function fresh(preset) {
  const sim = new ShipSim(course, computeStats(preset).physics, SPAWN, 'p');
  sim.vel.copy(FWD).applyQuaternion(sim.quat).multiplyScalar(sim.p.topSpeed * 0.9);
  return sim;
}
function run(sim, seconds, input, t0 = 0) {
  const events = [];
  for (let t = 0; t < seconds; t += DT) {
    sim.step(DT, { throttle: 1, brake: 0, boost: false, roll: 0, aimX: 0, aimY: 0, ...input }, { world: null, racing: true, raceTime: t0 + t });
    events.push(...sim.events.map((e) => e.type)); sim.events.length = 0;
  }
  return events;
}
const heading = (sim, q0) => new THREE.Vector3().copy(FWD).applyQuaternion(sim.quat).angleTo(new THREE.Vector3().copy(FWD).applyQuaternion(q0));

for (const preset of [PRESETS[0], PRESETS[2]]) {
  console.log(preset.name);
  // --- drift vs plain steering over the same half second
  const a = fresh(preset), b = fresh(preset);
  const q0 = a.quat.clone();
  run(a, 0.5, { aimX: 1 });
  const evB = run(b, 0.5, { aimX: 1, brake: 1 });
  check(b.drifting && evB.includes('driftStart'), 'brake + hard steer at speed starts a drift');
  check(heading(b, q0) > heading(a, q0) * 1.25, `drift turns tighter (${heading(b, q0).toFixed(2)} vs ${heading(a, q0).toFixed(2)} rad)`);
  check(b.forwardSpeed > b.p.topSpeed * DRIFT.floor * 0.9, `drift keeps its speed (${b.forwardSpeed.toFixed(0)} of ${b.p.topSpeed.toFixed(0)} m/s)`);
  // --- release: the kick
  const evHold = run(b, 0.3, { aimX: 1, brake: 1 }, 0.5);
  const evK = [...evHold, ...run(b, 0.05, {}, 0.8)];
  check(evK.includes('driftBoost') && b.kick > 0, `releasing a charged drift fires a kick (charge ${b.kick.toFixed(2)})`);
  let peak = 0;
  for (let i = 0; i < 30; i++) { run(b, 0.05, {}, 0.85 + i * 0.05); peak = Math.max(peak, b.forwardSpeed); }
  check(peak > b.p.topSpeed * 1.04, `the kick lands above top speed (${peak.toFixed(0)} vs ${b.p.topSpeed.toFixed(0)} m/s)`);
  run(b, 4, {}, 2.4);
  check(b.kick === 0 && b.forwardSpeed <= b.p.topSpeed * 1.02, 'and wears off');
  // --- a tap gives nothing
  const c = fresh(preset);
  const evC = [...run(c, 0.15, { aimX: 1, brake: 1 }), ...run(c, 0.2, {})];
  check(!evC.includes('driftBoost'), 'a brake tap gives no kick');
  // --- slipstream
  const d = fresh(preset), e = fresh(preset);
  d.tow = true;
  run(d, 3, {}); run(e, 3, {});
  check(d.draft === 1 && d.forwardSpeed > e.forwardSpeed * 1.05, `a wake raises top speed (${d.forwardSpeed.toFixed(0)} vs ${e.forwardSpeed.toFixed(0)} m/s)`);
  d.tow = false;
  run(d, 0.5, {}, 3);
  check(d.draft > 0.4, 'and lingers after pulling out (the slingshot)');
  run(d, 2, {}, 3.5);
  check(d.draft === 0, 'then fades');
}
console.log(bad ? `${bad} failed` : 'Drift and slipstream OK');
process.exit(bad ? 1 : 0);
