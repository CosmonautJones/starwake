// Starwake audio: everything is synthesized with the Web Audio API.
// No audio files, no dependencies.
//
// Bus graph:
//   one-shots + engine -> sfxBus -----------------------------\
//   (combat one-shots go through a per-shot bus: gain [-> lowpass] [-> pan] -> sfxBus)
//   music tracks -> musicBus (x MUSIC_MIX) -> dip -> duck -----> master -> compressor -> limiter -> destination
//   music delay send -> delay <-> feedback -> musicBus /
//
// Usage:
//   const audio = new AudioEngine();
//   input.onAnyInput(() => audio.unlock());
//   audio.setVolumes({ master: 0.8, sfx: 1, music: 0.6 });
//   audio.music('menu');
//   // every frame while racing:
//   audio.setEngine({ active: true, speedN, throttle, boost });   // drift/supersonic/wall/scraping/grind optional
//   audio.has('bump')  // -> true when play('bump') is a known sound
//   audio.play('gate');
//   audio.play('laser', { volume: 0.6, pan: -0.3 });
//   audio.play('explosion', { size: 0.8, distance: 0.2 });
//   // adaptive race music (see the Music section):
//   audio.setRaceMusic({ intensity: 0.7, lastLap: false, supersonic: true, leading: true });
//   audio.musicCue('countdown', { n: 3 }); audio.musicCue('go'); audio.musicCue('finish', { win: true });
//
// If Web Audio is unavailable (or the context cannot be created) every method
// silently does nothing.

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : undefined;

/** Music sits under the sfx/engine even at music volume 1.0. */
const MUSIC_MIX = 0.3;
/** Hard ceiling on simultaneously sounding voices, music included (safety valve). */
const MAX_VOICES = 192;
/** Combat one-shots stop starting new voices above this, leaving headroom for the music. */
const SFX_VOICES = 150;
/** Minimum gap (seconds) between repeats of throttled sounds. */
const GAPS = {
  wall: 0.08,
  hover: 0.08,
  laser: 0.018,
  laserHit: 0.025,
  shieldHit: 0.06,
  hullHit: 0.07,
  shieldDown: 0.6,
  missileLaunch: 0.08,
  locking: 0.05,
  locked: 0.25,
  missileWarn: 0.3,
  explosion: 0.04,
  shatter: 0.03,
  pickup: 0.06,
  ring: 0.05,
  missedRing: 0.15,
  overheat: 0.35,
  boostStart: 0.15,
  passBy: 0.07,
  nearMiss: 0.12,
  sonicBoom: 0.5,
  demolition: 0.08,
  bump: 0.06,
  boostPad: 0.08,
  dodge: 0.15,
  deflect: 0.05,
  debris: 0.035,
};
/** Max simultaneously sounding instances per name; extras are dropped. */
const CAPS = { laser: 8, laserHit: 6, shieldHit: 4, hullHit: 4, explosion: 6, shatter: 8, missileLaunch: 4, passBy: 4, debris: 6, demolition: 3, bump: 4, deflect: 4 };
/** Smallest value we ever exponential-ramp to (0 is illegal for exp ramps). */
const SILENT = 0.0001;

