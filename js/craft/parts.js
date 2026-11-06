// Craft part catalog, presets, and the stat model.
//
// Every part nudges five ratings (speed, accel, handling, grip, boost) and adds mass.
// Mass is the hidden trade-off: heavy craft lose some acceleration and handling but
// gain armor (more hull, and they shrug off collisions and hits). Ratings are
// clamped to 1..10 and then mapped to physics values in computeStats().

import { clamp } from '../core/util.js';

export const BODIES = {
  dart: {
    label: 'Dart', blurb: 'Slim starfighter. Light, sharp, twitchy.',
    stats: { speed: 6, accel: 6, handling: 7, grip: 5, boost: 5 }, mass: 850, radius: 1.9,
  },
  arrow: {
    label: 'Arrow', blurb: 'Wedge racer. The all-rounder.',
    stats: { speed: 6, accel: 5, handling: 6, grip: 6, boost: 6 }, mass: 1150, radius: 2.2,
  },
  hauler: {
    label: 'Hauler', blurb: 'Cargo brick with a big heart. Steady and fast once moving.',
    stats: { speed: 8, accel: 4, handling: 5, grip: 7, boost: 6 }, mass: 2000, radius: 2.6,
  },
  glider: {
    label: 'Glider', blurb: 'Experimental lifting body. Huge top end, slippery.',
    stats: { speed: 8, accel: 4, handling: 6, grip: 4, boost: 6 }, mass: 800, radius: 2.4,
  },
  bike: {
    label: 'Hoverbike', blurb: 'An engine with a seat. Explosive off the line.',
    stats: { speed: 5, accel: 8, handling: 8, grip: 4, boost: 4 }, mass: 600, radius: 1.6,
  },
};

export const WINGS = {
  none: { label: 'None', blurb: 'Nimble but loose.', mods: { handling: 1, grip: -1 }, mass: -60 },
  swept: { label: 'Swept', blurb: 'Low drag.', mods: { speed: 1, grip: 0.5, handling: -0.5 }, mass: 120 },
  delta: { label: 'Delta', blurb: 'Planted in fast corners.', mods: { grip: 1.5, speed: 0.5, handling: -1 }, mass: 160 },
  broad: { label: 'Broad', blurb: 'Huge grip, more drag.', mods: { grip: 2.5, speed: -1, handling: -0.5 }, mass: 240 },
  xwing: { label: 'Split X', blurb: 'Agile in every direction.', mods: { handling: 1.5, grip: 1, speed: -1, boost: -0.5 }, mass: 180 },
};

export const ENGINES = {
  single: { label: 'Single', blurb: 'Efficient. Long boosts.', mods: { accel: -1, boost: 1.5, handling: 0.5 }, mass: 140 },
  twin: { label: 'Twin', blurb: 'Balanced thrust.', mods: { accel: 0.5, speed: 0.5 }, mass: 300 },
  quad: { label: 'Quad', blurb: 'Brutal thrust, heavy.', mods: { speed: 1, accel: 1.5, handling: -1, boost: -1 }, mass: 520 },
  ion: { label: 'Ion Ring', blurb: 'Strongest boost burn.', mods: { boost: 2.5, accel: -0.5, speed: 0.5, handling: -0.5 }, mass: 340 },
};

export const FINS = {
  none: { label: 'None', blurb: 'Clean lines.', mods: { handling: 0.5, grip: -0.5 }, mass: 0 },
  twin: { label: 'Twin', blurb: 'Stable at speed.', mods: { grip: 0.5, speed: 0.5, handling: -0.5 }, mass: 60 },
  tall: { label: 'Tall', blurb: 'Tracks straight.', mods: { grip: 1, handling: -0.5 }, mass: 90 },
  tri: { label: 'Tri', blurb: 'Quick to rotate.', mods: { handling: 1, grip: 0.5, speed: -1 }, mass: 100 },
};

