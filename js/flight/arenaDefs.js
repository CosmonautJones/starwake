// Battle arenas. Pure data: every client builds identical worlds from these.
//
// radius:   the playable sphere. Past it a soft field pushes ships back in.
// features: placed in arena space (positions are [x, y, z]):
//   station / wreck / landmark  { pos, scale, prop? }          big cover
//   cluster  { center, radius, count, kind: 'asteroid'|'ice', size: [min, max] }  breakable rocks
//   boulders { center, radius, count, size, kind? }            unbreakable cover rocks
//   scatter  { prop: 'crystal'|'cargo'|'satellite', center, radius, count }
//   mines    { center, radius, count }
// belts:    decorative rock belts drawn outside the arena (see js/space/rocks.js).
// theme:    sky/lighting (see js/space/sky.js) plus an accent colour.

export const ARENAS = [
  {
    id: 'driftyard',
    name: 'Drift Yard',
    difficulty: 'Open',
    blurb: 'A salvage yard round a derelict station. Long sightlines, rock clusters for cover.',
    radius: 1300,
    features: [
      { type: 'station', pos: [0, 0, 0], scale: 1.5 },
      { type: 'wreck', pos: [520, 140, -380], scale: 1.1 },
      { type: 'landmark', prop: 'monolith', pos: [-640, -220, 420], scale: 2.4 },
      { type: 'cluster', center: [-480, 120, -420], radius: 260, count: 44, kind: 'asteroid', size: [3, 12] },
      { type: 'cluster', center: [560, -200, 520], radius: 240, count: 38, kind: 'asteroid', size: [3, 11] },
      { type: 'cluster', center: [40, 420, 300], radius: 200, count: 26, kind: 'asteroid', size: [3, 9] },
      { type: 'boulders', center: [-480, 120, -420], radius: 300, count: 9, size: [26, 70] },
      { type: 'boulders', center: [560, -200, 520], radius: 280, count: 8, size: [24, 64] },
      { type: 'boulders', center: [0, -380, -700], radius: 260, count: 7, size: [30, 80] },
      { type: 'scatter', prop: 'cargo', center: [300, 60, -200], radius: 260, count: 12 },
      { type: 'scatter', prop: 'crystal', center: [-300, -260, 380], radius: 240, count: 8 },
      { type: 'scatter', prop: 'satellite', center: [0, 200, 0], radius: 600, count: 6 },
      { type: 'mines', center: [0, 0, 0], radius: 400, count: 10 },
    ],
    belts: [
      { center: [0, 0, 0], radius: 2900, thickness: 700, count: 420, inner: 1900, kind: 'rock', shape: 'cloud', sizeRange: [8, 90] },
    ],
    theme: {
      space: '#05060c', nebula: ['#3b2a8f', '#8f4a2f'], nebulaStrength: 0.5, starDensity: 1.1,
      sun: { dir: [0.5, 0.45, -0.7], color: '#fff0d8', intensity: 3.3, size: 1.1 },
      ambient: '#38405a', ambientIntensity: 0.55,
      fog: { color: '#0b0d1c', density: 0.00012 },
      planets: [
        { pos: [-5600, -1200, -6000], radius: 2600, type: 'gas', color: '#b77a4f', color2: '#6a3b27', atmosphere: '#ffb37a', ring: { inner: 1.35, outer: 2.1, color: '#d9b48a', tilt: [0.35, 0, 0.25] } },
      ],
      ring: '#ff7a5e', ringNext: '#ffffff', accent: '#ff8a5e',
    },
  },
  {
    id: 'glacier',
    name: 'Glacier Halo',
    difficulty: 'Close',
    blurb: 'Frozen shards and a minefield ringing an ice moon. Tight, fast and full of ambushes.',
    radius: 1100,
    features: [
      { type: 'station', pos: [0, 120, 0], scale: 1.3 },
      { type: 'landmark', prop: 'monolith', pos: [380, -160, -260], scale: 2 },
      { type: 'landmark', prop: 'monolith', pos: [-420, 200, 300], scale: 1.8 },
      { type: 'cluster', center: [-360, -120, -320], radius: 280, count: 54, kind: 'ice', size: [3, 11] },
      { type: 'cluster', center: [380, 160, 360], radius: 260, count: 48, kind: 'ice', size: [3, 10] },
      { type: 'cluster', center: [0, -320, 420], radius: 200, count: 30, kind: 'ice', size: [3, 9] },
      { type: 'boulders', center: [-360, -120, -320], radius: 320, count: 10, size: [24, 60], kind: 'ice' },
      { type: 'boulders', center: [380, 160, 360], radius: 300, count: 9, size: [24, 56], kind: 'ice' },
      { type: 'scatter', prop: 'crystal', center: [0, 0, 0], radius: 700, count: 14 },
      { type: 'scatter', prop: 'cargo', center: [200, -200, -400], radius: 220, count: 8 },
      { type: 'mines', center: [-120, 300, -120], radius: 260, count: 16 },
    ],
    belts: [
      { center: [0, 0, 0], radius: 2500, thickness: 700, count: 600, inner: 1600, kind: 'ice', shape: 'cloud', sizeRange: [6, 70] },
    ],
    theme: {
      space: '#03050c', nebula: ['#2a5fa8', '#3fa8a0'], nebulaStrength: 0.6, starDensity: 1.4,
      sun: { dir: [0.2, 0.85, 0.35], color: '#e6f0ff', intensity: 3.0, size: 0.9 },
      ambient: '#3a4a6a', ambientIntensity: 0.6,
      fog: { color: '#0a1424', density: 0.00014 },
      planets: [
        { pos: [-4200, -2600, -5200], radius: 2800, type: 'ice', color: '#a9d4ff', color2: '#4f7fb0', atmosphere: '#bfe6ff', ring: { inner: 1.3, outer: 1.8, color: '#cfe6ff', tilt: [0.4, 0.3, 0.9] } },
      ],
      ring: '#7cf2ff', ringNext: '#ffffff', accent: '#7cf2ff',
    },
  },
];

export function getArenaDef(id) {
  return ARENAS.find((a) => a.id === id) || ARENAS[0];
}
