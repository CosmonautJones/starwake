// localStorage persistence with a safe in-memory fallback (private mode, quota, etc.).

import { normalizeDesign, PRESETS } from '../craft/parts.js';
import { ghostKey, pruneGhosts, GHOST_BUDGET } from '../flight/ghost.js';

const KEYS = {
  designs: 'starwake.designs.v1',
  settings: 'starwake.settings.v1',
  selected: 'starwake.selected.v1',
  records: 'starwake.records.v1',
  ghosts: 'starwake.ghosts.v1',
};

export const DEFAULT_SETTINGS = {
  playerName: 'Pilot',
  masterVol: 0.8, sfxVol: 0.9, musicVol: 0.5,
  quality: 'high', fov: 72, reduceMotion: false, showFps: false,
  cameraMode: 'chase', mouseSens: 1, invertY: false, lockMouse: true,
  laps: 2, aiCount: 5, difficulty: 'normal', trackId: 'corona', trackAssist: 0.7, aimAssist: 1, flightAssist: 0.7, hazards: 0.6,
  arenaId: 'driftyard', battleBots: 5, battleTeams: false, battleTarget: 10, battleTime: 300,
  netKind: 'tabs', relayUrl: '',
  ghost: true,
};

const memory = new Map();
let available = true;
try {
  const k = '__starwake_test__';
  localStorage.setItem(k, '1');
  localStorage.removeItem(k);
} catch {
  available = false;
}

function read(key, fallback) {
  try {
    const raw = available ? localStorage.getItem(key) : memory.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  const raw = JSON.stringify(value);
  try {
    if (available) localStorage.setItem(key, raw);
    else memory.set(key, raw);
    return true;
  } catch {
    memory.set(key, raw);
    return false;
  }
}

export const storage = {
  get persistent() { return available; },

  loadSettings() { return { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) }; },
  saveSettings(s) { return write(KEYS.settings, s); },

  /** User designs only (presets are built in and read-only). */
  loadDesigns() {
    const list = read(KEYS.designs, []);
    return Array.isArray(list) ? list.map((d) => ({ ...normalizeDesign(d), id: d.id, preset: false })) : [];
  },
  saveDesigns(list) { return write(KEYS.designs, list.map((d) => ({ ...d, preset: false }))); },

  allDesigns() { return [...PRESETS, ...this.loadDesigns()]; },

  getSelectedId() { return read(KEYS.selected, PRESETS[0].id); },
  setSelectedId(id) { write(KEYS.selected, id); },
  selectedDesign() {
    const id = this.getSelectedId();
    return this.allDesigns().find((d) => d.id === id) || PRESETS[0];
  },

  records() { return read(KEYS.records, {}); },
  /** Returns {raceBest:boolean, lapBest:boolean} for celebration. */
  submitRecord(trackId, laps, raceTime, bestLap) {
    const all = this.records();
    const r = all[trackId] || {};
    const out = { raceBest: false, lapBest: false };
    const key = `race${laps}`;
    if (raceTime != null && (r[key] == null || raceTime < r[key])) { r[key] = raceTime; out.raceBest = true; }
    if (bestLap != null && (r.lap == null || bestLap < r.lap)) { r.lap = bestLap; out.lapBest = true; }
    all[trackId] = r;
    write(KEYS.records, all);
    return out;
  },

  /** Best solo run per course + lap count (see js/flight/ghost.js), or null. */
  loadGhost(trackId, laps) {
    const all = read(KEYS.ghosts, {});
    return (all && all[ghostKey(trackId, laps)]) || null;
  },
  /** Keeps the faster run; total size stays under budget (oldest dropped). Returns true if saved. */
  saveGhost(ghost) {
    if (!ghost?.course || !Number.isFinite(ghost.time)) return false;
    const all = read(KEYS.ghosts, {}) || {};
    const key = ghostKey(ghost.course, ghost.laps);
    if (all[key] && all[key].time <= ghost.time) return false;
    all[key] = ghost;
    pruneGhosts(all, GHOST_BUDGET, key);
    if (!write(KEYS.ghosts, all)) write(KEYS.ghosts, { [key]: ghost }); // over quota: keep just this one
    return true;
  },
};
