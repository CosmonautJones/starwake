// Wormhole race courses. Pure data: every client builds identical worlds from these.
//
// points:   closed loop of [x, y, z] control points for the line the wormhole follows
//           (centripetal Catmull-Rom).
// tunnel:   wormhole radius, plus `pinches` where it narrows ({ at, len, radius },
//           fractions of the lap). Stations sit on pinches so the tube threads them.
// ringRadius / ringSpacing: size and spacing of the optional boost gates.
// features: what fills the tunnel and the space around it. `at` / `from`..`to` are
//           fractions of the lap. Breakables and pickups are placed with a seeded RNG.
// theme:    sky/lighting (see js/space/sky.js for the schema) plus accent colours.

export const COURSES = [
  {
    id: 'corona',
    name: 'Corona Run',
    difficulty: 'Easy',
    blurb: 'A wide, sweeping wormhole past a ringed gas giant, threading an orbital station.',
    tunnel: { radius: 70, pinches: [{ at: 0.31, len: 0.035, radius: 44 }, { at: 0.88, len: 0.04, radius: 46 }] },
    ringRadius: 17,
    ringSpacing: 330,
    points: [
      [0, 0, 0], [40, 40, -560], [220, 120, -1080], [620, 190, -1380], [1100, 140, -1340],
      [1420, 10, -1000], [1440, -150, -500], [1150, -260, -100], [720, -230, 200], [420, -90, 600],
      [80, 60, 860], [-380, 80, 760], [-620, 20, 420], [-420, -20, 260], [-110, -10, 190],
    ],
    features: [
      { type: 'station', at: 0.31 },
      { type: 'beacons', from: 0.0, to: 0.08, every: 0.02 },
      { type: 'field', from: 0.42, to: 0.6, count: 26, kind: 'asteroid', spread: [30, 150], size: [3, 9] },
      { type: 'scatter', prop: 'satellite', from: 0.1, to: 0.3, count: 4, spread: [40, 120] },
      { type: 'scatter', prop: 'crystal', from: 0.66, to: 0.8, count: 5, spread: [35, 110] },
      { type: 'scatter', prop: 'cargo', from: 0.82, to: 0.97, count: 6, spread: [30, 90] },
      { type: 'boulders', from: 0.42, to: 0.62, count: 7, size: [28, 60], clear: 70 },
    ],
    belts: [
            { center: [400, -100, -300], radius: 2600, thickness: 600, count: 260, inner: 1900, kind: 'rock', shape: 'cloud', sizeRange: [6, 70] },
    ],
    theme: {
      space: '#04060d', nebula: ['#23408f', '#8f2f5e'], nebulaStrength: 0.5, starDensity: 1,
      sun: { dir: [0.45, 0.5, -0.75], color: '#fff1dc', intensity: 3.2, size: 1 },
      ambient: '#33405f', ambientIntensity: 0.55,
      fog: { color: '#0a0f1f', density: 0.00011 },
      planets: [
        { pos: [-5200, -900, -6400], radius: 2400, type: 'gas', color: '#c98a52', color2: '#7a4a2a', atmosphere: '#ffb37a', ring: { inner: 1.35, outer: 2.2, color: '#d9b48a', tilt: [0.4, 0, 0.2] } },
        { pos: [6200, 1800, 3200], radius: 520, type: 'rocky', color: '#8d97a8', color2: '#4b5262', atmosphere: '#9fc4ff' },
      ],
      ring: '#5ee7ff', ringNext: '#ffffff', accent: '#5ee7ff',
    },
  },
  {
    id: 'shatter',
    name: 'Shatterfield',
    difficulty: 'Medium',
    blurb: 'Debris drifts through the tunnel around a broken freighter. Blast a path or weave.',
    tunnel: { radius: 62, pinches: [{ at: 0.665, len: 0.055, radius: 44 }] },
    ringRadius: 15,
    ringSpacing: 300,
    points: [
      [0, 0, 0], [-60, -30, -520], [-260, -140, -980], [-640, -220, -1180], [-1060, -150, -1060],
      [-1260, 40, -700], [-1180, 240, -300], [-860, 320, -60], [-480, 260, 80], [-300, 120, 420],
      [-480, -40, 760], [-120, -120, 1020], [320, -60, 920], [460, 40, 520], [260, 30, 180],
    ],
    features: [
      { type: 'wreck', at: 0.36, side: 1, offset: 190 },
      { type: 'field', from: 0.06, to: 0.3, count: 46, kind: 'asteroid', spread: [20, 150], size: [3, 11] },
      { type: 'field', from: 0.52, to: 0.74, count: 40, kind: 'asteroid', spread: [20, 140], size: [3, 10] },
      { type: 'scatter', prop: 'cargo', from: 0.32, to: 0.46, count: 9, spread: [25, 120] },
      { type: 'scatter', prop: 'crystal', from: 0.78, to: 0.92, count: 6, spread: [30, 100] },
      { type: 'scatter', prop: 'satellite', from: 0.46, to: 0.52, count: 2, spread: [50, 110] },
      { type: 'boulders', from: 0.04, to: 0.32, count: 12, size: [26, 70], clear: 62 },
      { type: 'boulders', from: 0.5, to: 0.76, count: 10, size: [26, 64], clear: 62 },
      { type: 'landmark', prop: 'monolith', at: 0.88, side: -1, offset: 150, scale: 2.2 },
    ],
    belts: [
      { center: [-400, 0, -100], radius: 2300, thickness: 900, count: 900, inner: 1500, kind: 'rock', shape: 'cloud', sizeRange: [6, 80] },
    ],
    theme: {
      space: '#05070b', nebula: ['#1f5f6b', '#6b4a1f'], nebulaStrength: 0.42, starDensity: 1.2,
      sun: { dir: [-0.55, 0.35, 0.6], color: '#ffe2b8', intensity: 3.4, size: 1.2 },
      ambient: '#2f3a44', ambientIntensity: 0.5,
      fog: { color: '#0c1114', density: 0.00016 },
      planets: [
        { pos: [3800, -1400, -7200], radius: 3000, type: 'rocky', color: '#9a6b4a', color2: '#4a2f22', atmosphere: '#ffcf9a' },
      ],
      ring: '#ffc35e', ringNext: '#ffffff', accent: '#ffc35e',
    },
  },
  {
    id: 'veil',
    name: 'Ice Veil',
    difficulty: 'Hard',
    blurb: 'A narrow tube of tight vertical turns, frozen shards and a minefield.',
    tunnel: { radius: 54, pinches: [{ at: 0.3, len: 0.04, radius: 36 }, { at: 0.58, len: 0.035, radius: 40 }, { at: 0.78, len: 0.05, radius: 38 }] },
    ringRadius: 13,
    ringSpacing: 270,
    points: [
      [0, 0, 0], [0, 60, -460], [120, 260, -760], [380, 420, -720], [560, 360, -420],
      [520, 120, -180], [700, -120, -40], [980, -200, -260], [1060, -60, -620], [820, 120, -860],
      [460, 40, -1040], [140, -200, -980], [-160, -320, -640], [-300, -260, -220], [-340, -160, 140],
      [-200, -80, 380], [40, -40, 380], [120, -20, 180],
    ],
    features: [
      { type: 'station', at: 0.58 },
      { type: 'field', from: 0.14, to: 0.42, count: 40, kind: 'ice', spread: [16, 120], size: [3, 9] },
      { type: 'mines', from: 0.66, to: 0.84, count: 14, spread: [6, 40] },
      { type: 'scatter', prop: 'crystal', from: 0.86, to: 0.98, count: 6, spread: [25, 90] },
      { type: 'scatter', prop: 'cargo', from: 0.44, to: 0.54, count: 5, spread: [25, 80] },
      { type: 'boulders', from: 0.12, to: 0.44, count: 10, size: [24, 55], clear: 52, kind: 'ice' },
      { type: 'landmark', prop: 'monolith', at: 0.05, side: 1, offset: 120, scale: 1.6 },
      { type: 'beacons', from: 0.62, to: 0.66, every: 0.02 },
    ],
    belts: [
      { center: [400, 0, -400], radius: 2400, thickness: 700, count: 700, inner: 1500, kind: 'ice', shape: 'cloud', sizeRange: [6, 60] },
    ],
    theme: {
      space: '#03050c', nebula: ['#2a5fa8', '#3fa8a0'], nebulaStrength: 0.6, starDensity: 1.4,
      sun: { dir: [0.2, 0.85, 0.35], color: '#e6f0ff', intensity: 3.0, size: 0.9 },
      ambient: '#3a4a6a', ambientIntensity: 0.6,
      fog: { color: '#0a1424', density: 0.00014 },
      planets: [
        { pos: [-4200, -2600, -5200], radius: 2800, type: 'ice', color: '#a9d4ff', color2: '#4f7fb0', atmosphere: '#bfe6ff', ring: { inner: 1.3, outer: 1.8, color: '#cfe6ff', tilt: [0.4, 0.3, 0.9] } },
        { pos: [5200, 2400, -2600], radius: 300, type: 'rocky', color: '#b0a8a0', color2: '#605850', atmosphere: '#ffffff' },
      ],
      ring: '#7cf2ff', ringNext: '#ffffff', accent: '#7cf2ff',
    },
  },
];

export function getCourseDef(id) {
  return COURSES.find((c) => c.id === id) || COURSES[0];
}