export const COCKPITS = {
  bubble: { label: 'Bubble', blurb: 'Great view, light.', mods: { handling: 0.5 }, mass: 70 },
  canopy: { label: 'Canopy', blurb: 'Streamlined.', mods: { speed: 0.5, handling: -0.5 }, mass: 100 },
  visor: { label: 'Visor', blurb: 'Fighter-style. Punchy.', mods: { accel: 0.5, grip: -0.5 }, mass: 60 },
  armored: { label: 'Armored', blurb: 'Heavy shell.', mods: { grip: 0.5, speed: -0.5 }, mass: 260 },
};

export const SLOTS = [
  { key: 'body', label: 'Body', options: BODIES },
  { key: 'wings', label: 'Wings', options: WINGS },
  { key: 'engines', label: 'Engines', options: ENGINES },
  { key: 'fins', label: 'Fins', options: FINS },
  { key: 'cockpit', label: 'Cockpit', options: COCKPITS },
];

export const STAT_KEYS = [
  { key: 'speed', label: 'Top speed' },
  { key: 'accel', label: 'Acceleration' },
  { key: 'handling', label: 'Handling' },
  { key: 'grip', label: 'Grip' },
  { key: 'boost', label: 'Boost' },
  { key: 'armor', label: 'Armor' },
];

export const PAINT_SWATCHES = [
  '#e8eeff', '#9aa6c8', '#2a3150', '#121a3a', '#3cf0ff', '#2f7bff', '#b84bff', '#ff4fa3',
  '#ff5a4a', '#ffb547', '#ffe45c', '#5cff8a', '#2fd6a0', '#ff8a3c', '#7a5cff', '#f4f4f4',
];

export const PRESETS = [
  {
    id: 'preset-comet', preset: true, name: 'Comet', body: 'arrow', wings: 'swept', engines: 'twin', fins: 'twin', cockpit: 'canopy',
    colors: { primary: '#e8eeff', secondary: '#2f7bff', glow: '#3cf0ff' },
  },
  {
    id: 'preset-wasp', preset: true, name: 'Wasp', body: 'dart', wings: 'xwing', engines: 'single', fins: 'tri', cockpit: 'bubble',
    colors: { primary: '#ffe45c', secondary: '#1b1f33', glow: '#ff8a3c' },
  },
  {
    id: 'preset-mule', preset: true, name: 'Mule', body: 'hauler', wings: 'broad', engines: 'quad', fins: 'tall', cockpit: 'armored',
    colors: { primary: '#ff8a3c', secondary: '#3a3f55', glow: '#ffb547' },
  },
  {
    id: 'preset-wisp', preset: true, name: 'Wisp', body: 'glider', wings: 'delta', engines: 'ion', fins: 'none', cockpit: 'visor',
    colors: { primary: '#b84bff', secondary: '#f4f4f4', glow: '#ff4fa3' },
  },
  {
    id: 'preset-skiff', preset: true, name: 'Skiff', body: 'bike', wings: 'none', engines: 'twin', fins: 'twin', cockpit: 'visor',
    colors: { primary: '#5cff8a', secondary: '#121a3a', glow: '#2fd6a0' },
  },
];

const DEFAULT_DESIGN = PRESETS[0];

