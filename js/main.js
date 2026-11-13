// Starwake — app shell. Owns the renderer, the active 3D stage (title demo race,
// hangar, or a live race), the DOM screen on top, input, audio and multiplayer.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { createSpeedPass } from './space/speedfx.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { storage } from './core/storage.js';
import { loadCareer, recordRun, RunTracker } from './core/career.js';
import { AudioEngine } from './core/audio.js';
import { Input } from './core/input.js';
import { RaceFeel } from './core/feel.js';
import { mulberry32, randomId, $ } from './core/util.js';
import { randomDesign, normalizeDesign } from './craft/parts.js';
import { COURSES, getCourseDef, isCourseId, resolveCourseId } from './flight/courseDefs.js';
import { ARENAS, getArenaDef } from './flight/arenaDefs.js';
import { FlightRace } from './flight/flightRace.js';
import { HangarStage } from './world/hangarStage.js';
import { Hud } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { parseInvite } from './net/online.js';

const SKIP_PAD = ['confirm', 'back', 'pause', 'fire', 'missile', 'reset', 'camera', 'dodge'];
const AI_NAMES = ['Vex', 'Nova', 'Kestrel', 'Rook', 'Aurora', 'Juno', 'Talon', 'Mira', 'Orrin', 'Pike', 'Sable', 'Quill'];
const params = new URLSearchParams(location.search);

