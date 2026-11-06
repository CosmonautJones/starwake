// Geometry rules every wormhole course must pass. Shared by tools/check-courses.mjs and the
// daily-course generator (which re-seeds until a layout passes). Pure logic, no rendering.
//
// - every bend at least 1.6x wider than the tube there;
// - no two far-apart stretches of tube within 25 m of each other, except where the course
//   declares an intentional close pass in def.crossings ({ a, b, span, clearance }: stretches
//   round lap fractions a and b, +-span, may come within `clearance` m wall to wall);
// - a ship flying anywhere inside the tube is always located on its own stretch;
// - gates inside the tube and clear of split dividers; the start straight fairly straight;
// - with a world and pads: pads inside the tube, nothing intruding into another stretch.

export const RULES = { bend: 1.6, gap: 25, alongMin: 400, startBend: 2.5, startLen: 150 };

const ring = (d) => { d = Math.abs(d) % 1; return Math.min(d, 1 - d); };

/** Turn radius at each sample (from the circle through samples i-k, i, i+k). */
function bendRadii(c, k = 5) {
  const n = c.sampleCount, S = c.samples, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = S[(i - k + n) % n], b = S[i], d = S[(i + k) % n];
    const ab = a.distanceTo(b), bd = b.distanceTo(d), ad = a.distanceTo(d);
    const s = (ab + bd + ad) / 2;
    const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bd) * (s - ad)));
    out[i] = area > 1e-6 ? (ab * bd * ad) / (4 * area) : Infinity;
  }
  return out;
}

function declaredCrossing(def, ua, ub) {
  for (const x of def.crossings || []) {
    const span = x.span ?? 0.05;
    if ((ring(ua - x.a) <= span && ring(ub - x.b) <= span) || (ring(ua - x.b) <= span && ring(ub - x.a) <= span)) return x;
  }
  return null;
}

/**
 * @param {import('./course.js').Course} c
 * @param {{ world?: import('./world.js').SpaceWorld, pads?: import('./pads.js').BoostPads, quick?: boolean }} opts
 *   quick: stop at the first problem (used by the daily generator).
 * @returns {{ ok: boolean, problems: string[], stats: object }}
 */