/** One-shots routed through a per-shot bus (volume / pan / distance filter). */
const COMBAT = {
  laser: 1,
  laserHit: 1,
  shieldHit: 1,
  hullHit: 1,
  shieldDown: 1,
  missileLaunch: 1,
  locking: 1,
  locked: 1,
  missileWarn: 1,
  explosion: 1,
  shatter: 1,
  pickup: 1,
  ring: 1,
  missedRing: 1,
  overheat: 1,
  boostStart: 1,
  passBy: 1,
  nearMiss: 1,
  sonicBoom: 1,
  demolition: 1,
  bump: 1,
  boostPad: 1,
  dodge: 1,
  deflect: 1,
  debris: 1,
};
/** Names that are distance-filtered like 'explosion' (opts.distance 0..1 = near..far). */
const DISTANT = { explosion: 1, sonicBoom: 1, demolition: 1, passBy: 1, debris: 1, bump: 1 };
/** Every name play() knows (see has()). */
const KNOWN = new Set([
  'click', 'hover', 'back', 'countdown', 'go', 'gate', 'lap', 'finalLap', 'wall', 'hazard', 'pad', 'driftBoost',
  'respawn', 'finish', 'win', 'lose', 'join', 'leave', 'ready', 'error', 'wallGrind',
  ...Object.keys(COMBAT),
]);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const smoothstep = (a, b, x) => {
  const k = clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

// ---------------------------------------------------------------------------
// Music material (MIDI note numbers).

const MENU = {
  bpm: 96,
  // A minor: Am - F - C - G
  chords: [
    [57, 60, 64],
    [53, 57, 60],
    [55, 60, 64],
    [55, 59, 62],
  ],
  roots: [45, 41, 48, 43],
};

const RACE = {
  bpm: 128,
  // E minor: Em - C - G - D
  chords: [
    [52, 55, 59],
    [52, 55, 60],
    [55, 59, 62],
    [54, 57, 62],
  ],
  roots: [40, 36, 43, 38],
  // Leader melody, eighths per bar over Em - C - G - D (0 = rest); played an octave up.
  melody: [
    [71, 0, 0, 67, 0, 69, 71, 0],
    [72, 0, 71, 0, 67, 0, 64, 0],
    [74, 0, 71, 0, 67, 0, 71, 74],
    [78, 0, 76, 74, 0, 69, 0, 0],
  ],
};

/** Adaptive race track layers (each has its own gain; 'kick' bypasses the pump + filter). */
const LAYERS = ['kick', 'bass', 'pad', 'hats', 'clap', 'arp', 'drive', 'lead', 'melody'];
const LV_COUNTDOWN = { kick: 1, pad: 1, hats: 1 };
const LV_OUTRO = { pad: 1, bass: 1, arp: 1 };
/** Last-lap lead, per 16th: 0-2 = chord tones, 3-4 = the first two an octave up. */
const LEAD_PAT = [0, 1, 2, 3, 2, 1, 2, 4, 0, 2, 1, 3, 4, 3, 2, 1];
/** Finish cadence bVI - bVII - I in E: a win lands on E major, otherwise E minor. */
const STING_WIN = [[60, 64, 67, 72], [62, 66, 69, 74], [64, 68, 71, 76, 83]];
const STING_LOSE = [[60, 64, 67, 72], [62, 66, 69, 74], [64, 67, 71, 76]];

export class AudioEngine {
  /**
   * opts.context (testing): an existing (e.g. Offline) AudioContext to build into. It is treated
   * as always live, so play()/setEngine() schedule straight away; music is not started.
   */
  constructor(opts = {}) {
    this.ctx = null;
    this._disabled = !AC;
    this._vol = { master: 0.8, sfx: 1, music: 0.7 };
    this._voices = 0;
    this._lastPlay = Object.create(null);
    this._musicWanted = null; // kind requested (may be before unlock)
    this._tracks = []; // active/fading music tracks
    this._current = null; // the track for _musicWanted
    this._timer = 0;
    this._ducked = false;
    this._resumeAt = -1e9; // ms timestamp of the last resume() request
    this._eng = null;
    this._rng = mulberry(0x5eed);
    this._srng = Math.random; // sfx variation (keeps the music's seeded sequence intact)
    this._active = Object.create(null); // name -> live per-shot buses
    this._buses = 0; // live per-shot buses (all names)
    this._grindHold = 0; // play('wallGrind', {level}) hold level
    this._grindAt = -1e9;
    this._offline = false;
    // Adaptive race music: wanted state (setRaceMusic), phase from cues, last stinger time.
    this._rm = { intensity: 0.2, lastLap: false, supersonic: false, leading: false };
    this._rmPhase = 'countdown';
    this._lv = {};
    this._stingerMs = -1e9;
    if (opts && opts.context) {
      this.ctx = opts.context;
      this._offline = true;
      this._disabled = false;
      this._build();
    }
  }

  /** True when play(name) is a known sound (unknown names are silently ignored by play). */
  has(name) {
    return KNOWN.has(name);
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /** Create/resume the AudioContext. Call from a user gesture. Idempotent. */
  unlock() {
    if (this._disabled || this._offline) return;
    if (!this.ctx) {
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        try {
          this.ctx = new AC();
        } catch (e2) {
          this._disabled = true;
          this.ctx = null;
          return;
        }
      }
      try {
        this._build();
      } catch (e) {
        // Something about this browser's Web Audio is broken: go silent.
        this._disabled = true;
        try {
          this.ctx.close();
        } catch (e2) {
          /* ignore */
        }
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') {
      this._resumeAt = nowMs();
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    if (this._musicWanted && !this._current) this._startTrack(this._musicWanted);
  }

  /**
   * True when the audio clock is running (or a resume was requested in the last
   * 250ms). While suspended the clock is frozen, so anything scheduled would pile
   * up and fire all at once on resume - we drop it instead.
   */
  _live() {
    const c = this.ctx;
    if (!c) return false;
    if (this._offline) return true;
    return c.state === 'running' || nowMs() - this._resumeAt < 250;
  }

  /** Build the static graph (buses, noise buffer, engine voice). */
  _build() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 3;
    this.compressor.attack.value = 0.006;
    this.compressor.release.value = 0.2;
    // Brick-wall-ish safety limiter after the glue compressor: big stacks (demolition + sonic
    // boom + engine roar) never clip the output.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.09;
    this.compressor.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.connect(this.compressor);

    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);

    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = this._ducked ? 0.35 : 1;
    this.duckGain.connect(this.master);

    // Short music dips under big explosions so they punch through.
    this.dipGain = ctx.createGain();
    this.dipGain.connect(this.duckGain);

    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.dipGain);

    // Shared tempo-synced echo for the music.
    this.delay = ctx.createDelay(1.5);
    this.delay.delayTime.value = 0.35;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.34;
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 2600;
    this.delayWet = ctx.createGain();
    this.delayWet.gain.value = 0.5;
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayTone.connect(this.delayWet);
    this.delayWet.connect(this.musicBus);

    // 2 seconds of white noise, shared by every noise voice.
    const len = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Afterburner crackle: 2 s of sparse random pops (decaying noise bursts), looped.
    this.crackle = ctx.createBuffer(1, len, ctx.sampleRate);
    const cd = this.crackle.getChannelData(0);
    const sr = ctx.sampleRate;
    for (let tpos = 0; tpos < len; ) {
      tpos += Math.floor((-Math.log(1 - Math.random() * 0.999) / 95) * sr) + 1; // ~95 pops/s
      const amp = (0.25 + Math.random() * 0.75) * (Math.random() < 0.12 ? 1 : 0.55);
      const dec = (0.0006 + Math.random() * 0.0035) * sr;
      const n = Math.min(len - tpos, Math.floor(dec * 5));
      for (let k = 0; k < n; k++) cd[tpos + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / dec);
    }
    for (let i = 0; i < len; i++) cd[i] = Math.max(-1, Math.min(1, cd[i]));

    // Soft-clip curves for the engine grit.
    this._curveSoft = shaperCurve(2.2);
    this._curveHard = shaperCurve(6);

    this._applyVolumes(now, 0.01);
    this._buildEngine();
  }

  // -------------------------------------------------------------------------
  // Volumes / ducking

  /** Set bus volumes (each 0..1). Missing keys keep their value. */
  setVolumes(v = {}) {
    if (!v) return;
    this._vol.master = clamp(num(v.master, this._vol.master), 0, 1);
    this._vol.sfx = clamp(num(v.sfx, this._vol.sfx), 0, 1);
    this._vol.music = clamp(num(v.music, this._vol.music), 0, 1);
    if (this.ctx) this._applyVolumes(this.ctx.currentTime, 0.05);
  }

  _applyVolumes(t, tc) {
    // Perceptual-ish curve: squared slider value.
    const m = this._vol.master;
    const s = this._vol.sfx;
    const mu = this._vol.music;
    this.master.gain.setTargetAtTime(m * m, t, tc);
    this.sfxBus.gain.setTargetAtTime(s * s, t, tc);
    this.musicBus.gain.setTargetAtTime(mu * mu * MUSIC_MIX, t, tc);
  }

  /** Lower music (pause/results). */
  duck(on) {
    this._ducked = !!on;
    if (!this.ctx) return;
    this.duckGain.gain.setTargetAtTime(this._ducked ? 0.35 : 1, this.ctx.currentTime, 0.2);
  }

  // -------------------------------------------------------------------------
  // Continuous engine

  _buildEngine() {
    const ctx = this.ctx;
    const e = {};
    const sfx = this.sfxBus;

    e.out = ctx.createGain();
    e.out.gain.value = 0;
    e.out.connect(sfx);

    // Core turbine: two detuned saws + a square sub through a resonant lowpass.
    e.filter = ctx.createBiquadFilter();
    e.filter.type = 'lowpass';
    e.filter.frequency.value = 400;
    e.filter.Q.value = 3.5;
    e.tone = ctx.createGain();
    e.tone.gain.value = 0;
    e.filter.connect(e.tone);
    e.tone.connect(e.out);

    e.oscA = ctx.createOscillator();
    e.oscA.type = 'sawtooth';
    e.oscB = ctx.createOscillator();
    e.oscB.type = 'sawtooth';
    e.oscB.detune.value = 11;
    e.sub = ctx.createOscillator();
    e.sub.type = 'square';
    e.subGain = ctx.createGain();
    e.subGain.gain.value = 0.45;
    e.oscA.connect(e.filter);
    e.oscB.connect(e.filter);
    e.sub.connect(e.subGain);
    e.subGain.connect(e.filter);

    // High turbine whine (sine, several harmonics up).
    e.whine = ctx.createOscillator();
    e.whine.type = 'sine';
    e.whineGain = ctx.createGain();
    e.whineGain.gain.value = 0;
    e.whine.connect(e.whineGain);
    e.whineGain.connect(e.out);

    // Air rush: band-passed noise that opens up with speed.
    e.air = ctx.createBufferSource();
    e.air.buffer = this.noise;
    e.air.loop = true;
    e.airFilter = ctx.createBiquadFilter();
    e.airFilter.type = 'bandpass';
    e.airFilter.frequency.value = 700;
    e.airFilter.Q.value = 0.6;
    e.airGain = ctx.createGain();
    e.airGain.gain.value = 0;
    e.air.connect(e.airFilter);
    e.airFilter.connect(e.airGain);
    e.airGain.connect(e.out);

    // Boost layer: bright hiss + a buzzy upper oscillator.
    e.bNoise = ctx.createBufferSource();
    e.bNoise.buffer = this.noise;
    e.bNoise.loop = true;
    e.bNoise.playbackRate.value = 0.83; // decorrelate from the air layer
    e.bFilter = ctx.createBiquadFilter();
    e.bFilter.type = 'highpass';
    e.bFilter.frequency.value = 2600;
    e.bNoiseGain = ctx.createGain();
    e.bNoiseGain.gain.value = 0;
    e.bNoise.connect(e.bFilter);
    e.bFilter.connect(e.bNoiseGain);
    e.bNoiseGain.connect(e.out);

    e.bOsc = ctx.createOscillator();
    e.bOsc.type = 'sawtooth';
    e.bOscFilter = ctx.createBiquadFilter();
    e.bOscFilter.type = 'bandpass';
    e.bOscFilter.frequency.value = 1800;
    e.bOscFilter.Q.value = 2;
    e.bOscGain = ctx.createGain();
    e.bOscGain.gain.value = 0;
    e.bOsc.connect(e.bOscFilter);
    e.bOscFilter.connect(e.bOscGain);
    e.bOscGain.connect(e.out);

    // Drift warble: LFO on pitch (cents) and a little on the filter.
    e.lfo = ctx.createOscillator();
    e.lfo.type = 'sine';
    e.lfo.frequency.value = 7;
    e.lfoPitch = ctx.createGain();
    e.lfoPitch.gain.value = 0;
    e.lfoFilt = ctx.createGain();
    e.lfoFilt.gain.value = 0;
    e.lfo.connect(e.lfoPitch);
    e.lfo.connect(e.lfoFilt);
    e.lfoPitch.connect(e.oscA.detune);
    e.lfoPitch.connect(e.oscB.detune);
    e.lfoPitch.connect(e.whine.detune);
    e.lfoFilt.connect(e.filter.frequency);

    // ---- Pod-racer layers -------------------------------------------------
    // Rumble: a low saw driven into a soft clipper, amplitude-fluttered by a fast LFO so it
    // rips ("brrrap") instead of humming. Flutter rate climbs with speed.
    const mk = (type) => { const o = ctx.createOscillator(); o.type = type; return o; };
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filt = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const shaper = (curve) => { const w = ctx.createWaveShaper(); w.curve = curve; w.oversample = '2x'; return w; };
    e.rum = mk('sawtooth');
    e.rumDrive = gain(1.5);
    e.rumShape = shaper(this._curveSoft);
    e.rumLP = filt('lowpass', 420, 0.9);
    e.rumAM = gain(0.62);
    e.rumGain = gain(0);
    e.rum.connect(e.rumDrive); e.rumDrive.connect(e.rumShape); e.rumShape.connect(e.rumLP);
    e.rumLP.connect(e.rumAM); e.rumAM.connect(e.rumGain); e.rumGain.connect(e.out);
    e.flut = mk('triangle');
    e.flut.frequency.value = 22;
    e.flutDepth = gain(0.3);
    e.flut.connect(e.flutDepth); e.flutDepth.connect(e.rumAM.gain);
    // Rasp: saw + square a twelfth apart, overdriven and band-passed: the grit of the roar.
    e.rasp = mk('sawtooth');
    e.rasp2 = mk('square');
    e.rasp2Gain = gain(0.45);
    e.raspDrive = gain(2);
    e.raspShape = shaper(this._curveHard);
    e.raspBP = filt('bandpass', 1100, 1.1);
    e.raspAM = gain(0.75);
    e.raspGain = gain(0);
    e.rasp.connect(e.raspDrive); e.rasp2.connect(e.rasp2Gain); e.rasp2Gain.connect(e.raspDrive);
    e.raspDrive.connect(e.raspShape); e.raspShape.connect(e.raspBP); e.raspBP.connect(e.raspAM); e.raspAM.connect(e.raspGain); e.raspGain.connect(e.out);
    e.flutRasp = gain(0.2);
    e.flut.connect(e.flutRasp); e.flutRasp.connect(e.raspAM.gain);
    // Scream: high resonant whine with vibrato (the turbine screaming at the top end).
    e.scr = mk('sawtooth');
    e.scrBP = filt('bandpass', 2400, 7);
    e.scrGain = gain(0);
    e.scr.connect(e.scrBP); e.scrBP.connect(e.scrGain); e.scrGain.connect(e.out);
    e.vib = mk('sine');
    e.vib.frequency.value = 5.3;
    e.vibDepth = gain(9);
    e.vib.connect(e.vibDepth); e.vibDepth.connect(e.scr.detune); e.vibDepth.connect(e.whine.detune);
    // Supersonic compression: shrieking resonant noise + a heavy low roar that slams in.
    e.ssNoise = ctx.createBufferSource(); e.ssNoise.buffer = this.noise; e.ssNoise.loop = true; e.ssNoise.playbackRate.value = 1.17;
    e.ssBP = filt('bandpass', 3800, 5);
    e.ssGain = gain(0);
    e.ssNoise.connect(e.ssBP); e.ssBP.connect(e.ssGain); e.ssGain.connect(e.out);
    e.ssLP = filt('lowpass', 170, 0.8);
    e.ssLow = gain(0);
    e.ssNoise.connect(e.ssLP); e.ssLP.connect(e.ssLow); e.ssLow.connect(e.out);
    // Afterburner crackle (boost): looped sparse pops, high-passed.
    e.crk = ctx.createBufferSource(); e.crk.buffer = this.crackle; e.crk.loop = true;
    e.crkHP = filt('highpass', 700, 0.7);
    e.crkGain = gain(0);
    e.crk.connect(e.crkHP); e.crkHP.connect(e.crkGain); e.crkGain.connect(e.out);
    // Wall grind: two resonant metal bands chopped by a fast saw LFO + a thudding sub.
    e.grN = ctx.createBufferSource(); e.grN.buffer = this.noise; e.grN.loop = true; e.grN.playbackRate.value = 0.91;
    e.grBP = filt('bandpass', 1600, 4);
    e.grBP2 = filt('bandpass', 4300, 6);
    e.grBP2Gain = gain(0.6);
    e.grAM = gain(0.55);
    e.grGain = gain(0);
    e.grN.connect(e.grBP); e.grN.connect(e.grBP2); e.grBP2.connect(e.grBP2Gain);
    e.grBP.connect(e.grAM); e.grBP2Gain.connect(e.grAM); e.grAM.connect(e.grGain); e.grGain.connect(e.out);
    e.grLfo = mk('sawtooth'); e.grLfo.frequency.value = 31;
    e.grLfoDepth = gain(0.45);
    e.grLfo.connect(e.grLfoDepth); e.grLfoDepth.connect(e.grAM.gain);
    e.grSub = mk('sine'); e.grSub.frequency.value = 52;
    e.grSubGain = gain(0);
    e.grSub.connect(e.grSubGain); e.grSubGain.connect(e.out);
    e.grLfoDepthSub = gain(0);
    e.grLfo.connect(e.grLfoDepthSub); e.grLfoDepthSub.connect(e.grSubGain.gain);
    // Wall rush: near the wall the air roar thickens (canyon-run proximity).
    e.wrN = ctx.createBufferSource(); e.wrN.buffer = this.noise; e.wrN.loop = true; e.wrN.playbackRate.value = 0.67;
    e.wrBP = filt('bandpass', 900, 0.9);
    e.wrGain = gain(0);
    e.wrN.connect(e.wrBP); e.wrBP.connect(e.wrGain); e.wrGain.connect(e.out);

    const t = ctx.currentTime;
    for (const n of [e.oscA, e.oscB, e.sub, e.whine, e.bOsc, e.lfo, e.rum, e.flut, e.rasp, e.rasp2, e.scr, e.vib, e.grLfo, e.grSub]) n.start(t);
    e.air.start(t, Math.random() * 1.5);
    e.bNoise.start(t, Math.random() * 1.5);
    for (const n of [e.ssNoise, e.crk, e.grN, e.wrN]) n.start(t, Math.random() * 1.5);

    // Last-sent targets so per-frame calls skip redundant automation events.
    e.last = new Float32Array(48).fill(-1);
    this._eng = e;
  }

  /**
   * Continuous engine. Call every frame. Fields after `boost` are optional:
   *   drift      bool   warble (legacy)
   *   supersonic bool   adds the scream/compression layer
   *   wall       0..1   proximity to the tunnel wall (1 = touching): thickens the air roar
   *   scraping   bool|0..1  wall contact: drives the grind layer (with speed)
   *   grind      0..1   explicit grind level (overrides scraping); play('wallGrind', {level}) also works
   * @param {{active:boolean, speedN:number, throttle:number, boost:boolean, drift?:boolean,
   *   supersonic?:boolean, wall?:number, scraping?:boolean|number, grind?:number}} s
   */
  setEngine(s) {
    const e = this._eng;
    // Automation events added while suspended would never be pruned: skip.
    if (!e || !s || !this._live()) return;
    const t = this.ctx.currentTime;
    const active = !!s.active;
    const sp = clamp(num(s.speedN, 0), 0, 1.5);
    const th = clamp(num(s.throttle, 0), 0, 1);
    const boost = active && !!s.boost;
    const drift = active && !!s.drift;
    const ss = active && !!s.supersonic;
    const wall = active ? clamp(num(s.wall, 0), 0, 1) : 0;
    const scr = typeof s.scraping === 'number' ? clamp(num(s.scraping, 0), 0, 1) : s.scraping ? 1 : 0;
    let grind = s.grind !== undefined ? clamp(num(s.grind, 0), 0, 1) : scr * (0.45 + 0.55 * Math.min(1, sp));
    if (t - this._grindAt < 0.2) grind = Math.max(grind, this._grindHold);
    if (!active) grind = 0;
    const sp1 = sp > 1 ? 1 : sp;
    const tc = 0.06;

    // Pitch: a turbine spinning up, not a gearbox.
    const base = 46 + 150 * sp + 22 * th + (boost ? 18 : 0) + (ss ? 14 : 0);
    this._tgt(e.oscA.frequency, 0, base, t, tc);
    this._tgt(e.oscB.frequency, 1, base * 1.003, t, tc);
    this._tgt(e.sub.frequency, 2, base * 0.5, t, tc);
    this._tgt(e.whine.frequency, 3, base * 6.02, t, tc);
    this._tgt(e.bOsc.frequency, 4, base * 3.01, t, tc);

    // Timbre.
    const cutoff = 260 + 2100 * sp + 700 * th + (boost ? 1400 : 0);
    this._tgt(e.filter.frequency, 5, cutoff, t, tc);
    this._tgt(e.airFilter.frequency, 6, 600 + 2600 * sp1, t, 0.12);

    // Levels (the original turbine core sits a little lower now: the pod layers carry the roar).
    this._tgt(e.tone.gain, 7, 0.07 + 0.05 * th + 0.03 * sp1, t, tc);
    this._tgt(e.whineGain.gain, 8, 0.005 + 0.02 * sp1 * (0.6 + 0.4 * th) + (ss ? 0.012 : 0), t, tc);
    this._tgt(e.airGain.gain, 9, 0.015 + 0.13 * Math.pow(sp1, 1.5) + (sp > 1 ? 0.06 * (sp - 1) : 0), t, 0.1);
    this._tgt(e.bNoiseGain.gain, 10, boost ? 0.06 : 0, t, boost ? 0.03 : 0.12);
    this._tgt(e.bOscGain.gain, 11, boost ? 0.024 : 0, t, boost ? 0.03 : 0.12);

    // Drift warble.
    this._tgt(e.lfoPitch.gain, 12, drift ? 28 : 0, t, 0.08);
    this._tgt(e.lfoFilt.gain, 13, drift ? cutoff * 0.18 : 0, t, 0.08);

    // Master fade in/out (~0.3s to silence when inactive).
    this._tgt(e.out.gain, 14, active ? 0.55 : 0, t, active ? 0.08 : 0.09);

    // ---- pod layers
    const rumF = 28 + 52 * sp + 14 * th + (boost ? 8 : 0);
    this._tgt(e.rum.frequency, 15, rumF, t, tc);
    this._tgt(e.flut.frequency, 16, 17 + 30 * sp + 10 * th + (boost ? 9 : 0), t, 0.1);
    this._tgt(e.flutDepth.gain, 17, 0.2 + 0.18 * th + (boost ? 0.1 : 0), t, 0.1);
    this._tgt(e.rumDrive.gain, 18, 1.2 + 2.2 * th + (boost ? 1.5 : 0), t, tc);
    this._tgt(e.rumLP.frequency, 19, 260 + 520 * sp1 + 380 * th + (boost ? 300 : 0), t, tc);
    this._tgt(e.rumGain.gain, 20, 0.09 + 0.07 * th + 0.04 * sp1 + (boost ? 0.03 : 0), t, tc);
    const raspF = base * 2.01;
    this._tgt(e.rasp.frequency, 21, raspF, t, tc);
    this._tgt(e.rasp2.frequency, 22, raspF * 1.498, t, tc);
    this._tgt(e.raspDrive.gain, 23, 1.2 + 3.5 * th + (boost ? 3 : 0), t, tc);
    this._tgt(e.raspBP.frequency, 24, 650 + 1700 * sp1 + 500 * th + (boost ? 600 : 0), t, tc);
    this._tgt(e.raspGain.gain, 25, (0.012 + 0.03 * th + 0.018 * sp1 + (boost ? 0.02 : 0)) * (active ? 1 : 0), t, tc);
    this._tgt(e.scr.frequency, 26, base * 4.0, t, tc);
    this._tgt(e.scrBP.frequency, 27, Math.min(9000, base * 12), t, tc);
    this._tgt(e.scrGain.gain, 28, 0.004 + 0.02 * Math.pow(sp1, 2) * (0.5 + 0.5 * th) + (boost ? 0.01 : 0) + (ss ? 0.03 : 0), t, tc);
    this._tgt(e.ssGain.gain, 29, ss ? 0.05 + 0.03 * Math.max(0, sp - 1) : 0, t, ss ? 0.05 : 0.15);
    this._tgt(e.ssBP.frequency, 30, 3000 + 2200 * sp1, t, 0.1);
    this._tgt(e.ssLow.gain, 31, ss ? 0.22 : 0, t, ss ? 0.04 : 0.2);
    this._tgt(e.crk.playbackRate, 32, 0.8 + 0.55 * sp1, t, 0.1);
    this._tgt(e.crkGain.gain, 33, boost ? 0.16 + 0.06 * sp1 : 0.012 * th * sp1, t, boost ? 0.03 : 0.1);
    // grind (metal on the wall), pitched up with speed
    this._tgt(e.grGain.gain, 34, grind * 0.22, t, grind > 0 ? 0.025 : 0.08);
    this._tgt(e.grBP.frequency, 35, 1200 + 1200 * sp1, t, 0.05);
    this._tgt(e.grBP2.frequency, 36, 3600 + 1800 * sp1, t, 0.05);
    this._tgt(e.grLfo.frequency, 37, 24 + 30 * sp1, t, 0.08);
    this._tgt(e.grSubGain.gain, 38, grind * 0.1, t, 0.04);
    this._tgt(e.grLfoDepthSub.gain, 39, grind * 0.09, t, 0.04);
    // wall proximity roar (only when really close)
    const wr = Math.pow(Math.max(0, (wall - 0.6) / 0.4), 2) * Math.min(1, sp * 1.2);
    this._tgt(e.wrGain.gain, 40, wr * 0.14, t, 0.08);
    this._tgt(e.wrBP.frequency, 41, 600 + 1400 * sp1, t, 0.1);
  }

  /** setTargetAtTime, skipped when the target hasn't meaningfully changed. */
  _tgt(param, idx, value, t, tc) {
    const last = this._eng.last;
    const prev = last[idx];
    const diff = value - prev;
    if (prev >= 0 && diff < 1e-4 * (prev + 1) && diff > -1e-4 * (prev + 1)) return;
    last[idx] = value;
    param.setTargetAtTime(value, t, tc);
  }

  // -------------------------------------------------------------------------
  // One-shot building blocks

  /** True if a new voice may be created now. */
  _ok() {
    return !!this.ctx && this._voices < MAX_VOICES;
  }

  /** Disconnect `nodes` once `src` ends (and release the voice's per-shot bus). */
  _track(src, nodes, bus) {
    this._voices++;
    if (bus) bus.refs++;
    src.onended = () => {
      this._voices--;
      for (let i = 0; i < nodes.length; i++) {
        try {
          nodes[i].disconnect();
        } catch (e) {
          /* already disconnected */
        }
      }
      src.onended = null;
      if (bus) {
        bus.refs--;
        if (bus.sealed && bus.refs <= 0) this._closeBus(bus);
      }
    };
  }

  /**
   * Per-shot output bus: gain (volume) [-> lowpass] [-> stereo pan] -> sfxBus.
   * Returns null when the name's concurrency cap is reached or the volume is ~0.
   * Voices route into it with { bus }; call _seal(bus) after creating them.
   */
  _bus(name, vol, pan, lowpass) {
    const cap = CAPS[name];
    const live = this._active[name] || 0;
    if (cap && live >= cap) return null;
    if (!(vol > 0.001)) return null;
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = vol;
    const nodes = [input];
    let last = input;
    if (lowpass && lowpass < 18000) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      f.Q.value = 0.5;
      last.connect(f);
      last = f;
      nodes.push(f);
    }
    if (pan && Math.abs(pan) > 0.01 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      last.connect(p);
      last = p;
      nodes.push(p);
    }
    last.connect(this.sfxBus);
    this._active[name] = live + 1;
    this._buses++;
    return { name, in: input, nodes, refs: 0, sealed: false, closed: false };
  }

  /** All voices for `bus` have been created: close it when they've all ended. */
  _seal(bus) {
    if (!bus) return;
    bus.sealed = true;
    if (bus.refs <= 0) this._closeBus(bus);
  }

  _closeBus(bus) {
    if (bus.closed) return;
    bus.closed = true;
    this._active[bus.name]--;
    this._buses--;
    for (let i = 0; i < bus.nodes.length; i++) {
      try {
        bus.nodes[i].disconnect();
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** Briefly lower the music (0..1 depth) so a big sound punches through. */
  _dip(depth, t, hold) {
    const g = this.dipGain && this.dipGain.gain;
    if (!g) return;
    const lvl = clamp(1 - depth, 0.2, 1);
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t);
    else {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
    }
    g.setTargetAtTime(lvl, t, 0.015);
    g.setTargetAtTime(1, t + hold, 0.35);
  }

  /** Attack / hold / exponential release envelope on a GainNode. Returns end time. */
  _env(g, t, peak, attack, hold, release) {
    const p = g.gain;
    p.setValueAtTime(SILENT, t);
    p.linearRampToValueAtTime(peak, t + attack);
    p.setValueAtTime(peak, t + attack + hold);
    p.exponentialRampToValueAtTime(SILENT, t + attack + hold + release);
    return t + attack + hold + release;
  }

  /**
   * Oscillator voice.
   * o: { f, f2?, sweep?, type?, t?, a?, h?, r?, g?, det?, ft?, ff?, ff2?, fq?, dest? }
   *   f/f2   start/end frequency (exp sweep over `sweep` seconds, default a+h)
   *   a/h/r  attack/hold/release seconds; g peak gain
   *   ft/ff/ff2/fq optional filter type/freq/end freq/Q
   */
  _tone(o) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = o.t !== undefined ? o.t : ctx.currentTime;
    const a = o.a !== undefined ? o.a : 0.005;
    const h = o.h !== undefined ? o.h : 0.05;
    const r = o.r !== undefined ? o.r : 0.12;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.sweep !== undefined ? o.sweep : a + h));
    if (o.det) osc.detune.setValueAtTime(o.det, t);
    const g = ctx.createGain();
    const end = this._env(g, t, o.g !== undefined ? o.g : 0.15, a, h, r);
    const nodes = [osc, g];
    if (o.ft) {
      const f = ctx.createBiquadFilter();
      f.type = o.ft;
      f.frequency.setValueAtTime(o.ff, t);
      if (o.ff2) f.frequency.exponentialRampToValueAtTime(o.ff2, end);
      if (o.fq) f.Q.value = o.fq;
      osc.connect(f);
      f.connect(g);
      nodes.push(f);
    } else {
      osc.connect(g);
    }
    g.connect(o.dest || (o.bus ? o.bus.in : this.sfxBus));
    if (o.send) g.connect(o.send);
    osc.start(t);
    osc.stop(end + 0.03);
    this._track(osc, nodes, o.bus);
  }

  /**
   * Filtered noise voice.
   * o: { t?, a?, h?, r?, g?, ft?, ff, ff2?, fq?, rate?, dest? }
   */
  _noise(o) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const t = o.t !== undefined ? o.t : ctx.currentTime;
    const a = o.a !== undefined ? o.a : 0.003;
    const h = o.h !== undefined ? o.h : 0.04;
    const r = o.r !== undefined ? o.r : 0.1;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    if (o.rate) src.playbackRate.value = o.rate;
    const f = ctx.createBiquadFilter();
    f.type = o.ft || 'lowpass';
    f.frequency.setValueAtTime(o.ff, t);
    f.Q.value = o.fq || 0.7;
    const g = ctx.createGain();
    const end = this._env(g, t, o.g !== undefined ? o.g : 0.15, a, h, r);
    if (o.ff2) f.frequency.exponentialRampToValueAtTime(o.ff2, end);
    src.connect(f);
    f.connect(g);
    g.connect(o.dest || (o.bus ? o.bus.in : this.sfxBus));
    src.start(t, Math.random() * 1.8);
    src.stop(end + 0.03);
    this._track(src, [src, f, g], o.bus);
  }

  /** Bright chime note: triangle + quiet sine an octave up. */
  _chime(f, t, g, h, r, bus) {
    this._tone({ f, t, type: 'triangle', a: 0.004, h, r, g, bus });
    this._tone({ f: f * 2, t, type: 'sine', a: 0.004, h: h * 0.5, r: r * 0.8, g: g * 0.35, bus });
  }

  /** Brassy synth note: two detuned saws through a lowpass that closes. */
  _brass(f, t, g, h, r) {
    const o = { f, t, type: 'sawtooth', a: 0.02, h, r, g: g * 0.5, ft: 'lowpass', ff: 3200, ff2: 900, fq: 1.2 };
    this._tone(o);
    o.det = 9;
    this._tone(o);
    this._tone({ f: f * 0.5, t, type: 'square', a: 0.02, h, r, g: g * 0.25, ft: 'lowpass', ff: 1200 });
  }

  // -------------------------------------------------------------------------
  // One-shots

  /**
   * Play a named one-shot.
   * Menu/race: click hover back countdown go gate lap finalLap wall hazard pad driftBoost
   *   respawn finish win lose join leave ready error
   * Combat (all take opts.volume 0..1, default 1; opts.pan -1..1 optional):
   *   laser laserHit shieldHit hullHit shieldDown missileLaunch locking locked missileWarn
   *   explosion {size, distance} shatter {size, kind: rock|ice|metal|crystal}
   *   pickup {kind: boost|missile|shield} ring {streak 0..10} missedRing overheat boostStart
   *   explosion also takes {ship: true} (or size > 1, up to 1.5): the big ship-death version
   * Speed / Rocket-League layer (also opts.volume, opts.pan; opts.distance 0..1 = near..far muffles
   * and quietens where noted *):
   *   passBy* {pan -1..1 side it passes on, speed (0..1.5 normalised, or m/s if > 3), kind: 'ship'|'rock'}
   *   nearMiss {pan}   sonicBoom* {}   demolition* {}   bump* {intensity 0..1}
   *   boostPad {big: bool}   dodge {pan}   deflect {pan}   debris* {size 0..1, kind: 'metal'|'rock'}
   *   wallGrind {level 0..1}: not a one-shot - holds the engine's grind layer at `level` for 0.2 s,
   *     so call it every frame while grinding (or pass grind/scraping to setEngine instead).
   * Unknown names are ignored; has(name) tells you which exist.
   * @param {string} name
   * @param {{intensity?:number, kind?:string, volume?:number, pan?:number, size?:number,
   *   distance?:number, streak?:number}} [opts]
   */
  play(name, opts = {}) {
    // While suspended the clock is frozen: queued sounds would all fire at once on resume.
    // A resume requested by unlock() moments ago is fine: those play as soon as it lands.
    if (!this._live()) return;
    const now = this.ctx.currentTime;
    if (name === 'wallGrind') {
      this._grindHold = clamp(num(opts && opts.level, 0.7), 0, 1);
      this._grindAt = now;
      return;
    }
    const gap = GAPS[name];
    if (gap) {
      const last = this._lastPlay[name];
      if (last !== undefined && now - last < gap && now >= last) return;
    }
    const t = now + 0.005;
    const o = opts || {};
    if (COMBAT[name]) {
      const vol = clamp(num(o.volume, 1), 0, 1);
      let pan = num(o.pan, 0);
      let lowpass = 0;
      let v = vol;
      if (DISTANT[name]) {
        const d = clamp(num(o.distance, 0), 0, 1);
        v *= name === 'passBy' || name === 'debris' || name === 'bump' ? Math.pow(1 - d, 1.6) : 1 - 0.8 * d;
        if (d > 0.02) lowpass = 350 + 15000 * Math.pow(1 - d, 2.5);
      }
      if (this._voices >= SFX_VOICES) return; // swamped: drop rather than starve the music
      const bus = this._bus(name, v, pan, lowpass);
      if (!bus) return; // capped or silent: dropped (and doesn't consume the throttle gap)
      if (gap) this._lastPlay[name] = now;
      try {
        this._combat(name, o, t, bus);
      } finally {
        this._seal(bus);
      }
      return;
    }
    if (gap) this._lastPlay[name] = now;
    switch (name) {
      case 'click':
        this._tone({ f: 1500, f2: 1050, t, type: 'triangle', a: 0.002, h: 0.012, r: 0.05, g: 0.17 });
        this._noise({ t, ft: 'highpass', ff: 5000, a: 0.001, h: 0.004, r: 0.02, g: 0.04 });
        break;
      case 'hover':
        this._tone({ f: 2300, t, type: 'sine', a: 0.003, h: 0.004, r: 0.035, g: 0.045 });
        break;
      case 'back':
        this._tone({ f: 760, f2: 430, t, type: 'triangle', a: 0.003, h: 0.04, r: 0.08, g: 0.16 });
        break;
      case 'countdown':
        this._tone({ f: 660, t, type: 'square', a: 0.004, h: 0.11, r: 0.08, g: 0.07, ft: 'lowpass', ff: 2400 });
        this._tone({ f: 660, t, type: 'sine', a: 0.004, h: 0.11, r: 0.1, g: 0.12 });
        break;
      case 'go':
        this._tone({ f: 1320, t, type: 'square', a: 0.004, h: 0.28, r: 0.25, g: 0.06, ft: 'lowpass', ff: 4200 });
        this._tone({ f: 1320, t, type: 'sine', a: 0.004, h: 0.28, r: 0.3, g: 0.13 });
        this._tone({ f: 2640, t, type: 'sine', a: 0.004, h: 0.15, r: 0.25, g: 0.04 });
        break;
      case 'gate':
        this._chime(1318.5, t, 0.12, 0.04, 0.2);
        this._chime(1760, t + 0.07, 0.13, 0.06, 0.32);
        this._noise({ t, ft: 'highpass', ff: 7000, a: 0.01, h: 0.03, r: 0.18, g: 0.03 });
        break;
      case 'lap': {
        const n = [1046.5, 1318.5, 1568];
        for (let i = 0; i < n.length; i++) this._chime(n[i], t + i * 0.085, 0.12, i === 2 ? 0.12 : 0.04, i === 2 ? 0.4 : 0.15);
        break;
      }
      case 'finalLap': {
        const n = [880, 1046.5, 1318.5, 1760];
        for (let k = 0; k < 2; k++) {
          for (let i = 0; i < n.length; i++) {
            const tt = t + (k * 4 + i) * 0.06;
            this._tone({ f: n[i], t: tt, type: 'sawtooth', a: 0.003, h: 0.03, r: 0.07, g: 0.07, ft: 'lowpass', ff: 3500, fq: 2 });
            this._tone({ f: n[i] * 2, t: tt, type: 'sine', a: 0.003, h: 0.02, r: 0.06, g: 0.04 });
          }
        }
        this._chime(1760, t + 0.48, 0.1, 0.1, 0.35);
        break;
      }
      case 'wall': {
        const i = clamp(num(o.intensity, 0.5), 0, 1);
        if (i < 0.02) break;
        // Thud.
        this._tone({ f: 120, f2: 45, t, type: 'sine', a: 0.003, h: 0.03, r: 0.07 + 0.08 * i, g: 0.08 + 0.28 * i });
        // Body.
        this._noise({ t, ft: 'lowpass', ff: 400 + 1800 * i, ff2: 220, a: 0.002, h: 0.02 + 0.06 * i, r: 0.06 + 0.12 * i, g: 0.06 + 0.22 * i });
        // Metallic scrape.
        this._noise({ t, ft: 'bandpass', ff: 2200, ff2: 900, fq: 3, a: 0.005, h: 0.04 + 0.08 * i, r: 0.08, g: 0.02 + 0.07 * i });
        break;
      }
      case 'hazard':
        if (o.kind === 'mine') {
          this._tone({ f: 130, f2: 32, sweep: 0.5, t, type: 'sine', a: 0.003, h: 0.08, r: 0.6, g: 0.42 });
          this._noise({ t, ft: 'lowpass', ff: 3200, ff2: 140, a: 0.002, h: 0.06, r: 0.75, g: 0.34 });
          this._noise({ t, ft: 'highpass', ff: 3000, a: 0.001, h: 0.01, r: 0.12, g: 0.08 });
        } else {
          // Rocky crunch (asteroid / default).
          this._tone({ f: 95, f2: 40, t, type: 'sine', a: 0.002, h: 0.03, r: 0.15, g: 0.26 });
          this._noise({ t, ft: 'lowpass', ff: 1100, ff2: 200, a: 0.002, h: 0.05, r: 0.22, g: 0.3 });
          for (let k = 0; k < 3; k++) {
            this._noise({ t: t + 0.015 + k * 0.035 + this._rng() * 0.02, ft: 'bandpass', ff: 1800 + this._rng() * 1800, fq: 4, a: 0.001, h: 0.008, r: 0.04, g: 0.1 });
          }
        }
        break;
      case 'pad':
        this._noise({ t, ft: 'bandpass', ff: 380, ff2: 4500, fq: 1.6, a: 0.04, h: 0.2, r: 0.2, g: 0.22 });
        this._tone({ f: 220, f2: 990, sweep: 0.3, t, type: 'sawtooth', a: 0.03, h: 0.22, r: 0.15, g: 0.05, ft: 'lowpass', ff: 1200, ff2: 4000 });
        break;
      case 'driftBoost':
        this._tone({ f: 420, f2: 1700, sweep: 0.08, t, type: 'square', a: 0.002, h: 0.07, r: 0.08, g: 0.08, ft: 'lowpass', ff: 3600 });
        this._noise({ t, ft: 'highpass', ff: 4000, a: 0.002, h: 0.04, r: 0.08, g: 0.05 });
        break;
      case 'respawn':
        this._tone({ f: 1400, f2: 110, sweep: 0.7, t, type: 'sawtooth', a: 0.01, h: 0.55, r: 0.25, g: 0.07, ft: 'lowpass', ff: 4500, ff2: 300, fq: 4 });
        this._tone({ f: 700, f2: 60, sweep: 0.7, t, type: 'sine', a: 0.01, h: 0.5, r: 0.25, g: 0.1 });
        this._noise({ t, ft: 'bandpass', ff: 3000, ff2: 300, fq: 2, a: 0.02, h: 0.45, r: 0.25, g: 0.05 });
        break;
      case 'finish': {
        if (nowMs() - this._stingerMs < 1500) break; // the race music is playing its finish cadence
        const n = [523.25, 659.25, 783.99];
        for (let i = 0; i < n.length; i++) this._brass(n[i], t + i * 0.12, 0.16, 0.06, 0.1);
        const tt = t + 0.36;
        this._brass(1046.5, tt, 0.18, 0.45, 0.5);
        this._brass(783.99, tt, 0.1, 0.45, 0.5);
        this._chime(2093, tt, 0.05, 0.1, 0.5);
        break;
      }
      case 'win': {
        const n = [392, 523.25, 659.25, 783.99];
        for (let i = 0; i < n.length; i++) this._brass(n[i], t + i * 0.11, 0.15, 0.06, 0.08);
        const tt = t + 0.48;
        this._brass(1046.5, tt, 0.17, 0.9, 0.8);
        this._brass(1318.5, tt, 0.11, 0.9, 0.8);
        this._brass(783.99, tt, 0.11, 0.9, 0.8);
        this._tone({ f: 130.81, t: tt, type: 'sine', a: 0.02, h: 0.9, r: 0.8, g: 0.18 });
        const sp = [2093, 2637, 3136, 4186];
        for (let i = 0; i < sp.length; i++) this._chime(sp[i], tt + 0.15 + i * 0.09, 0.035, 0.03, 0.3);
        this._noise({ t: tt, ft: 'highpass', ff: 6000, a: 0.05, h: 0.4, r: 0.6, g: 0.03 });
        break;
      }
      case 'lose': {
        // Soft descending line over A minor.
        const pad = [220, 261.63, 329.63];
        for (let i = 0; i < pad.length; i++) this._tone({ f: pad[i], t, type: 'triangle', a: 0.15, h: 0.9, r: 0.9, g: 0.05 });
        const line = [659.25, 587.33, 523.25];
        for (let i = 0; i < line.length; i++) this._tone({ f: line[i], t: t + i * 0.28, type: 'triangle', a: 0.02, h: 0.15, r: i === 2 ? 0.8 : 0.25, g: 0.1 });
        break;
      }
      case 'join':
        this._chime(659.25, t, 0.1, 0.03, 0.1);
        this._chime(987.77, t + 0.08, 0.1, 0.05, 0.2);
        break;
      case 'leave':
        this._chime(987.77, t, 0.09, 0.03, 0.1);
        this._chime(659.25, t + 0.08, 0.09, 0.05, 0.2);
        break;
      case 'ready':
        this._tone({ f: 1046.5, t, type: 'sine', a: 0.003, h: 0.04, r: 0.06, g: 0.12 });
        this._tone({ f: 1568, t: t + 0.07, type: 'sine', a: 0.003, h: 0.06, r: 0.15, g: 0.12 });
        break;
      case 'error':
        for (let k = 0; k < 2; k++) {
          this._tone({ f: 196, t: t + k * 0.12, type: 'square', a: 0.004, h: 0.07, r: 0.04, g: 0.09, ft: 'lowpass', ff: 1300 });
          this._tone({ f: 207.65, t: t + k * 0.12, type: 'sawtooth', a: 0.004, h: 0.07, r: 0.04, g: 0.04, ft: 'lowpass', ff: 1100 });
        }
        break;
      default:
        // Unknown names are ignored (keeps the game from crashing on a typo).
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Combat one-shots (every voice routes into `bus`)

  _combat(name, o, t, bus) {
    const rnd = this._srng;
    switch (name) {
      case 'laser': {
        // Short punchy pew: falling filtered square + sine body + a tiny click.
        const p = 1 + (rnd() - 0.5) * 0.12;
        this._tone({ f: 1850 * p, f2: 280 * p, sweep: 0.1, t, type: 'square', a: 0.002, h: 0.022, r: 0.085, g: 0.08, ft: 'lowpass', ff: 5200, ff2: 900, fq: 1.4, bus });
        this._tone({ f: 940 * p, f2: 150 * p, sweep: 0.09, t, type: 'sine', a: 0.002, h: 0.03, r: 0.07, g: 0.2, bus });
        this._noise({ t, ft: 'highpass', ff: 4500, a: 0.001, h: 0.005, r: 0.018, g: 0.045, bus });
        break;
      }
      case 'laserHit': {
        const p = 1 + (rnd() - 0.5) * 0.2;
        this._tone({ f: 3300 * p, f2: 2300 * p, t, type: 'square', a: 0.001, h: 0.008, r: 0.03, g: 0.07, ft: 'bandpass', ff: 3600, fq: 3, bus });
        this._noise({ t, ft: 'bandpass', ff: 6200 * p, fq: 2.5, a: 0.001, h: 0.006, r: 0.03, g: 0.12, bus });
        break;
      }
      case 'shieldHit': {
        // Soft electric shimmer: staggered high partials + airy fizz.
        const p = 1 + (rnd() - 0.5) * 0.08;
        const parts = [1180, 1770, 2360, 3010];
        for (let i = 0; i < parts.length; i++) {
          this._tone({ f: parts[i] * p, f2: parts[i] * p * 1.04, t: t + i * 0.014, type: 'sine', a: 0.006, h: 0.02, r: 0.2 - i * 0.03, g: 0.07 - i * 0.012, det: (rnd() - 0.5) * 30, bus });
        }
        this._noise({ t, ft: 'bandpass', ff: 5200, ff2: 2600, fq: 3, a: 0.004, h: 0.03, r: 0.16, g: 0.08, bus });
        this._tone({ f: 220 * p, f2: 330 * p, t, type: 'triangle', a: 0.005, h: 0.02, r: 0.1, g: 0.07, bus });
        break;
      }
      case 'hullHit': {
        // Crunchy thud: sub drop, dark body, a few crackles.
        this._tone({ f: 150, f2: 48, sweep: 0.12, t, type: 'sine', a: 0.002, h: 0.03, r: 0.14, g: 0.32, bus });
        this._noise({ t, ft: 'lowpass', ff: 1800, ff2: 220, a: 0.002, h: 0.04, r: 0.14, g: 0.24, bus });
        for (let k = 0; k < 3; k++) {
          this._noise({ t: t + 0.01 + k * 0.025 + rnd() * 0.012, ft: 'bandpass', ff: 1200 + rnd() * 1600, fq: 4, a: 0.001, h: 0.006, r: 0.03, g: 0.09, bus });
        }
        this._tone({ f: 420, f2: 260, t, type: 'square', a: 0.002, h: 0.015, r: 0.05, g: 0.03, ft: 'lowpass', ff: 1400, bus });
        break;
      }
      case 'shieldDown': {
        // Descending warble alarm (LFO on pitch), twice.
        for (let k = 0; k < 2; k++) this._warble(t + k * 0.36, 0.33, k === 0 ? 1100 : 900, k === 0 ? 520 : 360, bus);
        this._noise({ t, ft: 'bandpass', ff: 3000, ff2: 700, fq: 2, a: 0.01, h: 0.2, r: 0.3, g: 0.04, bus });
        break;
      }
      case 'missileLaunch': {
        // Ignition pop + whoosh that rises then falls away + rocket roar.
        this._tone({ f: 170, f2: 55, sweep: 0.12, t, type: 'sine', a: 0.002, h: 0.03, r: 0.14, g: 0.24, bus });
        this._noise({ t, ft: 'lowpass', ff: 3400, ff2: 400, a: 0.002, h: 0.025, r: 0.12, g: 0.18, bus });
        this._noise({ t: t + 0.02, ft: 'bandpass', ff: 500, ff2: 3200, fq: 1.3, a: 0.05, h: 0.18, r: 0.32, g: 0.15, bus });
        this._tone({ f: 240, f2: 110, sweep: 0.5, t: t + 0.02, type: 'sawtooth', a: 0.02, h: 0.22, r: 0.3, g: 0.035, ft: 'lowpass', ff: 900, ff2: 400, bus });
        break;
      }
      case 'locking':
        this._tone({ f: 1760, t, type: 'sine', a: 0.002, h: 0.025, r: 0.03, g: 0.08, bus });
        this._tone({ f: 1760, t, type: 'square', a: 0.002, h: 0.02, r: 0.02, g: 0.018, ft: 'lowpass', ff: 4000, bus });
        break;
      case 'locked':
        for (let k = 0; k < 2; k++) {
          const f = k === 0 ? 1567.98 : 2093;
          const tt = t + k * 0.09;
          this._tone({ f, t: tt, type: 'square', a: 0.003, h: 0.07, r: 0.04, g: 0.035, ft: 'lowpass', ff: 4500, bus });
          this._tone({ f, t: tt, type: 'sine', a: 0.003, h: 0.07, r: 0.06, g: 0.09, bus });
        }
        break;
      case 'missileWarn':
        // Urgent alternating beep (hi-lo-hi-lo).
        for (let k = 0; k < 4; k++) {
          const f = k % 2 === 0 ? 1320 : 990;
          const tt = t + k * 0.075;
          this._tone({ f, t: tt, type: 'square', a: 0.002, h: 0.05, r: 0.015, g: 0.05, ft: 'lowpass', ff: 3800, bus });
          this._tone({ f, t: tt, type: 'sine', a: 0.002, h: 0.05, r: 0.02, g: 0.07, bus });
        }
        break;
      case 'explosion':
        this._explosion(o, t, bus);
        break;
      case 'shatter':
        this._shatter(o, t, bus);
        break;
      case 'pickup': {
        const kind = o.kind === 'missile' || o.kind === 'shield' ? o.kind : 'boost';
        if (kind === 'boost') {
          const n = [1318.5, 1661.2, 1975.5];
          for (let i = 0; i < n.length; i++) this._chime(n[i], t + i * 0.045, 0.1, 0.03, i === 2 ? 0.28 : 0.1, bus);
          this._noise({ t, ft: 'bandpass', ff: 2500, ff2: 9000, fq: 1.5, a: 0.02, h: 0.06, r: 0.1, g: 0.04, bus });
        } else if (kind === 'missile') {
          this._tone({ f: 2400, f2: 1600, t, type: 'square', a: 0.001, h: 0.008, r: 0.025, g: 0.04, ft: 'lowpass', ff: 5000, bus });
          this._chime(1174.66, t + 0.02, 0.11, 0.035, 0.1, bus);
          this._chime(1760, t + 0.09, 0.12, 0.05, 0.28, bus);
        } else {
          const n = [1046.5, 1318.5, 1567.98];
          for (let i = 0; i < n.length; i++) this._chime(n[i], t + i * 0.02, 0.07, 0.08, 0.4, bus);
          this._tone({ f: 523.25, t, type: 'sine', a: 0.03, h: 0.1, r: 0.35, g: 0.07, bus });
          this._noise({ t, ft: 'highpass', ff: 7000, a: 0.03, h: 0.08, r: 0.25, g: 0.025, bus });
        }
        break;
      }
      case 'ring': {
        // Clean bright chime; each consecutive clean ring is a semitone higher.
        const st = clamp(Math.round(num(o.streak, 0)), 0, 10);
        const m = 81 + st; // A5 .. G6
        this._chime(mtof(m), t, 0.1, 0.03, 0.16, bus);
        this._chime(mtof(m + 7), t + 0.055, 0.12, 0.05, 0.34, bus);
        this._noise({ t, ft: 'highpass', ff: 7500, a: 0.004, h: 0.02, r: 0.12, g: 0.025, bus });
        break;
      }
      case 'missedRing':
        this._tone({ f: 104, f2: 92, t, type: 'sawtooth', a: 0.005, h: 0.13, r: 0.06, g: 0.1, ft: 'lowpass', ff: 900, bus });
        this._tone({ f: 110, f2: 97, t, type: 'square', a: 0.005, h: 0.13, r: 0.06, g: 0.06, ft: 'lowpass', ff: 700, bus });
        break;
      case 'overheat':
        // Relay click, then a venting steam hiss.
        this._tone({ f: 1900, f2: 900, t, type: 'square', a: 0.001, h: 0.005, r: 0.02, g: 0.09, ft: 'lowpass', ff: 4500, bus });
        this._noise({ t, ft: 'bandpass', ff: 3500, fq: 2, a: 0.001, h: 0.004, r: 0.02, g: 0.1, bus });
        this._noise({ t: t + 0.02, ft: 'highpass', ff: 6500, ff2: 2400, a: 0.03, h: 0.28, r: 0.45, g: 0.09, bus });
        this._noise({ t: t + 0.02, ft: 'bandpass', ff: 4200, ff2: 2000, fq: 1.2, a: 0.04, h: 0.2, r: 0.4, g: 0.04, bus });
        break;
      case 'boostStart':
        // Whoosh up.
        this._noise({ t, ft: 'bandpass', ff: 300, ff2: 4500, fq: 1.4, a: 0.05, h: 0.14, r: 0.18, g: 0.16, bus });
        this._tone({ f: 160, f2: 880, sweep: 0.3, t, type: 'sawtooth', a: 0.02, h: 0.2, r: 0.15, g: 0.045, ft: 'lowpass', ff: 900, ff2: 5000, bus });
        this._tone({ f: 80, f2: 200, sweep: 0.25, t, type: 'sine', a: 0.01, h: 0.15, r: 0.12, g: 0.08, bus });
        break;
      case 'passBy':
        this._passBy(o, t, bus);
        break;
      case 'nearMiss': {
        // Air ripped past the canopy: a fast falling "fwip", a whistle, a pressure thump.
        const p = 1 + (rnd() - 0.5) * 0.15;
        this._noise({ t, ft: 'bandpass', ff: 5200 * p, ff2: 800, fq: 1.4, a: 0.006, h: 0.025, r: 0.2, g: 0.3, bus });
        this._noise({ t, ft: 'highpass', ff: 7000, a: 0.002, h: 0.01, r: 0.06, g: 0.07, bus });
        this._tone({ f: 1500 * p, f2: 520 * p, sweep: 0.14, t, type: 'sine', a: 0.004, h: 0.02, r: 0.12, g: 0.05, bus });
        this._tone({ f: 95, f2: 45, sweep: 0.12, t, type: 'sine', a: 0.003, h: 0.02, r: 0.12, g: 0.2, bus });
        break;
      }
      case 'sonicBoom': {
        // N-wave double crack, a deep thump and a long rolling tail.
        for (let k = 0; k < 2; k++) {
          const tt = t + k * 0.085;
          this._noise({ t: tt, ft: 'highpass', ff: 1400, a: 0.0008, h: 0.006, r: 0.09, g: 0.3 - k * 0.08, bus });
          this._noise({ t: tt, ft: 'lowpass', ff: 3200, ff2: 180, a: 0.001, h: 0.02, r: 0.32, g: 0.34 - k * 0.1, bus });
        }
        this._tone({ f: 78, f2: 27, sweep: 0.55, t, type: 'sine', a: 0.002, h: 0.05, r: 0.9, g: 0.5, bus });
        this._noise({ t: t + 0.04, ft: 'lowpass', ff: 280, ff2: 55, fq: 0.7, a: 0.06, h: 0.2, r: 1.5, g: 0.24, rate: 0.5, bus });
        this._noise({ t: t + 0.06, ft: 'bandpass', ff: 900, ff2: 250, fq: 0.8, a: 0.04, h: 0.1, r: 0.9, g: 0.08, bus });
        this._dip(0.5, t, 0.5);
        break;
      }
      case 'demolition':
        this._demolition(o, t, bus);
        break;
      case 'bump': {
        // Meaty arcade hit: bass punch, wooden knock, smack, and a ding when it's a big one.
        const i = clamp(num(o.intensity, 0.5), 0, 1);
        const p = 1 + (rnd() - 0.5) * 0.12;
        this._tone({ f: 150 * p, f2: 50, sweep: 0.09, t, type: 'sine', a: 0.001, h: 0.02 + 0.02 * i, r: 0.12 + 0.12 * i, g: 0.28 + 0.3 * i, bus });
        this._tone({ f: 270 * p, f2: 165 * p, sweep: 0.05, t, type: 'triangle', a: 0.001, h: 0.01, r: 0.07, g: 0.1 + 0.1 * i, bus });
        this._noise({ t, ft: 'lowpass', ff: 2800, ff2: 380, a: 0.001, h: 0.012, r: 0.08 + 0.06 * i, g: 0.16 + 0.2 * i, bus });
        this._noise({ t, ft: 'bandpass', ff: 3800 * p, fq: 3, a: 0.001, h: 0.004, r: 0.03, g: 0.08, bus });
        if (i > 0.45) {
          this._tone({ f: 640 * p, t, type: 'triangle', a: 0.001, h: 0.01, r: 0.3, g: 0.05 * i, bus });
          this._tone({ f: 1770 * p, t, type: 'sine', a: 0.001, h: 0.006, r: 0.2, g: 0.025 * i, bus });
        }
        break;
      }
      case 'boostPad': {
        const big = !!o.big;
        this._tone({ f: 880, f2: 1760, sweep: 0.08, t, type: 'sine', a: 0.003, h: 0.04, r: 0.12, g: 0.1, bus });
        this._tone({ f: 440, f2: 880, sweep: 0.08, t, type: 'square', a: 0.003, h: 0.04, r: 0.08, g: 0.03, ft: 'lowpass', ff: 3000, bus });
        this._noise({ t, ft: 'bandpass', ff: 1200, ff2: 6500, fq: 1.4, a: 0.01, h: 0.05, r: 0.14, g: 0.1, bus });
        if (big) {
          this._tone({ f: 115, f2: 58, sweep: 0.12, t, type: 'sine', a: 0.002, h: 0.04, r: 0.2, g: 0.26, bus });
          this._noise({ t, ft: 'bandpass', ff: 300, ff2: 5000, fq: 1.3, a: 0.04, h: 0.16, r: 0.26, g: 0.2, bus });
          this._tone({ f: 160, f2: 900, sweep: 0.35, t, type: 'sawtooth', a: 0.02, h: 0.22, r: 0.18, g: 0.045, ft: 'lowpass', ff: 900, ff2: 5000, bus });
          const n = [880, 1108.7, 1318.5, 1760];
          for (let k = 0; k < n.length; k++) this._chime(n[k], t + 0.03 + k * 0.04, 0.07, 0.03, k === 3 ? 0.35 : 0.12, bus);
        }
        break;
      }
      case 'dodge':
        // Quick barrel-roll swish.
        this._noise({ t, ft: 'bandpass', ff: 700, ff2: 3800, fq: 1.6, a: 0.025, h: 0.05, r: 0.14, g: 0.22, bus });
        this._noise({ t: t + 0.06, ft: 'bandpass', ff: 3000, ff2: 900, fq: 1.6, a: 0.02, h: 0.03, r: 0.12, g: 0.12, bus });
        this._tone({ f: 300, f2: 950, sweep: 0.12, t, type: 'sine', a: 0.01, h: 0.04, r: 0.08, g: 0.05, bus });
        this._tone({ f: 120, f2: 70, sweep: 0.1, t, type: 'sine', a: 0.004, h: 0.02, r: 0.08, g: 0.1, bus });
        break;
      case 'deflect': {
        // Ricochet: a falling "pt-zinng".
        const p = 1 + (rnd() - 0.5) * 0.2;
        this._noise({ t, ft: 'highpass', ff: 5500, a: 0.0008, h: 0.004, r: 0.03, g: 0.12, bus });
        this._tone({ f: 3000 * p, f2: 850 * p, sweep: 0.28, t, type: 'sine', a: 0.001, h: 0.01, r: 0.3, g: 0.08, bus });
        this._tone({ f: 3500 * p, f2: 2100 * p, sweep: 0.2, t, type: 'square', a: 0.001, h: 0.008, r: 0.18, g: 0.025, ft: 'bandpass', ff: 3200, fq: 4, bus });
        break;
      }
      case 'debris':
        this._debris(o, t, bus);
        break;
      default:
        break;
    }
  }

  /** Doppler pass-by: pitch and filter fall through the pass, pan sweeps across. */
  _passBy(o, t, bus) {
    const rnd = this._srng;
    let sp = num(o.speed, 0.8);
    if (sp > 3) sp /= 150;
    sp = clamp(sp, 0.1, 2);
    const pan = clamp(num(o.pan, 0), -1, 1);
    const rock = o.kind === 'rock';
    const dur = 0.32 + 0.35 / (0.6 + sp);
    const ctx = this.ctx;
    let dest = bus.in;
    if (typeof ctx.createStereoPanner === 'function') {
      const pn = ctx.createStereoPanner();
      pn.pan.setValueAtTime(pan * 0.9, t);
      pn.pan.linearRampToValueAtTime(-pan * 0.45, t + dur);
      pn.connect(bus.in);
      bus.nodes.push(pn);
      dest = pn;
    }
    const a = dur * 0.42, r = dur * 0.58;
    const p = 1 + (rnd() - 0.5) * 0.1;
    // Doppler ratio for a fast pass: ~1.35 approaching -> ~0.72 receding
    const up = 1 + 0.25 * sp, down = 1 - 0.22 * Math.min(1.3, sp);
    this._noise({ t, ft: 'bandpass', ff: (rock ? 1500 : 2600) * up, ff2: (rock ? 300 : 520) * down, fq: 1.1, a, h: 0.015, r, g: rock ? 0.22 : 0.18, dest, bus });
    if (!rock) {
      const f = (150 + 90 * sp) * p;
      this._tone({ f: f * up, f2: f * down, sweep: dur * 0.7, t, type: 'sawtooth', a, h: 0.015, r, g: 0.07, ft: 'lowpass', ff: 2600, ff2: 600, fq: 1.2, dest, bus });
      this._tone({ f: f * 2 * up, f2: f * 2 * down, sweep: dur * 0.7, t, type: 'square', a, h: 0.015, r: r * 0.8, g: 0.02, ft: 'lowpass', ff: 3500, ff2: 900, dest, bus });
      this._tone({ f: f * 8 * up, f2: f * 8 * down, sweep: dur * 0.7, t, type: 'sine', a, h: 0.01, r: r * 0.6, g: 0.012, dest, bus });
    } else {
      this._tone({ f: 70, f2: 40, sweep: dur, t: t + a * 0.6, type: 'sine', a: a * 0.5, h: 0.02, r, g: 0.12, dest, bus });
    }
  }

  /** Rocket-League demolition: huge crunch, metal shriek, debris rain. */
  _demolition(o, t, bus) {
    const rnd = this._srng;
    const p = 1 + (rnd() - 0.5) * 0.08;
    this._noise({ t, ft: 'highpass', ff: 2400, a: 0.0008, h: 0.012, r: 0.09, g: 0.24, bus });
    this._tone({ f: 100 * p, f2: 24, sweep: 0.7, t, type: 'sine', a: 0.002, h: 0.08, r: 1.2, g: 0.55, bus });
    this._tone({ f: 72 * p, f2: 34, sweep: 0.4, t, type: 'sawtooth', a: 0.002, h: 0.05, r: 0.4, g: 0.12, ft: 'lowpass', ff: 700, ff2: 180, bus });
    this._noise({ t, ft: 'lowpass', ff: 4500, ff2: 120, fq: 0.8, a: 0.002, h: 0.1, r: 0.9, g: 0.4, rate: 0.8, bus });
    for (let k = 0; k < 14; k++) {
      this._noise({ t: t + 0.005 + rnd() * 0.35, ft: 'bandpass', ff: 700 + rnd() * 3200, fq: 3.5, a: 0.001, h: 0.006, r: 0.03 + rnd() * 0.05, g: 0.06 + 0.05 * rnd(), bus });
    }
    const ratios = [1, 2.76, 5.4, 8.93, 11.3];
    const f = 290 * p;
    for (let i = 0; i < ratios.length; i++) {
      this._tone({ f: f * ratios[i], f2: f * ratios[i] * 0.94, sweep: 0.6, t: t + 0.01, type: i === 0 ? 'triangle' : 'square', a: 0.001, h: 0.02, r: 0.7 / (1 + i * 0.5), g: (i === 0 ? 0.08 : 0.03) / (1 + i * 0.3), ft: 'lowpass', ff: 5000, bus });
    }
    this._debrisRain(t + 0.18, 9, 1.3, bus);
    this._noise({ t: t + 0.05, ft: 'lowpass', ff: 220, ff2: 60, fq: 0.7, a: 0.05, h: 0.2, r: 1.2, g: 0.2, rate: 0.5, bus });
    this._dip(0.6, t, 0.6);
  }

  /** Scattered metal clanks over `spread` seconds. */
  _debrisRain(t0, n, spread, bus) {
    const rnd = this._srng;
    for (let k = 0; k < n; k++) {
      const tt = t0 + Math.pow(rnd(), 1.4) * spread;
      const f = 700 + rnd() * 2300;
      const g = 0.035 * (1 - (tt - t0) / (spread * 1.2));
      this._tone({ f, t: tt, type: 'triangle', a: 0.001, h: 0.004, r: 0.06 + rnd() * 0.12, g, bus });
      this._tone({ f: f * 2.71, t: tt, type: 'sine', a: 0.001, h: 0.003, r: 0.05, g: g * 0.5, bus });
    }
  }

  /** Clanks of debris on the wall / each other. opts.size 0..1, opts.kind 'metal' | 'rock'. */
  _debris(o, t, bus) {
    const rnd = this._srng;
    const s = clamp(num(o.size, 0.5), 0, 1);
    const n = 1 + Math.round(rnd() * 2 + s * 1.5);
    for (let k = 0; k < n; k++) {
      const tt = t + k * (0.03 + rnd() * 0.05);
      if (o.kind === 'rock') {
        this._noise({ t: tt, ft: 'bandpass', ff: 600 + rnd() * 900, fq: 2.5, a: 0.001, h: 0.006, r: 0.05 + 0.05 * s, g: 0.1 + 0.08 * s, bus });
      } else {
        const f = (650 + rnd() * 1100) * (1.2 - 0.5 * s);
        this._tone({ f, t: tt, type: 'triangle', a: 0.001, h: 0.005, r: 0.08 + 0.12 * s, g: 0.05 + 0.04 * s, bus });
        this._tone({ f: f * 2.71, t: tt, type: 'square', a: 0.001, h: 0.003, r: 0.05 + 0.05 * s, g: 0.012, ft: 'lowpass', ff: 6000, bus });
        this._noise({ t: tt, ft: 'bandpass', ff: 1800, fq: 2, a: 0.001, h: 0.004, r: 0.03, g: 0.06, bus });
      }
    }
  }

  /** Descending square+sine with a fast pitch LFO (alarm warble). */
  _warble(t, dur, f0, f1, bus) {
    if (!this._ok()) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 16;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 70; // cents
    lfo.connect(lfoG);
    lfoG.connect(osc.detune);
    lfoG.connect(osc2.detune);
    for (const o of [osc, osc2]) {
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    }
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 2600;
    const g = ctx.createGain();
    const end = this._env(g, t, 0.07, 0.01, dur - 0.06, 0.06);
    const g2 = ctx.createGain();
    g2.gain.value = 1.4;
    osc.connect(filt);
    filt.connect(g);
    osc2.connect(g2);
    g2.connect(g);
    g.connect(bus.in);
    for (const o of [osc, osc2, lfo]) {
      o.start(t);
      o.stop(end + 0.03);
    }
    this._track(osc, [osc, osc2, lfo, lfoG, filt, g, g2], bus);
  }

  /** opts.size 0..1: bigger = deeper/longer with a rumble tail. Distance is applied by the bus. */
  _explosion(o, t, bus) {
    const rnd = this._srng;
    const big = !!o.ship || num(o.size, 0.5) > 1;
    const s = clamp(num(o.size, 0.5), 0, 1);
    const d = clamp(num(o.distance, 0), 0, 1);
    const p = 1 + (rnd() - 0.5) * 0.1;
    // Transient crack (the "punch").
    this._noise({ t, ft: 'highpass', ff: 2200, a: 0.001, h: 0.008, r: 0.07, g: 0.08 + 0.05 * s, bus });
    // Sub thump.
    this._tone({ f: (130 - 60 * s) * p, f2: (40 - 14 * s) * p, sweep: 0.22 + 0.35 * s, t, type: 'sine', a: 0.003, h: 0.04 + 0.1 * s, r: 0.28 + 0.9 * s, g: 0.3 + 0.22 * s, bus });
    // Body.
    this._noise({ t, ft: 'lowpass', ff: 2400 + 2000 * s, ff2: 110, fq: 0.8, a: 0.002, h: 0.04 + 0.12 * s, r: 0.32 + 1.0 * s, g: 0.24 + 0.18 * s, rate: 1 - 0.35 * s, bus });
    // Debris crackle (skipped far away, where it would just be mud).
    if (d < 0.7) {
      const n = 3 + Math.round(5 * s);
      for (let k = 0; k < n; k++) {
        this._noise({ t: t + 0.025 + rnd() * (0.15 + 0.3 * s), ft: 'bandpass', ff: 700 + rnd() * 2600, fq: 3.5, a: 0.001, h: 0.006, r: 0.03 + rnd() * 0.04, g: 0.045 + 0.04 * rnd(), bus });
      }
    }
    // Rumble tail.
    if (s > 0.25) {
      this._noise({ t: t + 0.03, ft: 'lowpass', ff: 200, ff2: 70, fq: 0.7, a: 0.08, h: 0.15 + 0.5 * s, r: 0.7 + 1.4 * s, g: 0.12 + 0.22 * s, rate: 0.45, bus });
      this._tone({ f: 52 * p, f2: 34 * p, sweep: 1 + s, t: t + 0.02, type: 'sine', a: 0.06, h: 0.2 + 0.4 * s, r: 0.6 + 1.0 * s, g: 0.06 + 0.1 * s, bus });
    }
    // Ship death: a second fuel-tank boom, a distorted crunch, crackling fire and falling metal.
    if (big) {
      this._noise({ t, ft: 'lowpass', ff: 5200, ff2: 320, fq: 1.2, a: 0.001, h: 0.03, r: 0.45, g: 0.22, bus });
      this._tone({ f: 92 * p, f2: 28, sweep: 0.6, t: t + 0.13, type: 'sine', a: 0.003, h: 0.06, r: 1.1, g: 0.34, bus });
      this._noise({ t: t + 0.13, ft: 'lowpass', ff: 1800, ff2: 90, a: 0.002, h: 0.06, r: 0.8, g: 0.2, rate: 0.7, bus });
      if (d < 0.75) {
        for (let k = 0; k < 12; k++) {
          this._noise({ t: t + 0.2 + rnd() * 1.4, ft: 'bandpass', ff: 500 + rnd() * 2000, fq: 2.5, a: 0.001, h: 0.004, r: 0.02 + rnd() * 0.03, g: 0.05 * (0.5 + rnd()), bus });
        }
        this._debrisRain(t + 0.25, 7, 1.4, bus);
      }
    }
    // Big, close booms push the music down for a moment.
    if ((s > 0.4 || big) && d < 0.6) this._dip(Math.min(0.6, (big ? 0.6 : 0.45 * s) * (1 - d)), t, 0.2 + 0.4 * s + (big ? 0.3 : 0));
  }

  /** opts.size 0..1, opts.kind 'rock' | 'ice' | 'metal' | 'crystal'. */
  _shatter(o, t, bus) {
    const rnd = this._srng;
    const s = clamp(num(o.size, 0.5), 0, 1);
    const kind = o.kind === 'ice' || o.kind === 'metal' || o.kind === 'crystal' ? o.kind : 'rock';
    const p = 1 + (rnd() - 0.5) * 0.12;
    const grains = (n, fLo, fHi, fq, spread, g, r) => {
      for (let k = 0; k < n; k++) {
        this._noise({ t: t + 0.006 + rnd() * spread, ft: 'bandpass', ff: fLo + rnd() * (fHi - fLo), fq, a: 0.001, h: 0.005, r: r * (0.6 + rnd() * 0.8), g: g * (0.6 + rnd() * 0.6), bus });
      }
    };
    switch (kind) {
      case 'ice':
        this._noise({ t, ft: 'highpass', ff: 3500, a: 0.001, h: 0.012, r: 0.08 + 0.1 * s, g: 0.13, bus });
        this._tone({ f: 170 * p, f2: 75, t, type: 'sine', a: 0.002, h: 0.02, r: 0.08 + 0.08 * s, g: 0.08 + 0.1 * s, bus });
        grains(5 + Math.round(6 * s), 3000, 7500, 5, 0.06 + 0.1 * s, 0.08, 0.03);
        for (let k = 0; k < 3; k++) this._tone({ f: (2600 + rnd() * 2200) * p, t: t + 0.01 + rnd() * 0.08, type: 'sine', a: 0.001, h: 0.006, r: 0.06, g: 0.025, bus });
        break;
      case 'metal': {
        const f = (430 - 190 * s) * p;
        const ratios = [1, 2.76, 5.4, 8.93];
        const gains = [0.075, 0.05, 0.03, 0.018];
        for (let i = 0; i < ratios.length; i++) {
          this._tone({ f: f * ratios[i], t, type: i === 0 ? 'triangle' : 'square', a: 0.001, h: 0.01, r: (0.3 + 0.35 * s) / (1 + i * 0.6), g: gains[i] * (i === 0 ? 1 : 0.6), ft: 'lowpass', ff: 6000, bus });
        }
        this._noise({ t, ft: 'bandpass', ff: 2600, ff2: 1200, fq: 2, a: 0.001, h: 0.025, r: 0.12, g: 0.12, bus });
        this._tone({ f: 140 * p, f2: 55, t, type: 'sine', a: 0.002, h: 0.02, r: 0.12 + 0.1 * s, g: 0.15 + 0.1 * s, bus });
        grains(2 + Math.round(3 * s), 1800, 4200, 6, 0.08 + 0.12 * s, 0.06, 0.05);
        break;
      }
      case 'crystal': {
        const f = (1500 - 500 * s) * p;
        const ratios = [1, 2.32, 4.25, 6.63];
        const gains = [0.075, 0.05, 0.03, 0.018];
        for (let i = 0; i < ratios.length; i++) {
          this._tone({ f: f * ratios[i], t: t + i * 0.004, type: 'sine', a: 0.001, h: 0.01, r: (0.6 + 0.6 * s) / (1 + i * 0.5), g: gains[i], bus });
        }
        for (let k = 0; k < 4 + Math.round(3 * s); k++) {
          this._tone({ f: (2600 + rnd() * 3400) * p, t: t + 0.02 + rnd() * (0.12 + 0.15 * s), type: 'sine', a: 0.001, h: 0.006, r: 0.08 + rnd() * 0.1, g: 0.022, bus });
        }
        this._noise({ t, ft: 'highpass', ff: 6000, a: 0.001, h: 0.01, r: 0.06, g: 0.07, bus });
        this._tone({ f: 120 * p, f2: 60, t, type: 'sine', a: 0.002, h: 0.015, r: 0.08, g: 0.06 + 0.06 * s, bus });
        break;
      }
      default:
        // Rock: low thud, gravelly body, crunchy grains.
        this._tone({ f: (115 - 40 * s) * p, f2: 42, t, type: 'sine', a: 0.002, h: 0.025, r: 0.14 + 0.2 * s, g: 0.18 + 0.15 * s, bus });
        this._noise({ t, ft: 'lowpass', ff: 1500 + 600 * s, ff2: 240, a: 0.002, h: 0.03 + 0.05 * s, r: 0.15 + 0.25 * s, g: 0.2 + 0.12 * s, bus });
        grains(4 + Math.round(6 * s), 800, 2600, 3.5, 0.05 + 0.15 * s, 0.09, 0.035);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Music
  //
  // MENU is a dreamy loop. RACE is an adaptive 128 bpm E-minor loop made of layers (kick, bass,
  // pad, hats, clap, arp, offbeat drive stabs, last-lap lead, leader melody), each on its own
  // gain that follows the race. Race track graph:
  //   kick layer + cue hits + stingers ----------------------------> out -> musicBus
  //   every other layer -> pump (sidechain-ish duck) -> lowpass ----^
  //   (arp / lead / melody also feed the shared echo through tr.send)
  // Phases: 'countdown' (sparse; a riser into Go) -> 'racing' (layers fade with intensity) ->
  // 'finish' (cadence stinger) -> 'outro' (calm pad loop until the results switch to MENU).
  // Structural changes (last-lap key lift + lead, leader melody) land on bar lines, supersonic
  // (filter sweep + pump) on beats; every change is a gain or filter ramp, never a hard cut.
  //   audio.setRaceMusic({ intensity: 0..1, lastLap, supersonic, leading })  // a few times a second
  //   audio.musicCue('intro' | 'countdown' | 'go' | 'finish', { n?: seconds to Go, win?: bool })
  //   audio.musicDebug()  // -> { track, phase, I, key, levels, ... } for logging

  /** 'menu' | 'race' | null. Crossfades between kinds; null fades out. */
  music(kind) {
    const k = kind === 'menu' || kind === 'race' ? kind : null;
    if (k === this._musicWanted && (k === null || this._current || !this.ctx)) return;
    this._musicWanted = k;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this._current) {
      this._fadeTrack(this._current, t);
      this._current = null;
    }
    if (k) this._startTrack(k);
  }

  /**
   * Adaptive race music targets. Cheap: just stores them; the sequencer reads them on its
   * 16th-note grid (intensity is smoothed there, flags latch on beats / bars).
   * @param {{intensity?:number, lastLap?:boolean, supersonic?:boolean, leading?:boolean}} s
   */
  setRaceMusic(s) {
    if (!s) return;
    const r = this._rm;
    r.intensity = clamp(num(s.intensity, r.intensity), 0, 1);
    if (s.lastLap !== undefined) r.lastLap = !!s.lastLap;
    if (s.supersonic !== undefined) r.supersonic = !!s.supersonic;
    if (s.leading !== undefined) r.leading = !!s.leading;
  }

  /**
   * Race music cues.
   *   'intro'      new race: back to the sparse pre-race groove (restarts a race already playing)
   *   'countdown'  { n: seconds until Go } arms a riser that peaks on Go (once per countdown)
   *   'go'         resyncs the grid so bar 1 lands on Go, with an impact hit
   *   'finish'     { win } a resolved cadence stinger on the next beat, then a calm outro.
   *                While it is audible, play('finish') is skipped so the two don't clash.
   */
  musicCue(cue, o = {}) {
    const tr = this._current && this._current.kind === 'race' && this._current.L ? this._current : null;
    const live = !!this.ctx && this._live();
    const now = this.ctx ? this.ctx.currentTime : 0;
    switch (cue) {
      case 'intro':
        this._rmPhase = 'countdown';
        this._rm.lastLap = this._rm.supersonic = this._rm.leading = false;
        this._rm.intensity = 0.2;
        if (tr && live) this._raceReset(tr, now);
        return;
      case 'countdown': {
        this._rmPhase = 'countdown';
        if (!tr || !live) return;
        if (tr.phase !== 'countdown') this._raceReset(tr, now);
        if (tr.riser) return;
        tr.riser = true;
        this._riser(tr, now + 0.02, clamp(num(o && o.n, 3), 0.5, 6));
        return;
      }
      case 'go': {
        this._rmPhase = 'racing';
        if (!tr || !live || tr.phase === 'racing') return;
        const t = now + 0.015;
        tr.phase = 'racing';
        tr.phaseAt = t;
        tr.base = tr.step; // the next step scheduled is bar 1, beat 1 ...
        tr.next = t; // ... and it lands on Go
        tr.prog = 0;
        tr.I = Math.max(tr.I, 0.35);
        this._impact(tr, t);
        return;
      }
      case 'finish': {
        if (this._rmPhase === 'finish') return;
        this._rmPhase = 'finish';
        if (!tr || !live || tr.phase === 'finish' || tr.phase === 'outro') return;
        const sx = tr.sixteenth;
        const beat = sx * 4;
        const rel = tr.step - tr.base;
        let tB = tr.next + ((4 - (((rel % 4) + 4) % 4)) % 4) * sx; // next beat not yet scheduled
        if (tB < now + 0.03) tB += beat;
        tr.phase = 'finish';
        tr.finishAt = tB;
        tr.outroAt = tB + beat * 6;
        for (const name of LAYERS) {
          tr.L[name].gain.setTargetAtTime(0, tB, 0.05);
          // Layers keep playing the few 16ths left before the stinger's beat.
          tr.offAt[name] = tr.sent[name] > 0.01 || rel < tr.offAt[name] ? Infinity : -1;
          tr.sent[name] = 0;
        }
        tr.pump.gain.cancelScheduledValues(tB);
        tr.pump.gain.setTargetAtTime(1, tB, 0.05);
        tr.cut = 1700;
        tr.lp.frequency.setTargetAtTime(1700, tB + beat * 2, 0.6);
        tr.lp.Q.setTargetAtTime(0.7, tB, 0.1);
        this._stinger(tr, tB, !o || o.win !== false);
        if (this._vol.music > 0.04 && this._vol.master > 0.04) this._stingerMs = nowMs();
        return;
      }
      default:
        return;
    }
  }

  /** Snapshot of the music state machine (debug / tests). */
  musicDebug() {
    const tr = this._current;
    const o = { track: tr ? tr.kind : null, phase: this._rmPhase, voices: this._voices, want: { ...this._rm } };
    if (tr && tr.L) {
      const lv = {};
      for (const name of LAYERS) lv[name] = Math.round(tr.sent[name] * 100) / 100;
      Object.assign(o, {
        phase: tr.phase,
        I: Math.round(tr.I * 1000) / 1000,
        key: tr.key,
        lastLap: tr.flags.lastLap,
        leading: tr.flags.leading,
        supersonic: tr.flags.ss,
        bar: Math.floor((tr.step - tr.base) / 16),
        cutoff: Math.round(tr.cut),
        levels: lv,
      });
    }
    return o;
  }

  _startTrack(kind) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const def = kind === 'race' ? RACE : MENU;
    const tr = {
      kind,
      def,
      out: ctx.createGain(),
      send: ctx.createGain(),
      step: 0,
      next: t + 0.06,
      sixteenth: 60 / def.bpm / 4,
      stopAt: Infinity,
      dead: false,
    };
    tr.out.gain.setValueAtTime(SILENT, t);
    tr.out.gain.setTargetAtTime(1, t, kind === 'race' ? 0.25 : 0.6);
    tr.send.gain.value = kind === 'race' ? 0.25 : 0.45;
    tr.out.connect(this.musicBus);
    tr.send.connect(this.delay);
    if (kind === 'race') this._buildRaceTrack(tr, t);
    // Echo locked to a dotted eighth.
    this.delay.delayTime.setTargetAtTime(tr.sixteenth * 3, t, 0.2);
    this._tracks.push(tr);
    this._current = tr;
    if (!this._timer) this._timer = setInterval(() => this._schedule(), 25);
  }

  /** Layer buses, pump and filter for the adaptive race track. */
  _buildRaceTrack(tr, t) {
    const ctx = this.ctx;
    tr.lp = ctx.createBiquadFilter();
    tr.lp.type = 'lowpass';
    tr.lp.frequency.value = 1500;
    tr.lp.Q.value = 0.7;
    tr.pump = ctx.createGain();
    tr.pump.connect(tr.lp);
    tr.lp.connect(tr.out);
    tr.hits = ctx.createGain(); // kick, cue hits and stingers: not pumped, not filtered
    tr.hits.connect(tr.out);
    tr.L = {};
    tr.sent = {};
    tr.offAt = {};
    for (const name of LAYERS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(name === 'kick' ? tr.hits : tr.pump);
      tr.L[name] = g;
      tr.sent[name] = 0;
      tr.offAt[name] = -1;
    }
    tr.flags = { lastLap: false, leading: false, ss: false };
    tr.base = 0;
    tr.prog = 0;
    tr.cut = -1;
    // A track started mid-race (audio unlocked late) joins in the right phase.
    tr.phase = this._rmPhase === 'finish' ? 'outro' : this._rmPhase;
    tr.phaseAt = t;
    tr.I = tr.phase === 'racing' ? clamp(this._rm.intensity, 0.2, 1) : 0.2;
    tr.key = 0;
    tr.liftBar = -1;
    tr.riser = false;
    tr.finishAt = Infinity;
    tr.outroAt = Infinity;
    this._raceLevels(tr, t, 0.05, 0);
  }

  /** Back to the countdown groove (new race / restart). */
  _raceReset(tr, t) {
    tr.phase = 'countdown';
    tr.phaseAt = t;
    tr.flags.lastLap = tr.flags.leading = tr.flags.ss = false;
    tr.key = 0;
    tr.liftBar = -1;
    tr.riser = false;
    tr.finishAt = tr.outroAt = Infinity;
    tr.I = 0.2;
    tr.cut = -1;
    for (const name of LAYERS) tr.offAt[name] = -1;
    tr.lp.Q.setTargetAtTime(0.7, t, 0.1);
    this._raceLevels(tr, t, 0.3, tr.step - tr.base);
  }

  /** Ramp every layer (and the filter) toward the levels the current phase / intensity ask for. */
  _raceLevels(tr, t, tc, rel) {
    const I = tr.I;
    const f = tr.flags;
    let lv;
    let cut;
    if (tr.phase === 'countdown') {
      lv = LV_COUNTDOWN;
      cut = 1500;
    } else if (tr.phase === 'outro') {
      lv = LV_OUTRO;
      cut = 1700;
    } else if (tr.phase === 'finish') {
      return; // the finish cue already faded everything
    } else {
      lv = this._lv;
      lv.kick = 1;
      lv.bass = 1;
      lv.pad = 0.95 - 0.35 * I;
      lv.hats = 0.35 + 0.65 * smoothstep(0.15, 0.4, I);
      lv.clap = smoothstep(0.22, 0.42, I);
      lv.arp = f.lastLap ? 1 : smoothstep(0.34, 0.58, I);
      lv.drive = Math.max(smoothstep(0.6, 0.85, I), f.lastLap ? 0.8 : 0);
      lv.lead = f.lastLap ? 0.6 + 0.4 * smoothstep(0.3, 0.7, I) : 0;
      lv.melody = f.leading ? 0.55 + 0.45 * smoothstep(0.25, 0.6, I) : 0;
      cut = f.ss ? 19000 : Math.min(18000, 2400 + 14000 * Math.pow(I, 1.4) + (f.lastLap ? 2500 : 0));
    }
    for (const name of LAYERS) {
      const v = lv[name] || 0;
      const was = tr.sent[name];
      if (Math.abs(v - was) < 0.01) continue;
      // Keep scheduling a fading layer's notes for 1.5 bars so its tail ramps out smoothly.
      if (v <= 0.01 && was > 0.01) tr.offAt[name] = rel + 24;
      tr.sent[name] = v;
      tr.L[name].gain.setTargetAtTime(v, t, tc);
    }
    if (Math.abs(cut - tr.cut) > 40) {
      tr.cut = cut;
      tr.lp.frequency.setTargetAtTime(cut, t, f.ss ? 0.12 : 0.5);
    }
  }

  /** Lookahead scheduler: runs every ~25ms, schedules notes ~0.1s ahead. */
  _schedule() {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const horizon = now + 0.1;
    for (let i = this._tracks.length - 1; i >= 0; i--) {
      const tr = this._tracks[i];
      if (now >= tr.stopAt) {
        this._retire(tr);
        this._tracks.splice(i, 1);
        continue;
      }
      // Tab was throttled/hidden: resync instead of bursting a backlog.
      if (tr.next < now - 0.05) tr.next = now + 0.02;
      while (tr.next < horizon && tr.next < tr.stopAt) {
        try {
          if (tr.kind === 'race') this._raceStep(tr, tr.step, tr.next);
          else this._menuStep(tr, tr.step, tr.next);
        } catch (e) {
          /* never let a scheduling hiccup kill the loop */
        }
        tr.step++;
        tr.next += tr.sixteenth;
      }
    }
    if (!this._tracks.length && this._timer) {
      clearInterval(this._timer);
      this._timer = 0;
    }
  }

  _fadeTrack(tr, t) {
    tr.out.gain.cancelScheduledValues(t);
    tr.out.gain.setTargetAtTime(0, t, 0.35);
    tr.send.gain.setTargetAtTime(0, t, 0.35);
    tr.stopAt = t + 1.6; // stop scheduling new notes once inaudible
  }

  _retire(tr) {
    tr.dead = true;
    // Let any note tails ring out (they're inaudible), then drop the track nodes.
    setTimeout(() => {
      try {
        tr.out.disconnect();
        tr.send.disconnect();
      } catch (e) {
        /* ignore */
      }
    }, 3000);
  }

  /** Dreamy menu loop: slow pad, soft bass, sparse arpeggio. */
  _menuStep(tr, step, t) {
    const def = tr.def;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const ci = bar % 4;
    const chord = def.chords[ci];
    const barLen = tr.sixteenth * 16;
    const dest = tr.out;

    if (s === 0) {
      for (let i = 0; i < chord.length; i++) {
        const f = mtof(chord[i]);
        const p = { f, t, type: 'sawtooth', a: 0.9, h: barLen - 0.6, r: 1.4, g: 0.03, ft: 'lowpass', ff: 700, ff2: 1200, fq: 0.5, dest, det: -8 };
        this._tone(p);
        p.det = 8;
        this._tone(p);
      }
      this._tone({ f: mtof(def.roots[ci]), t, type: 'sine', a: 0.4, h: barLen - 0.4, r: 0.8, g: 0.12, dest });
    }
    // Arp on eighths, with a little generative variation.
    if (s % 2 === 0) {
      const pat = [0, 1, 2, 3, 2, 1, 3, 1];
      const idx = pat[(s / 2) % 8];
      if (this._rng() < 0.14 && s !== 0) return;
      let m = idx === 3 ? chord[0] + 12 : chord[idx];
      m += 12;
      if (bar % 8 >= 4 && this._rng() < 0.25) m += 12;
      this._tone({ f: mtof(m), t, type: 'triangle', a: 0.01, h: 0.04, r: 0.45, g: 0.06, dest, send: tr.send });
    }
  }

  /**
   * Adaptive race loop, one 16th at a time. Same groove as ever (kick, clap, hats, rolling bass,
   * 16th arp, thin pad) with layers that come and go, a sparse countdown and a calm outro.
   */
  _raceStep(tr, step, t) {
    const sx = tr.sixteenth;
    const want = this._rm;
    if (tr.phase === 'countdown' && t - tr.phaseAt > 25) {
      // No 'go' cue ever came (music started some other way): just race.
      tr.phase = 'racing';
      tr.phaseAt = t;
    }
    if (tr.phase === 'finish') {
      if (t < tr.outroAt - 1e-4) {
        if (t >= tr.finishAt - 1e-4) return; // the stinger owns the stage
      } else {
        tr.phase = 'outro';
        tr.phaseAt = t;
        tr.base = step;
        tr.prog = 0;
        tr.flags.ss = false;
        for (const name of LAYERS) tr.offAt[name] = -1;
        this._raceLevels(tr, t, 1.2, 0);
      }
    }
    const phase = tr.phase;
    const racing = phase === 'racing';
    const rel = step - tr.base;
    const s = ((rel % 16) + 16) % 16;
    const bar = Math.floor(rel / 16);
    const f = tr.flags;
    const L = tr.L;
    const k = tr.key;
    const on = (name) => tr.sent[name] > 0.01 || rel < tr.offAt[name];

    // Smoothed intensity: rises over ~1 s, settles over ~3 s.
    if (racing) {
      const target = want.intensity;
      tr.I += (target - tr.I) * (target > tr.I ? 0.09 : 0.035);
    }
    // Last lap: a half-bar fill, then on the bar line the key lifts a semitone, the chord
    // progression restarts and the lead + drive come in.
    if (racing && want.lastLap && !f.lastLap && tr.liftBar < 0) tr.liftBar = s <= 8 ? bar + 1 : bar + 2;
    if (s === 0) {
      if (racing && bar === tr.liftBar && !f.lastLap) {
        f.lastLap = true;
        tr.key = 1;
        tr.prog = bar;
        this._crash(tr, t, 0.12);
      }
      f.leading = racing && want.leading;
    }
    if (s % 4 === 0 && phase !== 'finish') {
      const ss = racing && want.supersonic;
      if (ss && !f.ss) this._ssSweep(tr, t);
      f.ss = ss;
      this._raceLevels(tr, t, racing ? 0.3 : 0.5, rel);
      // Sidechain-ish pump: hard while supersonic, a hint of it at full intensity.
      const depth = ss ? 0.55 : racing && tr.I > 0.75 ? 0.16 * (tr.I - 0.75) / 0.25 : 0;
      if (depth > 0.02) {
        const g = tr.pump.gain;
        g.setValueAtTime(1, t);
        g.linearRampToValueAtTime(1 - depth, t + 0.01);
        g.setTargetAtTime(1, t + 0.012, ss ? 0.09 : 0.06);
      }
    }

    const def = tr.def;
    const ci = phase === 'countdown' ? bar & 1 : (((bar - tr.prog) % 4) + 4) % 4;
    const chord = def.chords[ci];
    const root = def.roots[ci];
    const barLen = sx * 16;

    if (phase === 'countdown') {
      // Sparse: tonic pad + sub, a heartbeat kick, ticking hats.
      if (s === 0) {
        for (let i = 0; i < chord.length; i++) {
          this._tone({ f: mtof(chord[i] + k), t, type: 'sawtooth', a: 0.4, h: barLen - 0.4, r: 0.6, g: 0.02, ft: 'lowpass', ff: 900, fq: 0.6, det: i * 7 - 7, dest: L.pad });
        }
        this._tone({ f: mtof(root + k), t, type: 'sine', a: 0.2, h: barLen - 0.3, r: 0.4, g: 0.13, dest: L.pad });
      }
      if (s === 0 || s === 10) this._tone({ f: 130, f2: 44, sweep: 0.1, t, type: 'sine', a: 0.002, h: 0.03, r: 0.14, g: s === 0 ? 0.32 : 0.18, dest: L.kick });
      if (s % 4 === 2) this._noise({ t, ft: 'highpass', ff: 9000, a: 0.001, h: 0.004, r: 0.03, g: 0.026, dest: L.hats });
      return;
    }

    if (phase === 'outro') {
      // Calm: long soft pad, a sine bass on the one, a gentle triangle arp.
      if (s === 0) {
        for (let i = 0; i < chord.length; i++) {
          this._tone({ f: mtof(chord[i] + k), t, type: 'sawtooth', a: 0.8, h: barLen - 0.6, r: 1.3, g: 0.018, ft: 'lowpass', ff: 800, ff2: 1300, fq: 0.5, det: i * 6 - 6, dest: L.pad });
        }
        this._tone({ f: mtof(root + k), t, type: 'sine', a: 0.3, h: barLen - 0.4, r: 0.7, g: 0.11, dest: L.bass });
      }
      if (s % 4 === 2) {
        const m = chord[(s >> 2) % 3] + 12 + k;
        this._tone({ f: mtof(m), t, type: 'triangle', a: 0.01, h: 0.04, r: 0.4, g: 0.045, dest: L.arp, send: tr.send });
      }
      return;
    }

    // ---- racing (and the last few 16ths before a finish stinger)
    // Kick: pitched sine drop + tiny noise click.
    if (s % 4 === 0 && on('kick')) {
      this._tone({ f: 150, f2: 44, sweep: 0.11, t, type: 'sine', a: 0.002, h: 0.04, r: 0.16, g: 0.5, dest: L.kick });
      this._noise({ t, ft: 'lowpass', ff: 1800, a: 0.001, h: 0.004, r: 0.02, g: 0.06, dest: L.kick });
    }
    // Clap on 2 and 4.
    if ((s === 4 || s === 12) && on('clap')) {
      this._noise({ t, ft: 'bandpass', ff: 1600, fq: 1.2, a: 0.002, h: 0.02, r: 0.12, g: 0.12, dest: L.clap });
    }
    // Hats: open-ish on offbeats, 16th ticks once the race heats up.
    if (on('hats')) {
      if (s % 4 === 2) this._noise({ t, ft: 'highpass', ff: 7500, a: 0.001, h: 0.015, r: 0.05, g: 0.06, dest: L.hats });
      else if (s % 2 === 1 && (tr.I > 0.45 || f.lastLap)) this._noise({ t, ft: 'highpass', ff: 9000, a: 0.001, h: 0.004, r: 0.02, g: 0.028, dest: L.hats });
    }
    // Rolling bass (skips the kick hits for pump), octave pops.
    if (s % 4 !== 0 && on('bass')) {
      const m = (s % 4 === 3 ? root + 12 : root) + k;
      this._tone({ f: mtof(m), t, type: 'sawtooth', a: 0.004, h: sx * 0.55, r: 0.06, g: 0.12, ft: 'lowpass', ff: 900, ff2: 260, fq: 3, dest: L.bass });
    }
    // 16th arp, from the second bar onward so the loop builds in.
    if ((bar > 0 || f.lastLap) && on('arp')) {
      const idx = s % 4;
      let m = (idx === 3 ? chord[0] + 12 : chord[idx]) + 12;
      if ((bar - tr.prog) % 8 >= 4 && (s >> 2) % 2 === 1) m += 12;
      this._tone({ f: mtof(m + k), t, type: 'square', a: 0.003, h: 0.03, r: 0.08, g: 0.028, ft: 'lowpass', ff: 2400, fq: 1, dest: L.arp, send: tr.send });
    }
    // Drive: offbeat chord stabs (trance pump) at high intensity and on the last lap.
    if (s % 4 === 2 && on('drive')) {
      for (let i = 0; i < chord.length; i++) {
        this._tone({ f: mtof(chord[i] + 12 + k), t, type: 'sawtooth', a: 0.003, h: sx * 0.9, r: 0.07, g: 0.016, ft: 'lowpass', ff: 3200, ff2: 900, fq: 2, det: i * 5 - 5, dest: L.drive });
      }
    }
    // Last-lap lead: a bright 16th arpeggio two octaves up, into the echo.
    if (on('lead')) {
      const tones = LEAD_PAT[s];
      const m = (tones < 3 ? chord[tones] : chord[tones - 3] + 12) + 24 + k;
      this._tone({ f: mtof(m), t, type: 'square', a: 0.002, h: 0.025, r: 0.07, g: 0.02, ft: 'lowpass', ff: 3800, fq: 1.5, dest: L.lead, send: tr.send });
    }
    // Leader melody: a simple hook over the progression, only while you're in front.
    if (s % 2 === 0 && on('melody')) {
      const n = def.melody[ci][s >> 1];
      if (n) {
        const fq = mtof(n + 12 + k);
        this._tone({ f: fq, t, type: 'triangle', a: 0.01, h: sx * 1.4, r: 0.18, g: 0.045, dest: L.melody, send: tr.send });
        this._tone({ f: fq * 2, t, type: 'sine', a: 0.01, h: sx, r: 0.12, g: 0.01, dest: L.melody });
      }
    }
    // Thin pad for width.
    if (s === 0 && on('pad')) {
      for (let i = 0; i < chord.length; i++) {
        this._tone({ f: mtof(chord[i] + k), t, type: 'sawtooth', a: 0.3, h: barLen - 0.3, r: 0.4, g: 0.014, ft: 'lowpass', ff: 1400, fq: 0.5, dest: L.pad, det: i * 6 - 6 });
      }
    }
    // Fill into the last-lap lift: a snare roll that builds over the last half bar + a riser.
    if (racing && tr.liftBar >= 0 && !f.lastLap && bar === tr.liftBar - 1 && s >= 8) {
      const x = (s - 8) / 7;
      this._noise({ t, ft: 'bandpass', ff: 1700 + 1500 * x, fq: 1.3, a: 0.001, h: 0.012, r: 0.06, g: 0.035 + 0.09 * x, dest: tr.hits });
      if (s === 8) this._noise({ t, ft: 'bandpass', ff: 400, ff2: 8000, fq: 1.5, a: sx * 8, h: 0.005, r: 0.04, g: 0.06, dest: tr.hits });
    }
  }

  /** Supersonic entry: resonant filter sweep open (the cutoff itself ramps in _raceLevels) + a whoosh. */
  _ssSweep(tr, t) {
    const q = tr.lp.Q;
    q.setTargetAtTime(5, t, 0.04);
    q.setTargetAtTime(0.7, t + 0.45, 0.3);
    this._noise({ t, ft: 'bandpass', ff: 500, ff2: 9000, fq: 2, a: 0.32, h: 0.02, r: 0.25, g: 0.045, dest: tr.hits });
  }

  _crash(tr, t, g) {
    this._noise({ t, ft: 'highpass', ff: 4500, ff2: 7000, a: 0.001, h: 0.03, r: 1.4, g, dest: tr.hits });
    this._noise({ t, ft: 'bandpass', ff: 3200, fq: 0.8, a: 0.001, h: 0.01, r: 0.5, g: g * 0.5, dest: tr.hits });
  }

  /** Countdown riser: filtered noise + a saw sweeping up to E5, peaking on Go. */
  _riser(tr, t, dur) {
    this._noise({ t, ft: 'bandpass', ff: 350, ff2: 7000, fq: 1.6, a: dur, h: 0.01, r: 0.06, g: 0.08, dest: tr.hits });
    this._tone({ f: mtof(40), f2: mtof(76), sweep: dur, t, type: 'sawtooth', a: dur, h: 0.01, r: 0.06, g: 0.03, ft: 'lowpass', ff: 500, ff2: 5200, fq: 2, dest: tr.hits });
  }

  /** Go: a big kick, a sub drop and a crash on the downbeat of bar 1. */
  _impact(tr, t) {
    this._tone({ f: 160, f2: 40, sweep: 0.16, t, type: 'sine', a: 0.002, h: 0.05, r: 0.3, g: 0.6, dest: tr.hits });
    this._tone({ f: 70, f2: 30, sweep: 0.8, t, type: 'sine', a: 0.005, h: 0.1, r: 0.9, g: 0.22, dest: tr.hits });
    this._crash(tr, t, 0.13);
  }

  /**
   * Finish cadence on the beat grid: bVI - bVII - I. A win resolves to E major (Picardy third)
   * with a sparkle run; otherwise it settles on E minor. Transposed with the last-lap lift.
   */
  _stinger(tr, t, win) {
    const beat = tr.sixteenth * 4;
    const k = tr.key;
    const dest = tr.hits;
    const chords = win ? STING_WIN : STING_LOSE;
    const bass = [36, 38, 40];
    const g0 = win ? 0.05 : 0.038;
    for (let i = 0; i < 3; i++) {
      const ti = t + i * beat;
      const last = i === 2;
      const h = last ? beat * 2.6 : beat * 0.8;
      const r = last ? 1.6 : 0.14;
      const ch = chords[i];
      for (let j = 0; j < ch.length; j++) {
        this._tone({ f: mtof(ch[j] + k), t: ti, type: 'sawtooth', a: 0.012, h, r, g: g0, ft: 'lowpass', ff: last ? 4200 : 3400, ff2: 1100, fq: 1.1, det: j % 2 ? 7 : -7, dest, send: last ? tr.send : undefined });
      }
      this._tone({ f: mtof(bass[i] + k), t: ti, type: 'sine', a: 0.005, h, r: last ? 1.2 : 0.1, g: 0.2, dest });
      this._tone({ f: mtof(bass[i] + 12 + k), t: ti, type: 'sawtooth', a: 0.005, h: h * 0.9, r: 0.1, g: 0.035, ft: 'lowpass', ff: 900, dest });
      this._tone({ f: 150, f2: 44, sweep: 0.11, t: ti, type: 'sine', a: 0.002, h: 0.04, r: last ? 0.3 : 0.16, g: last ? 0.62 : 0.5, dest });
      if (i === 0 || last) this._crash(tr, ti, last ? 0.12 : 0.08);
    }
    const tl = t + 2 * beat;
    if (win) {
      const run = [76, 80, 83, 88, 92];
      for (let i = 0; i < run.length; i++) {
        this._tone({ f: mtof(run[i] + k), t: tl + tr.sixteenth * (1 + i), type: 'triangle', a: 0.003, h: 0.04, r: i === run.length - 1 ? 0.9 : 0.25, g: 0.05, dest, send: tr.send });
      }
    } else {
      const run = [83, 79, 76];
      for (let i = 0; i < run.length; i++) {
        this._tone({ f: mtof(run[i] + k), t: tl + beat * 0.5 * (1 + i), type: 'triangle', a: 0.01, h: 0.08, r: i === 2 ? 0.9 : 0.3, g: 0.04, dest, send: tr.send });
      }
    }
  }
}

/** tanh soft-clip curve normalised to +-1 (k = drive). */
function shaperCurve(k) {
  const n = 1024;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Tiny seeded PRNG for musical variation. */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
