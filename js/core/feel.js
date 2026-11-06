// Race "feel" glue: turns race state + events into adaptive-music targets and controller
// rumble, so the app shell only needs two hooks:
//
//   this.feel = new RaceFeel(app);       // app: { race, stage, audio, input, settings }
//   this.feel.event(e);                  // first thing in the race event handler
//   this.feel.frame(dt);                 // once per rendered frame
//
// Music: a few times a second it reads race.musicState() and calls
// audio.setRaceMusic({ intensity, lastLap, supersonic, leading }); countdown / go / finish /
// results events become audio.musicCue(...) (results switch to the menu track).
// Rumble goes through input.rumble(), which the "Controller rumble" setting gates.
// Safe to import in Node (touches nothing global at import time).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Music intensity 0..1 from a race.musicState() snapshot: speed, boost, supersonic and how
 * close the nearest rival is (track distance in a race, straight-line distance in a battle).
 */
export function raceIntensity(m) {
  if (!m) return 0.2;
  let I = 0.18 + 0.32 * smooth(0.25, 1.0, m.speedN || 0);
  if (m.boosting) I += 0.14;
  if (m.supersonic) I += 0.14;
  const gap = Number.isFinite(m.rivalGap) ? m.rivalGap : Infinity;
  const span = m.battle ? 320 : 160;
  if (gap < Infinity) I += 0.26 * (1 - clamp((gap - 15) / span, 0, 1));
  if (m.lastLap) I += 0.06;
  if (m.dead) I *= 0.6;
  return clamp(I, 0, 1);
}

/** Rumble patterns: [strength 0..1, ms] (or a list of [delayMs, strength, ms] pulses). */
export const RUMBLE = {
  padSmall: [0.16, 60],
  padBig: [0.55, 190],
  supersonic: [0.6, 260],
  demoDealt: [0.85, 240],
  nearMiss: [0.1, 45],
  finish: [[0, 0.45, 110], [170, 0.7, 280]],
};

export class RaceFeel {
  constructor(app) {
    this.app = app;
    this._race = null;
    this._acc = 0;
  }

  /** Once per frame. */
  frame(dt) {
    const app = this.app;
    const race = app.race;
    if (race !== this._race) {
      this._race = race;
      this._acc = 1;
      if (race && race.mode !== 'attract') app.audio.musicCue?.('intro');
    }
    if (!race || app.stage !== race || race.results || typeof race.musicState !== 'function') return;
    this._acc += dt;
    if (this._acc < 0.12) return; // ~8 updates a second is plenty: the sequencer smooths it
    this._acc = 0;
    const m = race.musicState();
    if (!m) return;
    app.audio.setRaceMusic?.({ intensity: raceIntensity(m), lastLap: !!m.lastLap, supersonic: !!m.supersonic, leading: !!m.leading });
  }

  /** Call with every race event (before the app's own handling). */
  event(e) {
    const a = this.app.audio;
    switch (e.type) {
      case 'countdown': a.musicCue?.('countdown', { n: e.n }); break;
      case 'go': a.musicCue?.('go'); break;
      case 'finish':
        a.musicCue?.('finish', { win: e.rank === 1 });
        this._rumble(RUMBLE.finish);
        break;
      case 'battleOver': a.musicCue?.('finish', { win: !!e.you }); break;
      case 'results': a.music('menu'); break;
      case 'boostPad': this._rumble(e.big ? RUMBLE.padBig : RUMBLE.padSmall); break;
      case 'supersonic': if (e.player) this._rumble(RUMBLE.supersonic); break;
      case 'kill': if (e.demo) this._rumble(RUMBLE.demoDealt); break;
      case 'nearMiss': this._rumble(RUMBLE.nearMiss); break;
      default: break;
    }
  }

  _rumble(p) {
    const input = this.app.input;
    if (!input || !p) return;
    if (!Array.isArray(p[0])) { input.rumble(p[0], p[1]); return; }
    for (const [delay, mag, ms] of p) {
      if (delay <= 0) input.rumble(mag, ms);
      else setTimeout(() => input.rumble(mag, ms), delay);
    }
  }
}