export function checkCourse(c, { world = null, pads = null, quick = false } = {}) {
  const def = c.def, n = c.sampleCount, S = c.samples, L = c.length, step = L / n;
  const problems = [];
  const stats = { length: Math.round(L), gates: c.rings.length };
  const radius = new Float32Array(n);
  for (let i = 0; i < n; i++) radius[i] = c.tunnelRadiusAt(i / n);

  // 1. Bends vs tube radius, and a straight-ish start.
  const bend = bendRadii(c);
  let minR = Infinity, at = 0, worst = Infinity, worstAt = 0, startMin = Infinity;
  const startK = Math.ceil(RULES.startLen / step);
  for (let i = 0; i < n; i++) {
    if (bend[i] < minR) { minR = bend[i]; at = i / n; }
    const ratio = bend[i] / radius[i];
    if (ratio < worst) { worst = ratio; worstAt = i / n; }
    if (i <= startK || i >= n - startK) startMin = Math.min(startMin, ratio);
  }
  Object.assign(stats, { tightest: Math.round(minR), tightestAt: +at.toFixed(2), worst: +worst.toFixed(2), worstAt: +worstAt.toFixed(2), start: +startMin.toFixed(1) });
  if (worst < RULES.bend) problems.push(`bend too tight for the tube (${worst.toFixed(2)}x at u=${worstAt.toFixed(2)})`);
  if (startMin < RULES.startBend) problems.push(`start straight bends too much (${startMin.toFixed(1)}x tube)`);
  if (quick && problems.length) return { ok: false, problems, stats };

  // 2. Far-apart stretches of tube: closest wall-to-wall gap (full resolution).
  let minGap = Infinity, pair = null, minCross = Infinity, crossPair = null;
  const alongK = Math.ceil(RULES.alongMin / step);
  const undeclared = new Map(); // one report per neighbourhood (problems come in runs of samples)
  const report = (i, j, msg) => { const k = Math.round((i / n) * 20) + '/' + Math.round((j / n) * 20); if (!undeclared.has(k)) undeclared.set(k, msg); };
  for (let i = 0; i < n; i++) {
    const A = S[i], Ri = radius[i];
    for (let j = i + alongK; j < n; j++) {
      if (n - (j - i) < alongK) break;
      const B = S[j];
      const dx = A.x - B.x, dy = A.y - B.y, dz = A.z - B.z;
      const d2 = dx * dx + dy * dy + dz * dz, sum = Ri + radius[j];
      if (d2 >= (sum + RULES.gap) * (sum + RULES.gap)) {
        // far enough: only track the closest gap for the report
        if (minGap > RULES.gap && d2 < (sum + minGap) * (sum + minGap)) { minGap = Math.sqrt(d2) - sum; pair = [i / n, j / n]; }
        continue;
      }
      const gap = Math.sqrt(d2) - sum;
      const x = declaredCrossing(def, i / n, j / n);
      if (x) {
        if (gap < minCross) { minCross = gap; crossPair = [i / n, j / n]; }
        if (gap < (x.clearance ?? 8)) report(i, j, `crossing at u=${(i / n).toFixed(2)}/${(j / n).toFixed(2)} only ${gap.toFixed(1)} m apart (needs ${x.clearance ?? 8})`);
      } else {
        if (gap < minGap) { minGap = gap; pair = [i / n, j / n]; }
        report(i, j, `two stretches of tube ${gap < 0 ? 'overlap' : 'too close'} at u=${(i / n).toFixed(2)} and u=${(j / n).toFixed(2)}`);
        if (quick) break;
      }
    }
    if (quick && undeclared.size) break;
  }
  stats.minGap = pair ? Math.round(minGap) : null;
  stats.gapAt = pair ? pair.map((u) => u.toFixed(2)).join(',') : null;
  if (crossPair) { stats.crossGap = +minCross.toFixed(1); stats.crossAt = crossPair.map((u) => u.toFixed(2)).join(','); }
  problems.push(...[...undeclared.values()].slice(0, 5));
  if (quick && problems.length) return { ok: false, problems, stats };

  // 3. Locate never jumps stretches: fly a corkscrew near the wall round the whole lap,
  // locating from the last hint with the ship's walk cap, and from scratch.
  {
    const out = { i: 0, u: 0, c: S[0].clone(), t: S[0].clone() };
    const p = S[0].clone();
    let hint = 0, jumps = 0, wrongCold = 0, worstJump = 0;
    const dirs = quick ? 3 : 6;
    for (let d = 0; d < dirs; d++) {
      hint = 0;
      for (let s = 0; s < L; s += 4) {
        const u = s / L;
        const f = c.frameAt(u);
        const R = c.tunnelRadiusAt(u) - 3;
        const a = d * (Math.PI * 2 / dirs) + s * 0.004;
        const r = R * (0.55 + 0.4 * Math.abs(Math.sin(s * 0.002 + d)));
        p.copy(f.pos).addScaledVector(f.R, Math.cos(a) * r).addScaledVector(f.U, Math.sin(a) * r);
        c.locate(p, hint, out, Math.ceil((4 * 2 + 30) / step));
        hint = out.i;
        const err = ring(out.u - u) * L;
        worstJump = Math.max(worstJump, err);
        if (err > R + 20) jumps++;
        if ((s / 4) % 7 === 0) { const g = c.nearestU(p); if (ring(g.u - u) * L > R + 20) wrongCold++; }
      }
    }
    stats.locateErr = Math.round(worstJump);
    if (jumps) problems.push(`locate jumped to another stretch ${jumps} time(s)`);
    if (wrongCold) problems.push(`a point inside the tube is nearer another stretch (${wrongCold} samples)`);
  }

  // 4. Gates inside the tube, clear of dividers.
  let outside = 0, onDivider = 0;
  for (const g of c.rings) {
    if (c.nearestU(g.pos).dist + g.radius > c.tunnelRadiusAt(g.u) - 2) outside++;
    const sp = c.splitAt(g.u, 30 / L);
    if (sp) {
      const f = c.frameAt(g.u);
      const lat = g.pos.clone().sub(f.pos).dot(sp.axis === 'up' ? f.U : f.R) * sp.side;
      if (lat + g.radius > sp.offset - sp.thick - 2) onDivider++;
    }
  }
  if (outside) problems.push(`${outside} gate(s) poke out of the tube`);
  if (onDivider) problems.push(`${onDivider} gate(s) cross a split divider`);

  // 4b. Stations: the tube must fit through the station's bore (inner ring at ~52 m).
  for (const f of def.features || []) {
    if (f.type === 'station' && c.tunnelRadiusAt(f.at) > 48) problems.push(`station at u=${f.at} is narrower than the tube (needs a pinch of 48 m or less)`);
  }

  // 5. Splits: full width all along the divider, both channels wide enough.
  for (const sp of c.splits) {
    for (let u = sp.u0; u <= sp.u1; u += 10 / L) if (c.tunnelRadiusAt(u) < sp.width - 0.5) { problems.push(`split ${sp.index} divider sticks out of the widening`); break; }
    if (sp.riskHalf * 2 < 30) problems.push(`split ${sp.index} risky channel too tight (${(sp.riskHalf * 2).toFixed(0)} m)`);
    if (sp.width - sp.offset - sp.thick < 28) problems.push(`split ${sp.index} risky channel too tight`);
  }

  // 6. World: pads inside the tube, objects never intruding into another stretch.
  if (pads) {
    let bad = 0;
    for (const pd of pads.pads) {
      const out = c.nearestU(pd.pos, pd.u, 0.02);
      if (out.dist + pd.radius > c.tunnelRadiusAt(out.u) - 1) bad++;
    }
    stats.pads = pads.pads.length;
    if (bad) problems.push(`${bad} pad(s) outside the tube`);
  }
  if (world) {
    let intrude = 0;
    for (const it of world.items) {
      if (it.u == null) continue;
      for (const col of it.colliders) {
        const g = c.nearestU(col);
        if (ring(g.u - it.u) * L < 300) continue;
        if (g.dist < c.tunnelRadiusAt(g.u) + col.r) { intrude++; break; }
      }
    }
    stats.items = world.items.length;
    if (intrude) problems.push(`${intrude} object(s) intrude into another stretch of tube`);
  }
  return { ok: problems.length === 0, problems, stats };
}