class App {
  constructor() {
    this.settings = storage.loadSettings();
    loadCareer(); // migrate old personal bests into medals before any new race is recorded
    if (!isCourseId(this.settings.trackId)) this.settings.trackId = COURSES[0].id;
    if (!ARENAS.some((a) => a.id === this.settings.arenaId)) this.settings.arenaId = ARENAS[0].id;
    this.canvas = $('#scene');
    this.uiRoot = $('#ui');
    this.hudRoot = $('#hud-root');
    this.labelsRoot = $('#labels');
    this.toastRoot = $('#toasts');
    this.fpsEl = $('#fps');
    this.timeScale = Math.max(0.1, Math.min(8, Number(params.get('timescale')) || 1));

    this._initRenderer();
    this.audio = new AudioEngine();
    this.input = new Input(window);
    this.input.setOptions({ sensitivity: this.settings.mouseSens, invertY: this.settings.invertY, rumble: this.settings.rumble !== false });
    this.feel = new RaceFeel(this); // adaptive race music + rumble cues
    this.input.onAnyInput(() => { this.audio.unlock(); this.audio.music(this.race && this.race.mode !== 'attract' ? 'race' : 'menu'); });
    this.applyAudioSettings();

    this.stage = null; // { scene, camera, update(dt,input), resize(w,h), dispose() }
    this.attract = null;
    this.hangar = null;
    this.race = null; // live race (not attract)
    this.hud = null;
    this.net = null;
    this.paused = false;
    this.screens = new Screens(this);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('error', (e) => this.toast(`Something went wrong: ${e.message}`, 'error'));
    window.addEventListener('unhandledrejection', (e) => this.toast(`Something went wrong: ${e.reason?.message || e.reason}`, 'error'));
    window.addEventListener('beforeunload', () => this.net?.leave());
    // Replays skip on any fresh key press or click (gamepad buttons are read in frame()).
    const skipReq = (e) => { if (!e.repeat) this._skipReq = true; };
    window.addEventListener('keydown', skipReq);
    window.addEventListener('pointerdown', skipReq);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.race && !this.paused && this.race.mode === 'solo' && !this.race.results) this.pause(true);
    });

    this.resize();
    this.last = performance.now();
    this.fpsAcc = 0; this.fpsFrames = 0;
    requestAnimationFrame((t) => this.frame(t));

    // Debug/testing hooks.
    window.__starwake = this;
    this.autopilot = params.get('autopilot') === '1';

    const quick = params.get('quick');
    const invite = parseInvite(location.search);
    this.ensureAttract().then(() => {
      $('#boot').classList.add('done');
      if (quick === 'race') this.startSoloRace({ trackId: params.get('track') || this.settings.trackId });
      else if (quick === 'battle') this.startSoloBattle({ arenaId: params.get('arena') || this.settings.arenaId });
      else if (invite) {
        // ?join=CODE invite link: go straight to joining. Drop it from the address bar so a
        // reload doesn't join again (a ?relay= param stays, it's still the relay to use).
        const clean = new URL(location.href);
        clean.searchParams.delete('join');
        clean.searchParams.delete('net');
        try { history.replaceState(null, '', clean); } catch { /* ignore */ }
        this.screens.show('lobbyEntry', { invite });
      } else this.screens.show('title');
    }).catch((err) => this.fatal(err));
  }

  _initRenderer() {
    const gl = this.canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, context: gl, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.applyQuality();
  }

  /** Device pixel ratio for the current quality, capped so high-DPI screens don't melt. */
  _pixelRatio() {
    const q = this.settings.quality;
    return Math.min(window.devicePixelRatio || 1, q === 'high' ? 1.75 : q === 'medium' ? 1.25 : 1);
  }

  applyQuality() {
    const q = this.settings.quality;
    document.documentElement.dataset.quality = q; // CSS drops backdrop blur on Low
    this.renderer.setPixelRatio(this._pixelRatio());
    if (this.composer) {
      // EffectComposer.dispose() frees only its own two buffers: the passes (bloom's mip chain,
      // the speed pass) have to be freed here or every quality change strands their targets.
      for (const pass of this.composer.passes) pass.dispose?.();
      this.composer.dispose();
      this.composer = null; this.speedPass = null; this.bloom = null; this.renderPass = null;
    }
    if (q !== 'low') {
      // The scene is drawn into the composer's buffer, not the canvas, so the canvas's own
      // antialiasing never touches it: multisample the buffer instead (resolved before bloom).
      // (CSS-pixel size here: the composer scales by the pixel ratio itself, and resize() below sets the real size.)
      const target = new THREE.WebGLRenderTarget(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), { type: THREE.HalfFloatType, samples: q === 'high' ? 4 : 2 });
      this.composer = new EffectComposer(this.renderer, target);
      this.renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
      this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), q === 'high' ? 0.7 : 0.6, 0.5, 0.82);
      this.baseBloom = this.bloom.strength;
      this.composer.addPass(this.renderPass);
      // Speed pass (radial blur + edge aberration), driven by the race's SpeedFX; off when idle.
      this.speedPass = createSpeedPass();
      this.speedPass.enabled = false;
      this.composer.addPass(this.speedPass);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.resize();
  }

  applyAudioSettings() {
    const s = this.settings;
    this.audio.setVolumes({ master: s.masterVol, sfx: s.sfxVol, music: s.musicVol });
  }

  saveSettings(patch) {
    const prevQuality = this.settings.quality;
    Object.assign(this.settings, patch);
    storage.saveSettings(this.settings);
    this.applyAudioSettings();
    if (patch.quality && patch.quality !== prevQuality) this.applyQuality();
    if ('mouseSens' in patch || 'invertY' in patch || 'rumble' in patch) this.input.setOptions({ sensitivity: this.settings.mouseSens, invertY: this.settings.invertY, rumble: this.settings.rumble !== false });
    this.fpsEl.hidden = !this.settings.showFps;
    if (this.race) Object.assign(this.race.settings, this.settings);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    // The window can move to a screen with a different pixel density (or the page can zoom).
    const ratio = this._pixelRatio();
    if (ratio !== this.renderer.getPixelRatio()) { this.renderer.setPixelRatio(ratio); this.composer?.setPixelRatio(ratio); }
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.stage?.resize?.(w, h);
  }

  // ------------------------------------------------------------ stages
  async ensureAttract() {
    if (this.attract) { this.setStage(this.attract); return; }
    await nextFrame();
    const track = COURSES[Math.floor(Math.random() * COURSES.length)];
    const rng = mulberry32(Date.now() & 0xffff);
    const roster = Array.from({ length: 6 }, (_, i) => ({ id: 'demo' + i, name: AI_NAMES[i], kind: 'ai', design: randomDesign(rng, AI_NAMES[i]) }));
    this.attract = new FlightRace({
      renderer: this.renderer, trackId: track.id, laps: 999, roster, mode: 'attract', seed: 3,
      settings: { ...this.settings, difficulty: 'hard', quality: this.settings.quality === 'high' ? 'medium' : this.settings.quality },
    });
    // Let the pack spread out before anyone sees it.
    this.attract.warmup(6);
    this.setStage(this.attract);
  }

  setStage(stage) {
    this.stage = stage;
    this.resize();
  }

  showHangarStage() {
    if (!this.hangar) this.hangar = new HangarStage(this.renderer);
    this.setStage(this.hangar);
    return this.hangar;
  }

  async backToAttract() {
    this.endRace();
    await this.ensureAttract();
    this.audio.music('menu');
  }

  // ------------------------------------------------------------ races
  playerDesign() { return normalizeDesign(storage.selectedDesign()); }

  async startSoloRace(opts = {}) {
    const s = this.settings;
    const trackId = resolveCourseId(opts.trackId || s.trackId); // 'daily' -> today's daily id
    const aiCount = opts.aiCount ?? s.aiCount;
    const laps = opts.laps ?? s.laps;
    const seed = (Math.random() * 1e9) | 0;
    const rng = mulberry32(seed);
    const names = [...AI_NAMES].sort(() => rng() - 0.5);
    const roster = [];
    for (let i = 0; i < aiCount; i++) roster.push({ id: 'ai-' + i, name: names[i], kind: 'ai', design: randomDesign(rng, names[i]) });
    roster.push({ id: 'me', name: s.playerName || 'Pilot', kind: 'player', design: this.playerDesign() });
    this.lastSolo = { game: 'race', trackId, aiCount, laps };
    await this.launchRace({ game: 'race', trackId, laps, roster, mode: 'solo', seed });
  }

  async startSoloBattle(opts = {}) {
    const s = this.settings;
    const arenaId = opts.arenaId || s.arenaId;
    const bots = opts.bots ?? s.battleBots;
    const target = opts.target ?? s.battleTarget;
    const timeLimit = opts.timeLimit ?? s.battleTime;
    const teams = opts.teams ?? !!s.battleTeams;
    const seed = (Math.random() * 1e9) | 0;
    const rng = mulberry32(seed);
    const names = [...AI_NAMES].sort(() => rng() - 0.5);
    const roster = [];
    // Teams: you're Blue; bots alternate Red/Blue so the sides stay even (Red gets the spare).
    for (let i = 0; i < bots; i++) roster.push({ id: 'ai-' + i, name: names[i], kind: 'ai', design: randomDesign(rng, names[i]), team: i % 2 === 0 ? 1 : 0 });
    roster.push({ id: 'me', name: s.playerName || 'Pilot', kind: 'player', design: this.playerDesign(), team: 0 });
    this.lastSolo = { game: 'battle', arenaId, bots, target, timeLimit, teams };
    await this.launchRace({ game: 'battle', teams, trackId: arenaId, target, timeLimit, roster, mode: 'solo', seed });
  }

  /** Same settings again (results "Play again", pause "Restart"). */
  restartSolo() {
    const last = this.lastSolo || {};
    return last.game === 'battle' ? this.startSoloBattle(last) : this.startSoloRace(last);
  }

  /** Called on every client when the host starts a multiplayer race. */
  async startNetRace(detail) {
    const net = this.net;
    const roster = detail.roster.map((r) => ({
      ...r,
      design: normalizeDesign(r.design),
      kind: r.id === net.selfId ? 'player' : (r.ai && net.isHost ? 'ai' : 'remote'),
    }));
    // Pole goes to AI, humans start in lobby order behind them.
    const game = detail.game === 'battle' ? 'battle' : 'race';
    await this.launchRace({ game, teams: detail.teams && game === 'battle', hazards: detail.hazards, trackId: detail.trackId, laps: detail.laps, target: detail.target, timeLimit: detail.timeLimit, roster, mode: 'multi', seed: detail.seed, goAt: performance.now() + (detail.countdownMs || 6000) });
  }

  async launchRace({ game = 'race', teams = false, hazards, trackId, laps, target, timeLimit, roster, mode, seed, goAt }) {
    this.endRace();
    const battle = game === 'battle';
    this.screens.show('loading', { trackId, game });
    await nextFrame(); await nextFrame();
    if (mode === 'multi' && !this.net) return; // the connection dropped while loading; 'closed' already went to the menu
    try {
      this.race = new FlightRace({
        renderer: this.renderer, game, teams, hazards, trackId: battle ? getArenaDef(trackId).id : getCourseDef(trackId).id, laps, target, timeLimit,
        roster, mode, seed, net: mode === 'multi' ? this.net : null,
        settings: { ...this.settings }, autopilot: this.autopilot, goAt,
        ghost: mode === 'solo' && !battle && this.settings.ghost ? storage.loadGhost(getCourseDef(trackId).id, laps) : null,
        onEvent: (e) => this.onRaceEvent(e),
      });
    } catch (err) {
      console.error(err);
      this.screens.show('error', { message: `Couldn't load the ${battle ? 'arena' : 'course'}: ${err.message}` });
      return;
    }
    this.run = new RunTracker(); // career: laps, clean laps, demolitions for the results
    this.hud = new Hud(this.hudRoot, this.race);
    this.hud.hint(this.input.activeDevice === 'gamepad'
      ? 'Left stick aim · RT thrust · RB fire · LB missile · A boost · Y reset'
      : battle
        ? `Mouse aims · W thrust · Left click fire · Right click missile · Space boost · ${this.race.teams ? `You're on Blue — first team to ${this.race.target} kills` : `First to ${this.race.target} kills`}`
        : 'Mouse steers · W thrust · Space boost · Let go of the mouse and the ship follows the tunnel');
    this.setStage(this.race);
    this.screens.show('race');
    this.input.setRaceMode(true);
    this.canvas.classList.add('in-race');
    this.paused = false;
    this.audio.music('race');
    this.audio.duck(false);
  }

  endRace() {
    if (this.race) {
      this.race.dispose();
      this.race = null;
    }
    this.hud?.dispose();
    this.hud = null;
    this.labelsRoot.innerHTML = '';
    this.input.setRaceMode(false);
    this.input.exitPointerLock();
    this.canvas.classList.remove('in-race');
    this.paused = false;
    this.audio.setEngine({ active: false, speedN: 0, throttle: 0, boost: false });
  }

  pause(on) {
    if (!this.race || this.race.results) return;
    this.paused = on;
    this.race.paused = on;
    this.audio.duck(on);
    this.input.setRaceMode(!on);
    if (on) this.input.exitPointerLock();
    this.canvas.classList.toggle('in-race', !on);
    if (on) this.screens.overlay('pause');
    else this.screens.closeOverlay();
  }

  onRaceEvent(e) {
    const hud = this.hud;
    const a = this.audio;
    this.run?.event(e);
    this.feel.event(e);
    switch (e.type) {
      case 'countdown': a.play('countdown'); hud?.center(String(e.n), 'count'); break;
      case 'go': a.play('go'); hud?.center('Go', 'go'); hud?.hint(''); break;
      case 'ring': a.play('ring', { streak: e.streak }); if (e.streak >= 3) hud?.flash(`Boost gate ×${e.streak}`, 900, 'good'); break;
      case 'scrape': a.play('wall', { intensity: 0.15 + e.intensity * 0.45 }); this.input.rumble(0.15 + e.intensity * 0.3, 90); break;
      case 'autoReset': hud?.flash('Back on track', 1300); break;
      case 'battleOver':
        a.play(e.you ? 'finish' : 'finalLap');
        hud?.center(e.you ? 'Victory' : e.winner === 'Draw' ? 'Draw' : e.reason === 'time' && !e.team ? 'Time' : `${e.winner} wins`, 'finish');
        break;
      case 'lap':
        if (e.final) { a.play('finalLap'); hud?.flash('Final lap', 2000, 'warn'); }
        else { a.play('lap'); hud?.flash(e.best ? 'Lap — personal best' : 'Lap', 1500); }
        break;
      case 'laser': a.play('laser', { volume: e.volume }); break;
      case 'hitConfirm': a.play('laserHit', { volume: 0.7 }); break;
      case 'missileLaunch': a.play('missileLaunch', { volume: e.player ? 1 : 0.5 }); break;
      case 'noMissiles': hud?.flash('No missiles — break cargo pods for more', 1400, 'warn'); a.play('error'); break;
      case 'locking': a.play('locking'); break;
      case 'locked': a.play('locked'); break;
      case 'hurt':
        a.play(e.shieldOnly ? 'shieldHit' : 'hullHit');
        hud?.damage(e.amount, e.shieldOnly);
        this.input.rumble(e.shieldOnly ? 0.25 : 0.6, 160);
        break;
      case 'shieldDown': a.play('shieldDown'); break;
      case 'overheat': a.play('overheat'); break;
      case 'boostStart': a.play('boostStart'); break;
      case 'explosion': a.play('explosion', { size: e.size, distance: e.distance, ship: !!e.ship }); break;
      case 'debris': a.play('debris', { size: e.size, kind: e.kind, distance: e.distance }); break;
      case 'dodge': a.play('dodge', { pan: e.dir * 0.4 }); this.input.rumble(0.25, 80); break;
      case 'shatter': a.play('shatter', { size: e.size, kind: e.kind, volume: 1 - e.distance * 0.8 }); break;
      case 'pickup': a.play('pickup', { kind: e.kind }); hud?.flash(e.kind === 'missile' ? '+1 missile' : e.kind === 'shield' ? 'Shields restored' : 'Boost refilled', 1100); break;
      case 'kill': hud?.flash(`${e.demo ? 'Demolished' : 'Destroyed'} ${e.name}`, 1600, 'good'); break;
      case 'demolition': a.play(a.has?.('demolition') ? 'demolition' : 'explosion', { size: 1, distance: e.distance || 0 }); break;
      case 'droneKill': a.play('shatter', { size: e.warden ? 0.9 : 0.5, kind: 'crystal' }); hud?.flash(e.warden ? 'Vesk warden down' : 'Vesk drone down', 1100, 'good'); break;
      case 'alienFire': a.play('laser', { volume: 0.3 * (1 - e.distance) }); break;
      case 'vesk':
        a.play('missileWarn');
        hud?.flash(e.what === 'wave' ? 'Vesk swarm inbound' : 'Vesk ambush ahead', 1800, 'warn');
        break;
      case 'destroyed': this.input.rumble(1, 500); break;
      case 'respawn': a.play('respawn'); break;
      case 'bump':
        a.play(a.has?.('bump') ? 'bump' : 'wall', { intensity: (e.intensity ?? 0.3) * (e.mine === false ? 1 - (e.distance || 0) * 0.8 : 1) });
        if (e.mine !== false) this.input.rumble(0.3 + (e.intensity || 0.3) * 0.5, 120);
        break;
      // Rocket League / pod-racer feel cues (sounds fall back gracefully if missing).
      case 'boostPad': a.play(a.has?.('boostPad') ? 'boostPad' : 'pickup', { big: e.big, kind: 'boost' }); break;
      case 'nearMiss': a.play(a.has?.('nearMiss') ? 'nearMiss' : 'ring', { streak: 1 }); break;
      case 'supersonic': if (e.player) a.play(a.has?.('sonicBoom') ? 'sonicBoom' : 'boostStart', { distance: e.distance }); break;
      case 'deflect': a.play(a.has?.('deflect') ? 'deflect' : 'shieldHit', { volume: 0.6 }); break;
      case 'passBy': if (a.has?.('passBy')) a.play('passBy', { pan: e.pan, speed: e.speed, distance: e.distance }); break;
      case 'finish': a.play('finish'); hud?.center(e.rank === 1 ? 'Winner' : 'Finished', 'finish'); break;
      case 'results': this.onResults(e.results, e.teams); break;
      case 'toast': this.toast(e.text); break;
      default: break;
    }
  }

  onResults(results, teams = null) {
    const me = results.find((r) => r.id === this.race?.player?.id);
    const rank = me ? results.indexOf(me) + 1 : null;
    let records = { raceBest: false, lapBest: false };
    if (me && !me.dnf && !this.race.battle) records = storage.submitRecord(this.race.def.id, this.race.laps, me.time, me.bestLap);
    if (me && !me.dnf && this.race.ghostRun?.result) storage.saveGhost(this.race.ghostRun.result);
    this.audio.play(rank === 1 ? 'win' : 'lose');
    this.audio.duck(true);
    this.input.setRaceMode(false);
    this.input.exitPointerLock();
    this.canvas.classList.remove('in-race');
    teams = teams || (this.race.teams ? this.race.teamScores() : null);
    let career = null;
    try {
      // Local-only progression; never allowed to get in the way of the results.
      const team = teams && me?.team != null ? (teams[0] === teams[1] ? 'draw' : (teams[0] > teams[1]) === (me.team === 0) ? 'win' : 'loss') : null;
      career = recordRun({
        game: this.race.game, mode: this.race.mode, def: this.race.battle ? null : this.race.def, laps: this.race.laps,
        skill: this.settings.difficulty, finished: !!me && !me.dnf && me.time != null, time: me?.time ?? null,
        rank, field: results.length, personalBest: records.raceBest, team,
        ...(this.run?.summary() || {}),
      });
    } catch (err) { console.warn('Career update skipped:', err); }
    this.run = null;
    this.resultsProps = { results, rank, records, mode: this.race.mode, trackName: this.race.def.name, game: this.race.game, teams, career };
    this.screens.overlay('results', this.resultsProps);
  }

  /** Results "Watch highlights": play the clips, then bring the results back. */
  watchHighlights() {
    const race = this.race, props = this.resultsProps;
    if (!race?.replays || race.replays.playing || !props) return;
    this.screens.closeOverlay();
    const back = () => { if (this.race === race) this.screens.overlay('results', props); };
    if (!race.replays.playHighlights(back)) back();
  }

  toast(text, tone = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + tone;
    el.textContent = text;
    this.toastRoot.appendChild(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3800);
  }

  fatal(err) {
    console.error(err);
    $('#boot').classList.add('done');
    this.screens.show('error', { message: err.message || String(err), fatal: true });
  }

  // ------------------------------------------------------------ loop
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const frameSec = (now - this.last) / 1000;
    const rawDt = Math.min(0.05, frameSec);
    this.last = now;
    const dt = rawDt * this.timeScale;
    const input = this.input.poll();

    // Global UI navigation (gamepad) and back.
    this.screens.handleInput(this.input);

    if (this.race && this.stage === this.race && !this.race.results && !this.race.replays?.playing) {
      if (this.input.pressed('pause') || (this.input.pressed('lockLost') && !this.paused)) this.pause(!this.paused);
      // Capture the mouse on the first click into the race (where the browser allows it).
      if (!this.paused && this.settings.lockMouse && !this.input.pointerLocked && this.input.pressed('fire') && this.input.activeDevice !== 'gamepad') this.input.requestPointerLock(this.canvas);
      if (!this.paused) {
        if (this.input.pressed('reset')) this.race.respawnPlayer();
        if (this.input.pressed('camera')) {
          const mode = this.race.toggleCamera();
          this.saveSettings({ cameraMode: mode });
        }
      }
    }

    const replays = this.race?.replays;
    if (replays?.playing && (this._skipReq || SKIP_PAD.some((a) => this.input.pressed(a)))) replays.skip();
    this._skipReq = false;

    try {
      const live = this.race && this.stage === this.race;
      const idle = { throttle: 0, brake: 0, boost: false, roll: 0, aimX: 0, aimY: 0, fire: false, missile: false };
      const driveInput = live && this.paused ? idle : input;
      if (driveInput && live && !this.paused) {
        driveInput.missileEdge = this.input.pressed('missile');
        // Dodge: double-tapped roll key picks the side; X / pad B dodge toward the stick (or right).
        const side = this.input.pressed('dodgeLeft') ? -1 : this.input.pressed('dodgeRight') ? 1 : 0;
        driveInput.dodgeEdge = side || (this.input.pressed('dodge') ? Math.sign(driveInput.roll || driveInput.aimX) || 1 : 0);
      }
      if (live && this.timeScale > 1) {
        // Debug fast-forward: substep the race so physics stay stable.
        const n = Math.ceil(this.timeScale);
        for (let i = 0; i < n; i++) this.stage.update(rawDt, driveInput, i === n - 1);
      } else {
        this.stage?.update(dt, driveInput);
      }
      if (live && this.hud) this.hud.update(rawDt, this.race.hud());
      this.audio.setEngine(live && !this.race.results ? this.race.audioState() : { active: false, speedN: 0, throttle: 0, boost: false });
      this.feel.frame(rawDt);
      this.render();
    } catch (err) {
      console.error(err);
      if (!this._loopErrorShown) { this._loopErrorShown = true; this.toast(`Render error: ${err.message}`, 'error'); }
    }

    this.input.endFrame();

    this.fpsFrames++; this.fpsAcc += frameSec;
    if (this.fpsAcc >= 0.5) {
      if (this.settings.showFps) this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} fps`;
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsFrames = 0; this.fpsAcc = 0;
    }
  }

  render() {
    const st = this.stage;
    if (!st) return;
    if (this.composer) {
      this.bloom.strength = st.bloomStrength ?? this.baseBloom;
      this.renderPass.scene = st.scene;
      if (this.speedPass) {
        if (st.speedFx) { if (st.speedFx.pass !== this.speedPass) st.speedFx.attachPass(this.speedPass); }
        else this.speedPass.enabled = false;
      }
      this.renderPass.camera = st.camera;
      this.composer.render();
    } else {
      this.renderer.render(st.scene, st.camera);
    }
  }

  newId() { return randomId(8); }
}

function nextFrame() { return new Promise((r) => requestAnimationFrame(() => r())); }

function boot() {
  try {
    new App();
  } catch (err) {
    console.error(err);
    const boot = document.getElementById('boot');
    boot.classList.add('failed');
    boot.querySelector('.boot-msg').textContent = err.message.includes('WebGL')
      ? 'Starwake needs WebGL 2. Turn on hardware acceleration in your browser settings, or try a recent Chrome, Edge, Firefox or Safari.'
      : `Starwake couldn't start: ${err.message}`;
  }
}
boot();
