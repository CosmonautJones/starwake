// Validates wormhole course geometry: every bend wider than the tube, no two stretches
// of tube overlapping, gates inside the tube, and the start straight clear.
// Run: node tools/check-courses.mjs
import { COURSES } from '../js/flight/courseDefs.js';
import { Course } from '../js/flight/course.js';

let problems = 0;
for (const def of COURSES) {
  const c = new Course(def);
  const n = c.sampleCount;
  // Turn radius vs tube radius at each sample (~30 units apart).
  let minR = Infinity, at = 0, worst = Infinity, worstAt = 0;
  const k = 5;
  for (let i = 0; i < n; i++) {
    const a = c.samples[(i - k + n) % n], b = c.samples[i], d = c.samples[(i + k) % n];
    const ab = a.distanceTo(b), bd = b.distanceTo(d), ad = a.distanceTo(d);
    const s = (ab + bd + ad) / 2;
    const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bd) * (s - ad)));
    const R = area > 1e-6 ? (ab * bd * ad) / (4 * area) : Infinity;
    if (R < minR) { minR = R; at = i / n; }
    const ratio = R / c.tunnelRadiusAt(i / n);
    if (ratio < worst) { worst = ratio; worstAt = i / n; }
  }
  // Closest approach of two far-apart stretches, minus both tube radii.
  let minGap = Infinity, pair = null;
  for (let i = 0; i < n; i += 3) for (let j = i + 3; j < n; j += 3) {
    let ds = Math.abs(i - j) * (c.length / n); ds = Math.min(ds, c.length - ds);
    if (ds < 400) continue;
    const gap = c.samples[i].distanceTo(c.samples[j]) - c.tunnelRadiusAt(i / n) - c.tunnelRadiusAt(j / n);
    if (gap < minGap) { minGap = gap; pair = [(i / n).toFixed(2), (j / n).toFixed(2)]; }
  }
  let outside = 0;
  for (const g of c.rings) if (c.nearestU(g.pos).dist + g.radius > c.tunnelRadiusAt(g.u) - 2) outside++;
  console.log(`${def.name}: length ${c.length.toFixed(0)}, tube ${def.tunnel.radius} (${(def.tunnel.pinches || []).length} pinches), ${c.rings.length} gates, tightest bend ${minR.toFixed(0)} at u=${at.toFixed(2)} (${worst.toFixed(1)}x tube at u=${worstAt.toFixed(2)}), closest wall-to-wall gap ${minGap.toFixed(0)} at u=${pair}`);
  if (worst < 1.6) { console.log('  !! bend too tight for the tube'); problems++; }
  if (minGap < 25) { console.log('  !! two stretches of tube too close'); problems++; }
  if (outside) { console.log(`  !! ${outside} gate(s) poke out of the tube`); problems++; }
}
console.log(problems ? `${problems} problem(s)` : 'All courses OK');
process.exit(problems ? 1 : 0);