/** Fill in any missing/invalid fields so stale saves never crash the game. */
export function normalizeDesign(d) {
  const out = { ...DEFAULT_DESIGN, ...(d || {}) };
  out.colors = { ...DEFAULT_DESIGN.colors, ...((d && d.colors) || {}) };
  for (const slot of SLOTS) {
    if (!slot.options[out[slot.key]]) out[slot.key] = DEFAULT_DESIGN[slot.key];
  }
  for (const k of ['primary', 'secondary', 'glow']) {
    if (!/^#[0-9a-fA-F]{6}$/.test(out.colors[k])) out.colors[k] = DEFAULT_DESIGN.colors[k];
  }
  out.name = String(out.name || 'Unnamed').slice(0, 18);
  return out;
}

/** Global speed scale (1 = the original arcade pace). */
export const PACE = 0.65;

export function computeStats(design) {
  const d = normalizeDesign(design);
  const body = BODIES[d.body];
  const parts = [WINGS[d.wings], ENGINES[d.engines], FINS[d.fins], COCKPITS[d.cockpit]];
  const r = { ...body.stats };
  let mass = body.mass;
  for (const p of parts) {
    mass += p.mass;
    for (const [k, v] of Object.entries(p.mods)) r[k] = (r[k] || 0) + v;
  }
  // Mass effect relative to a mid-weight craft.
  const dm = (mass - 1500) / 1000;
  r.accel -= dm * 1.0;
  r.handling -= dm * 0.8;
  r.speed += dm * 0.3; // momentum carries
  r.armor = 1.5 + ((mass - 500) / 2400) * 8.5;

  const ratings = {};
  for (const k of ['speed', 'accel', 'handling', 'grip', 'boost', 'armor']) {
    ratings[k] = clamp(Math.round(r[k] * 10) / 10, 1, 10);
  }

  // Free-flight physics. Units are metres and seconds. PACE scales the whole game's
  // speed: lower is more cinematic (more time to see, aim and dodge).
  const physics = {
    topSpeed: (150 + ratings.speed * 8) * PACE, // ~103..150
    accel: (45 + ratings.accel * 8) * PACE, // thrust acceleration
    turnRate: (1.25 + ratings.handling * 0.12) * 0.88, // pitch/yaw rad/s at full stick
    rollRate: (2.2 + ratings.handling * 0.16) * 0.85,
    response: 3.4 + ratings.handling * 0.42, // how fast turning reaches the commanded rate
    assist: 1.4 + ratings.grip * 0.42, // flight assist: how fast velocity swings onto the nose
    brake: 140 * PACE,
    boostMul: 1.3 + ratings.boost * 0.025,
    boostDrain: 0.36 - ratings.boost * 0.018,
    boostRegen: 0.8 + ratings.boost * 0.04,
    armor: ratings.armor / 10, // 0.1..1 — damage and collision resistance
    hull: Math.round((60 + ratings.armor * 9) * 1.25),
    shield: 62,
    radius: body.radius,
  };
  return { ratings, mass: Math.round(mass), physics };
}

/** Random but sensible design, used for AI opponents. */
const CRAFT_NAMES = ['Halcyon', 'Brightwing', 'Ironside', 'Sundog', 'Nightjar', 'Lodestar', 'Firefly', 'Paragon', 'Cinder', 'Mirage', 'Tempest', 'Gossamer', 'Kingfisher', 'Vagrant'];

export function randomDesign(rng, pilotName) {
  const name = CRAFT_NAMES[Math.floor(rng() * CRAFT_NAMES.length)];
  const pick = (obj) => {
    const keys = Object.keys(obj);
    return keys[Math.floor(rng() * keys.length)];
  };
  const base = PRESETS[Math.floor(rng() * PRESETS.length)];
  const design = {
    id: 'ai-' + Math.floor(rng() * 1e9).toString(36),
    name,
    body: pick(BODIES), wings: pick(WINGS), engines: pick(ENGINES), fins: pick(FINS), cockpit: pick(COCKPITS),
    colors: { ...base.colors },
  };
  // Hue-shift colors from swatches for variety.
  design.colors.primary = PAINT_SWATCHES[Math.floor(rng() * PAINT_SWATCHES.length)];
  const glows = ['#3cf0ff', '#ff4fa3', '#ffb547', '#5cff8a', '#b84bff', '#ff5a4a', '#ffe45c', '#2f7bff'];
  design.colors.glow = glows[Math.floor(rng() * glows.length)];
  design.colors.secondary = ['#1b1f33', '#2a3150', '#e8eeff', '#9aa6c8'][Math.floor(rng() * 4)];
  return normalizeDesign(design);
}
