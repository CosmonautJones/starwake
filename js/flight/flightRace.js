// One match: a wormhole race or an arena battle (or the attract-mode demo behind the
// menus). Owns the scene, every ship, the camera, weapons, the world, effects and
// multiplayer sync.

import * as THREE from 'three';
import { Course } from './course.js';
import { getCourseDef } from './courseDefs.js';
import { Arena } from './arena.js';
import { getArenaDef } from './arenaDefs.js';
import { BattleAI } from './battleAI.js';
import { Tunnel } from '../space/tunnel.js';
import { Hazards, spawnHazardDrop } from './hazards.js';
import { HazardViews } from '../space/hazardViews.js';
import { BoostPads, BoostPadViews } from './pads.js';
import { Debris, tunnelBounds } from '../space/debris.js';
import { SpeedFX } from '../space/speedfx.js';
import { SpaceWorld } from './world.js';
import { ShipSim } from './ship.js';
import { FlightAI } from './ai.js';
import { WeaponSystem, WeaponView, MISSILE, LASER, clampCone } from './weapons.js';
import { PlayerAssist, leadPoint } from './assist.js';
import { SpaceSky } from '../space/sky.js';
import { RockBelt } from '../space/rocks.js';
import { buildProp, disposeProp, updateProps } from '../space/props.js';
import { Shatter, Explosions, SpaceDust } from '../space/fx.js';
import { Trail, Sparks } from '../world/fx.js';
import { buildCraft } from '../craft/craftMesh.js';
import { computeStats } from '../craft/parts.js';
import { clamp, damp, hashString, mulberry32 } from '../core/util.js';
import { ReplayDirector } from './replay.js';
import { GhostRun } from '../space/ghostView.js';

const FIXED_DT = 1 / 120;
const COUNTDOWN = 3;
const INTRO = 2.4;
const NET_SEND_INTERVAL = 0.05;
const INTERP_DELAY = 110;
const LASER_DAMAGE = LASER.damage;
const HIT_STOP = 0.35, HIT_STOP_SCALE = 0.35; // solo only: a beat of slow time when you demolish someone

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _x = new THREE.Vector3(), _q = new THREE.Quaternion();
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
const FWD = new THREE.Vector3(0, 0, -1);
const PICKUP_COLORS = { boost: '#ffb547', missile: '#ff5a6a', shield: '#5ee7ff' };
const GATE_COLOR = '#ffb547';
/** Team identities for team play. */
export const TEAMS = [
  { name: 'Blue crew', short: 'Blue', color: '#4da3ff' },
  { name: 'Red crew', short: 'Red', color: '#ff4d5e' },
];

export class FlightRace {
  constructor(o) {
    this.o = o;
    this.mode = o.mode;
    this.settings = o.settings || {};
    this.quality = this.settings.quality || 'high';
    this.laps = o.laps;
    this.seed = o.seed ?? 1;
    this.net = o.net || null;
    this.onEvent = o.onEvent || (() => {});

    this.game = o.game === 'battle' ? 'battle' : 'race';
    this.teams = !!o.teams;
    this.battle = this.game === 'battle';
    this.target = clamp(Math.round(o.target || 10), 1, 99);
    this.timeLimit = clamp(Math.round(o.timeLimit || 300), 30, 3600);
    this.def = this.battle ? getArenaDef(o.arenaId || o.trackId) : getCourseDef(o.trackId);
    this.course = this.battle ? new Arena(this.def) : new Course(this.def);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 20000);
    this.scene.add(this.camera);

    // Props are built once; the gameplay world asks them for collision shapes.
    this.propCache = new Map();
    this.world = new SpaceWorld(this.course, {
      colliderFor: (type, seed) => {
        if (!type || type === 'mine') return null;
        const prop = this._prop(type, seed);
        return prop.colliders;
      },
    });

    this.sky = new SpaceSky(o.renderer, this.scene, this.def.theme, { quality: this.quality });
    this._buildBelts();
    this._buildItems();
    this._buildRings();
    this.tunnel = this.battle ? null : new Tunnel(this.scene, this.course, { color: this.def.theme.accent, quality: this.quality });
    this.pickupViews = new Map();

    this.sparks = new Sparks(this.scene, this.quality === 'low' ? 300 : 700);
    this.shatter = new Shatter(this.scene, { max: this.quality === 'low' ? 250 : 500 });
    this.explosions = new Explosions(this.scene, { max: 24 });
    this.dust = this.mode === 'attract' ? null : new SpaceDust(this.scene, { count: this.quality === 'low' ? 300 : 700 });
    // Destruction: ships and rocks break into real tumbling pieces.
    this.debris = new Debris(this.scene, {
      quality: this.quality, reduceMotion: !!this.settings.reduceMotion,
      onImpact: (pos, speed, kind) => { if (this._near(pos, 200)) this.onEvent({ type: 'debris', size: clamp(speed / 60, 0.2, 1), kind, distance: this._distN(pos) }); },
    });
    this._debrisBounds = this.battle ? null : tunnelBounds(this.course);
    // Speed sensation around the focus ship (streaks, wall sparks, supersonic shock cone).
    this.speedFx = this.mode === 'attract' ? null : new SpeedFX(this.scene, this.camera, { quality: this.quality, reduceMotion: !!this.settings.reduceMotion });
    this.weapons = new WeaponSystem(this.world);
    this.weaponView = new WeaponView(this.scene, this.weapons, { quality: this.quality });

    // Hazards: drifting plasmoids and the Vesk swarm. Plasmoids are deterministic on every
    // client; drones are simulated by the solo player or the multiplayer host.
    this.hazardLevel = clamp(o.hazards ?? this.settings.hazards ?? 0.6, 0, 1);
    this.hz = null;
    if (this.hazardLevel > 0) {
      this.hz = new Hazards(this.course, this.world, { seed: this.seed, game: this.game, intensity: this.hazardLevel, authority: this.mode !== 'multi' || !!o.net?.isHost });
      this.hzViews = new HazardViews(this.scene, this.hz, { quality: this.quality });
      this.hzSendT = 0;
    }
    // Boost pads (race only): small ones on the safe lanes, big ones out by the wall.
    this.pads = new BoostPads(this.course, this.world);
    this.padViews = this.pads.pads.length ? new BoostPadViews(this.scene, this.pads) : null;
    this.padFlash = null; this.nearMissT = 99; this.demos = 0;

    this.entities = [];
    o.roster.forEach((r, i) => this._addEntity(r, i));
    this.player = this.entities.find((e) => e.kind === 'player') || null;
    this.focus = this.player || this.entities[0];

    this.state = this.mode === 'attract' ? 'racing' : 'intro';
    this.stateTime = 0;
    this.raceTime = 0;
    this.acc = 0;
    this.countdownShown = -1;
    this.paused = false;
    this.results = null;
    this.finishWait = 0;
    this.netSendT = 0;
    this.cameraMode = this.settings.cameraMode === 'hood' ? 'hood' : 'chase';
    this.shake = 0;
    this.time = 0;
    this.cam = { quat: new THREE.Quaternion(), pos: new THREE.Vector3(), fov: 70, shotT: 0, shot: 0, target: null, fixed: new THREE.Vector3() };
    this.firstHumanFinish = null;
    this.autopilot = !!o.autopilot;
    if (this.player && this.autopilot) this.player.ai = this._makeAI(this.player, 'hard', 99);
    this.aim = { x: 0, y: 0, px: 0, py: 0, dir: new THREE.Vector3(0, 0, -1), onTarget: null };
    this.lock = { id: null, t: 0, locked: false };
    this.hitMarker = 0;
    this.killFeed = [];
    this.incoming = false;
    this.lastRingIdx = -1;
    this.standings = [...this.entities];

    // Replays (finish replay, highlights) for real matches; a ghost of your best run in solo races.
    this.replays = this.mode === 'attract' ? null : new ReplayDirector(this);
    this.ghostRun = this.mode === 'solo' && !this.battle && this.player
      ? new GhostRun(this.scene, { saved: o.ghost || null, courseId: this.def.id, laps: this.laps, design: this.player.design }) : null;
    this.hitStop = 0;

    if (this.net) this._bindNet();
    this._updateRingStates(true);
    this._snapCamera();
  }

  // ---------------------------------------------------------------- building
  _prop(type, seed) {
    const key = type + ':' + seed;
    let p = this.propCache.get(key);
    if (!p) { p = buildProp(type, { seed }); this.propCache.set(key, p); }
    return p;
  }

  _buildBelts() {
    const samples = this.course.samples;
    const avoid = (p, r) => {
      for (let i = 0; i < samples.length; i += 8) if (samples[i].distanceToSquared(p) < (r + 220) * (r + 220)) return true;
      return false;
    };
    const scale = this.quality === 'low' ? 0.4 : this.quality === 'medium' ? 0.7 : 1;
    this.belts = (this.def.belts || []).map((b, i) => new RockBelt(this.scene, { ...b, count: Math.round(b.count * scale), seed: hashString(this.def.id) + i, avoid }));
  }

  _buildItems() {
    this.itemViews = new Map();
    for (const it of this.world.items) {
      let obj, tint = null;
      if (it.type === 'mine') obj = mineMesh();
      else {
        const t = it.type === 'boulder' ? 'asteroid' : it.type === 'boulderIce' ? 'ice' : it.type;
        const prop = this._prop(t, it.seed);
        obj = prop.object;
        if (prop.__used) {
          // Same type+seed placed twice: build a separate instance.
          const p2 = buildProp(t, { seed: it.seed });
          this.propCache.set(t + ':' + it.seed + ':' + it.id, p2);
          obj = p2.object;
        }
        prop.__used = true;
        tint = prop.tint || null;
      }
      obj.position.copy(it.pos);
      obj.quaternion.copy(it.quat);
      obj.scale.setScalar(it.scale);
      this.scene.add(obj);
      this.itemViews.set(it.id, { obj, flash: 0, grow: 1, tint });
    }
  }

  /** Optional boost gates inside the wormhole (race only). */
  _buildRings() {
    this.ringBase = new THREE.Color(GATE_COLOR);
    this.ringViews = [];
    const notchGeo = new THREE.BoxGeometry(2.2, 0.22, 0.22);
    for (const r of this.course.rings) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: this.ringBase.clone(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const torus = new THREE.Mesh(new THREE.TorusGeometry(r.radius, 0.42, 8, 72), mat);
      g.add(torus);
      const notchMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffffff'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      // Chevron-ish ticks round the gate, one instanced draw call.
      const ticks = 6;
      const inst = new THREE.InstancedMesh(notchGeo, notchMat, ticks);
      const m4 = new THREE.Matrix4(), qz = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
      for (let k = 0; k < ticks; k++) {
        const a = (k / ticks) * Math.PI * 2;
        qz.setFromAxisAngle(_v.set(0, 0, 1), a);
        m4.compose(_w.set(Math.cos(a) * r.radius, Math.sin(a) * r.radius, 0), qz, one);
        inst.setMatrixAt(k, m4);
      }
      g.add(inst);
      const haloMat = new THREE.MeshBasicMaterial({ color: this.ringBase.clone(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const halo = new THREE.Mesh(new THREE.TorusGeometry(r.radius, 2, 8, 72), haloMat);
      g.add(halo);
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r.right, r.up, r.normal));
      g.position.copy(r.pos);
      this.scene.add(g);
      this.ringViews.push({ g, mat, notchMat, halo, haloMat, torus, flash: 0 });
    }
  }

  _updateRingStates(force = false) {
    const f = this.focus?.sim;
    const next = f ? f.nextRing : 0;
    if (!force && next === this.lastRingIdx) return;
    this.lastRingIdx = next;
    const N = this.ringViews.length;
    this.ringViews.forEach((v, i) => {
      const d = (i - next + N) % N;
      const isNext = d === 0, isAfter = d === 1;
      const c = this.ringBase.clone().multiplyScalar(isNext ? 2.1 : isAfter ? 1.2 : 0.6);
      v.mat.color.copy(c);
      v.mat.opacity = isNext || isAfter ? 1 : 0.55;
      v.notchMat.opacity = isNext ? 1 : isAfter ? 0.6 : 0.25;
      v.haloMat.opacity = isNext ? 0.22 : 0;
      v.isNext = isNext;
    });
  }

  _addEntity(r, i) {
    const design = r.design;
    const stats = computeStats(design);
    const spawn = this.course.gridSlot(i);
    const sim = new ShipSim(this.course, stats.physics, spawn, r.id);
    if (this.battle) sim.spawnPicker = () => this.course.pickSpawn(this.entities.filter((x) => x.sim !== sim && x.connected && !x.sim.dead).map((x) => x.sim.pos));
    else if (r.kind === 'player') sim.assist = clamp(this.settings.trackAssist ?? 0.7, 0, 1);
    if (r.kind === 'player') sim.levelAssist = clamp(this.settings.flightAssist ?? 0.7, 0, 1);
    const craft = buildCraft(design, { lod: this.quality === 'low' ? 'low' : 'high', underglow: false });
    this.scene.add(craft.root);
    this.debris?.prepare(craft); // pre-split so a death costs nothing mid-race
    const e = {
      id: r.id, name: r.name, kind: r.kind, design, stats, sim, craft, index: i,
      isAI: !!r.ai || r.kind === 'ai', ai: null, trails: [], lean: 0,
      rank: i + 1, bestLap: null, finishTime: null, kills: 0, deaths: 0, buffer: [], connected: true,
      color: new THREE.Color(design.colors.glow),
      input: { throttle: 0, brake: 0, boost: false, roll: 0, aimX: 0, aimY: 0, fire: false, missile: false, aimDir: new THREE.Vector3(0, 0, -1) },
      lastDead: false, local: r.kind !== 'remote',
      team: this.teams ? (r.team === 1 ? 1 : 0) : null,
    };
    if (this.teams) {
      this.weapons.teams.set(e.id, e.team);
      e.color = new THREE.Color(TEAMS[e.team].color); // bolts in team colour
      craft.setTeamColor?.(TEAMS[e.team].color);
    }
    if (r.kind === 'ai') e.ai = this._makeAI(e, this.settings.difficulty || 'normal', hashString(r.id) + this.seed);
    const noz = [...craft.nozzles].sort((a, b) => a.pos.x - b.pos.x);
    const pick = noz.length > 1 ? [noz[0], noz[noz.length - 1]] : noz;
    for (const n of pick) e.trails.push({ nozzle: n, trail: new Trail(this.scene, craft.glowColor, { length: this.quality === 'low' ? 14 : 22, width: n.r * 0.4 }) });
    this.entities.push(e);
    this._placeMesh(e, 0);
  }

  _makeAI(e, skill, seed) {
    const world = this.hz ? this.hz.aiWorld(this.world) : this.world;
    return this.battle ? new BattleAI(e, world, { skill, seed, weapons: this.weapons }) : new FlightAI(e, world, { skill, seed });
  }

  /** Ships plus Vesk drones, for AI target choice and the player's aim assist. */
  _targetList() {
    if (!this.hz) return this.entities;
    const out = this._tl || (this._tl = []);
    out.length = 0;
    for (const e of this.entities) out.push(e);
    for (const d of this.hz.targets) out.push(d);
    return out;
  }

  // ---------------------------------------------------------------- networking
  _bindNet() {
    const H = {
      state: (ev) => {
        const { id, snap } = ev.detail;
        const e = this._ent(id);
        if (!e || e.kind !== 'remote' || !validSnap(snap)) return;
        e.buffer.push({ t: performance.now(), snap });
        if (e.buffer.length > 30) e.buffer.shift();
      },
      finish: (ev) => {
        const { id, time, bestLap } = ev.detail;
        const e = this._ent(id);
        if (!e || e.kind === 'player') return;
        e.finishTime = time; e.bestLap = bestLap; e.sim.finished = true;
        if (this.firstHumanFinish == null) this.firstHumanFinish = this.raceTime;
      },
      results: (ev) => { if (!this.net.isHost) this._showResults(ev.detail.results); },
      'peer-left': (ev) => {
        const e = this._ent(ev.detail.id);
        if (e) { e.connected = false; e.craft.root.visible = false; e.trails.forEach((t) => (t.trail.mesh.visible = false)); this.onEvent({ type: 'toast', text: `${e.name} left the race` }); }
      },
      game: (ev) => this._onGameEvent(ev.detail),
    };
    this._netHandlers = H;
    for (const [k, fn] of Object.entries(H)) this.net.addEventListener(k, fn);
  }

  _send(type, data) { if (this.net) this.net.sendEvent(type, data); }

  _onGameEvent({ type, data }) {
    const arr = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? new THREE.Vector3(a[0], a[1], a[2]) : null;
    switch (type) {
      case 'f': { // remote laser (cosmetic)
        const o = arr(data.o), d = arr(data.d), by = this._ent(data.by);
        if (!o || !d || !by || by.local) return;
        this.weapons.spawnLaser(o, d.normalize(), by.sim.vel, by.id, by.color, false);
        this._shotSound(by);
        return;
      }
      case 'hit': { // damage reported by the shooter
        const t = this._ent(data.t);
        if (!t || !t.local || !Number.isFinite(data.a)) return;
        t.sim.damage(clamp(data.a, 0, 80), data.k === 'missile' ? 'missile' : 'laser', typeof data.by === 'string' ? data.by : null);
        if (data.k === 'missile') t.sim.stun = Math.max(t.sim.stun, 0.8);
        return;
      }
      case 'msl': {
        const o = arr(data.o), v = arr(data.v), by = this._ent(data.by);
        if (!o || !v || !by || by.local || typeof data.m !== 'string') return;
        this.weapons.spawnMissile(data.m, o, v, by.id, typeof data.t === 'string' ? data.t : null, false);
        return;
      }
      case 'mx': this.weapons.detonate(String(data.m), arr(data.p)); return;
      case 'brk': if (Number.isInteger(data.i)) this.world.breakItem(data.i, typeof data.by === 'string' ? data.by : null, true); return;
      case 'pk': if (typeof data.i === 'string') this.world.removePickup(data.i, typeof data.by === 'string' ? data.by : null); return;
      case 'hz': if (this.hz && data && typeof data === 'object') this.hz.applyRemote(data, 0.06); return;
      case 'hzs': if (this.hz && !this.hz.authority && data) this.hz.applySnapshot(data, performance.now()); return;
      case 'hzh': // a client hit a drone: the host applies it
        if (this.hz?.authority && Number.isFinite(data.d) && Number.isFinite(data.a)) this.hz.damageDrone(data.d, clamp(data.a, 0, 200), typeof data.by === 'string' ? data.by : null);
        return;
      case 'die': {
        const v = this._ent(data.id), k = this._ent(data.by);
        if (k && k !== v) k.kills++; // kills are credited from this message for everyone
        if (v) { v.deaths++; this._killFeed(v, k, typeof data.c === 'string' ? data.c : null); }
        return;
      }
      default:
    }
  }

  _netTick(dt) {
    if (!this.net) return;
    if (this.hz?.authority) {
      this.hzSendT += dt;
      if (this.hzSendT >= 0.1) { this.hzSendT = 0; this._send('hzs', this.hz.snapshot()); }
    }
    this.netSendT += dt;
    if (this.netSendT < NET_SEND_INTERVAL) return;
    this.netSendT = 0;
    const list = [];
    for (const e of this.entities) if (e.local && e.connected) list.push({ id: e.id, snap: e.sim.snapshot() });
    this.net.sendStates(list);
  }

  _applyRemote(e) {
    const buf = e.buffer;
    if (!buf.length) return;
    const renderT = performance.now() - INTERP_DELAY;
    let a = null, b = null;
    for (let i = buf.length - 1; i >= 0; i--) if (buf[i].t <= renderT) { a = buf[i]; b = buf[i + 1] || null; break; }
    if (!a) a = buf[0];
    const sim = e.sim, A = a.snap;
    sim.pos.set(A.p[0], A.p[1], A.p[2]);
    sim.quat.set(A.q[0], A.q[1], A.q[2], A.q[3]).normalize();
    sim.vel.set(A.v[0], A.v[1], A.v[2]);
    if (b) {
      const t = clamp((renderT - a.t) / Math.max(1, b.t - a.t), 0, 1);
      sim.pos.lerp(_v.set(b.snap.p[0], b.snap.p[1], b.snap.p[2]), t);
      sim.quat.slerp(_q.set(b.snap.q[0], b.snap.q[1], b.snap.q[2], b.snap.q[3]).normalize(), t);
    } else {
      sim.pos.addScaledVector(sim.vel, Math.min(0.25, (renderT - a.t) / 1000));
    }
    sim.boosting = !!A.b; sim.supersonic = A.b === 2; sim.gateIdx = A.c; sim.lap = A.l;
    if (A.dg && !e._dg) e.dodgeAnim = { t: 0, dir: Math.sign(A.dg) };
    e._dg = A.dg || 0;
    sim.hull = A.h; sim.shield = A.s; sim.ghost = A.g ? 1 : 0;
    sim._remoteProgress = A.pr;
    if (A.f) sim.finished = true;
    const dead = !!A.d;
    if (dead && !e.lastDead) this._explodeShip(e);
    sim.dead = dead;
    e.lastDead = dead;
  }

  _ent(id) { return this.entities.find((x) => x.id === id) || null; }

  // ---------------------------------------------------------------- update
  /** @param {object} input poll() result from Input (null in attract mode) */
  update(dt, input, render = true) {
    if (this.hitStop > 0 && !this.paused) { this.hitStop -= dt; dt *= HIT_STOP_SCALE; }
    this.time += dt;
    if (this.paused && this.mode !== 'multi') { if (render) this._render(dt); return; }

    this.stateTime += dt;
    if (this.o.goAt && (this.state === 'intro' || this.state === 'countdown')) {
      const remaining = (this.o.goAt - performance.now()) / 1000;
      if (remaining <= COUNTDOWN) { if (this.state === 'intro') this.state = 'countdown'; this.stateTime = COUNTDOWN - remaining; }
      else this.stateTime = Math.min(this.stateTime, INTRO * 0.999);
    } else if (this.state === 'intro' && this.stateTime >= INTRO) { this.state = 'countdown'; this.stateTime = 0; }
    if (this.state === 'countdown') {
      const n = Math.ceil(COUNTDOWN - this.stateTime);
      if (n !== this.countdownShown && n > 0) { this.countdownShown = n; this.onEvent({ type: 'countdown', n }); }
      if (this.stateTime >= COUNTDOWN) { this.state = 'racing'; this.stateTime = 0; this.onEvent({ type: 'go' }); }
    }
    const racing = this.state === 'racing' || this.state === 'finished';
    if (racing) this.raceTime += dt;

    // Player controls + aim (once per frame).
    if (this.player) {
      const p = this.player;
      if (p.ai && (this.autopilot || p.sim.finished)) {
        // AI flies it; fire decisions come from the AI inside the fixed step.
      } else if (input) {
        Object.assign(p.input, input);
        this._updateAim(input, dt);
        p.input.aimDir.copy(this.aim.dir);
      }
      if (this.paused) Object.assign(p.input, { throttle: 0, brake: 0, boost: false, fire: false, missile: false, roll: 0, aimX: 0, aimY: 0 });
    }

    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= FIXED_DT) {
      this.acc -= FIXED_DT;
      this._step(FIXED_DT, racing, input);
      this.replays?.step(FIXED_DT, racing);
      if (racing) this.ghostRun?.step(FIXED_DT, this.player);
    }

    for (const e of this.entities) if (e.kind === 'remote') this._applyRemote(e);
    this._processEvents();
    this._rank();
    this._netTick(dt);
    this._checkFinish(dt);
    this.replays?.update(dt);
    this._updateRingStates();
    if (this.hitMarker > 0) this.hitMarker -= dt;
    this.killFeed = this.killFeed.filter((k) => (k.t -= dt) > 0);
    this.incoming = this.player ? this.weapons.incomingFor(this.player.id) : false;
    if (render) this._render(dt);
  }

  _step(dt, racing, input) {
    const ships = this.entities;
    const targets = this._targetList();
    for (const e of ships) {
      if (!e.local) continue;
      const aiFlying = e.ai && (e.kind === 'ai' || this.autopilot || e.sim.finished);
      if (aiFlying) e.input = e.ai.think(dt, this.hz ? targets : ships, this.aiCtx || (this.aiCtx = { weapons: this.weapons, lead: 0 }));
      if (e === this.player && !aiFlying && racing) {
        // Assist nudges a copy of the stick, so the reticle still shows the player's intent.
        const inp = Object.assign(this._assistInp || (this._assistInp = {}), e.input);
        inp.dodge = input?.dodgeEdge || 0;
        if (input) input.dodgeEdge = 0;
        this._assist().nudge(e.sim, inp, this.world, { dt, battle: this.battle, laserSpeed: LASER.speed });
        e.sim.step(dt, inp, { world: this.world, racing, raceTime: this.raceTime });
      } else e.sim.step(dt, e.input, { world: this.world, racing, raceTime: this.raceTime });
      if (!racing || e.sim.dead || e.sim.finished) continue;
      // Lock-on: the player locks along their aim, AI along their nose.
      const aimDir = e === this.player && !aiFlying ? this.aim.dir : _x.set(0, 0, -1).applyQuaternion(e.sim.quat);
      // Auto-lock: with aim assist the player's lock cone widens to cover the soft target.
      const coneScale = e === this.player && !aiFlying ? this._assist().lockCone() : 1;
      const lk = this.weapons.updateLock(e, aimDir, ships, dt, coneScale);
      if (e === this.player) this._lockFeedback(lk);
      if (e.input.fire) {
        const dir = _w.copy(e.input.aimDir || aimDir).normalize();
        const nose = _v.set(0, 0, -1).applyQuaternion(e.sim.quat);
        const human = e === this.player && !aiFlying;
        const assist = human ? this._assist().aim : 0;
        // Gun swivel: wider for the player with aim assist (the cursor leads the nose).
        const arc = human ? this._assist().gunArc() : 0.5;
        // Smart trigger: with a soft target out of the guns' reach, hold fire instead of wasting heat.
        const outOfArc = human && assist > 0 && this.aim.target && dir.angleTo(nose) > arc;
        clampCone(dir, nose, arc);
        const bolt = outOfArc ? null : this.weapons.tryFireLaser(e, dir, e.color, true);
        if (bolt) {
          this._shotSound(e);
          this._send('f', { by: e.id, o: v3(bolt.pos), d: v3(dir) });
        }
      }
      const wantMissile = e === this.player && !aiFlying ? input?.missileEdge : e.input.missile;
      if (wantMissile) {
        const m = this.weapons.tryFireMissile(e, e.sim.lock.t >= 1 ? e.sim.lock.id : null, true);
        if (m) {
          if (e === this.player || this._near(e.sim.pos)) this.onEvent({ type: 'missileLaunch', player: e === this.player });
          this._send('msl', { by: e.id, m: m.id, o: v3(m.pos), v: v3(m.vel), t: m.target });
        } else if (e === this.player && e.sim.missiles <= 0) this.onEvent({ type: 'noMissiles' });
      }
    }
    if (input) input.missileEdge = false;
    if (this.hz) this._hazardHits(dt);
    this._collideShips();
    if (this.pads.pads.length && racing) {
      const local = this._padShips || (this._padShips = []);
      local.length = 0;
      for (const e of ships) if (e.local && e.connected) local.push(e);
      this.pads.update(dt, local);
      for (const ev of this.pads.events) {
        if (ev.shipId === this.player?.id) { this.padFlash = { big: ev.big, t: 0 }; this.onEvent({ type: 'boostPad', big: ev.big }); }
      }
      this.pads.events.length = 0;
    }
    if (this.player && racing && !this.player.sim.dead) this._nearMiss(dt);
    this.weapons.update(dt, ships.filter((s) => s.connected));
    this.world.update(dt, ships.map((s) => ({ id: s.id, pos: s.sim.pos, dead: s.sim.dead || !s.connected, radius: s.sim.p.radius, local: s.local })));
    this._weaponEvents();
    this._worldEvents();
    if (this.hz) {
      const live = this._hzShips || (this._hzShips = []);
      live.length = 0;
      for (const e of ships) if (e.connected) live.push(e);
      this.hz.update(dt, live, this.matchTime());
      this._hazardEvents();
    }
  }

  _updateAim(input, dt) {
    const w = this.viewW || 1, h = this.viewH || 1;
    const R = 0.36 * Math.min(w, h);
    this.aim.x = input.aimX; this.aim.y = input.aimY;
    this.aim.px = w / 2 + input.aimX * R;
    this.aim.py = h / 2 - input.aimY * R;
    _ndc.set((this.aim.px / w) * 2 - 1, -(this.aim.py / h) * 2 + 1);
    _ray.setFromCamera(_ndc, this.camera);
    const p = this.player.sim;
    // Aim assist: a soft target near the reticle; lasers fire at its lead point.
    const pa = this._assist();
    const best = pa.softTarget(_ray.ray.origin, _ray.ray.direction, this.player, this._targetList());
    this.aim.onTarget = best ? best.id : null;
    this.aim.target = best;
    let aimPoint;
    if (best) {
      aimPoint = leadPoint(p.pos, p.vel, best.sim.pos, best.sim.vel, LASER.speed, _v);
    } else {
      const far = _w.copy(_ray.ray.origin).addScaledVector(_ray.ray.direction, 700);
      const hit = this.world.raycast(_ray.ray.origin, far, 0.5);
      aimPoint = hit ? hit.point : far;
    }
    this.aim.dir.copy(aimPoint).sub(p.pos).normalize();
    this.aim.lead = best ? (this.aim.leadPos || (this.aim.leadPos = new THREE.Vector3())).copy(aimPoint) : null;
    this.aim.outOfArc = !!best && this.aim.dir.angleTo(_x.set(0, 0, -1).applyQuaternion(p.quat)) > pa.gunArc();
  }

  /** The player's assist settings, refreshed from Settings. */
  _assist() {
    const pa = this.playerAssist || (this.playerAssist = new PlayerAssist());
    pa.aim = clamp(this.settings.aimAssist ?? 1, 0, 1);
    pa.flight = clamp(this.settings.flightAssist ?? 0.7, 0, 1);
    return pa;
  }

  /** Lasers and missiles against Vesk drones and plasmoids (before the weapons move). */
  _hazardHits(dt) {
    const hz = this.hz;
    for (const b of this.weapons.lasers) {
      if (!b.alive) continue;
      _v.copy(b.pos).addScaledVector(b.vel, dt);
      const h = hz.hitTest(b.pos, _v, 0.3);
      if (!h) continue;
      const w = this.world.raycast(b.pos, _v, 0);
      if (w && w.t < h.t) continue;
      b.alive = false;
      this.sparks.emit(h.point, _w.set(0, 0, 0), 8, b.color, { spread: 30, size: 0.45, life: 0.25 });
      if (!b.local) continue; // remote copies are cosmetic; the shooter's client reports the hit
      if (h.kind === 'drone') hz.damageDrone(h.id, LASER.damage, b.owner);
      else hz.hitPlasmoid(h.id, LASER.damage, b.owner);
      if (b.owner === this.player?.id) { this.hitMarker = Math.max(this.hitMarker, 0.14); this.onEvent({ type: 'hitConfirm' }); }
    }
    for (const m of this.weapons.missiles) {
      if (!m.alive || !m.local) continue;
      _v.copy(m.pos).addScaledVector(m.vel, dt);
      const h = hz.hitTest(m.pos, _v, 2.5);
      if (h) this.weapons.detonate(m.id, h.point);
    }
  }

  _hazardEvents() {
    const hz = this.hz;
    for (const ev of hz.events) {
      this.hzViews?.onEvent(ev);
      if (ev.net && !ev.remote) { const pk = Hazards.packEvent(ev); if (pk) this._send('hz', pk); }
      switch (ev.type) {
        case 'damage': {
          const s = this._ent(ev.shipId);
          if (!s || !s.local || s.sim.dead) break;
          this._damage(s, ev.amount, ev.kind, ev.byId ?? null);
          if (ev.stun) s.sim.stun = Math.max(s.sim.stun, ev.stun);
          if (s === this.player) this.shake = Math.max(this.shake, 0.5); // the ship's own 'damaged' event drives hurt audio/HUD
          break;
        }
        case 'knock': {
          const s = this._ent(ev.shipId);
          if (s && s.local && !s.sim.dead) { s.sim.vel.add(ev.impulse); if (s === this.player) this.shake = Math.max(this.shake, 0.4); }
          break;
        }
        case 'droneFire':
          hz.spawnBolt(ev);
          if (this._near(ev.pos, 350)) this.onEvent({ type: 'alienFire', distance: this._distN(ev.pos) });
          break;
        case 'droneDown':
          spawnHazardDrop(this.world, ev);
          this.shatter.burst({ position: ev.pos, radius: ev.droneType === 'warden' ? 7 : 3, kind: 'crystal', velocity: ev.vel || new THREE.Vector3(), color: new THREE.Color('#8cff2e') });
          this.onEvent({ type: 'explosion', size: ev.droneType === 'warden' ? 0.8 : 0.4, distance: this._distN(ev.pos) });
          if (ev.byId) {
            const k = this._ent(ev.byId);
            if (k) {
              k.drones = (k.drones || 0) + 1;
              if (k === this.player) this.onEvent({ type: 'droneKill', warden: ev.droneType === 'warden' });
            }
          }
          break;
        case 'forwardHit':
          if (!hz.authority) this._send('hzh', { d: ev.droneId, a: Math.round(ev.amount), by: ev.byId ?? null });
          break;
        case 'plasmoidPop':
          this.onEvent({ type: 'explosion', size: 0.6, distance: this._distN(ev.pos || this.focus.sim.pos) });
          break;
        case 'wave': this.onEvent({ type: 'vesk', what: 'wave', count: ev.count }); break;
        case 'ambush': if (this.player && ev.pos && this.player.sim.pos.distanceTo(ev.pos) < 700) this.onEvent({ type: 'vesk', what: 'ambush' }); break;
        default:
      }
    }
    hz.events.length = 0;
  }

  _lockFeedback(lk) {
    const prev = this.lock;
    if (prev.id !== lk.id) {
      // Light up whoever we're locking onto (rim + beacon) so the target pops out of the scene.
      this._ent(prev.id)?.craft.setHighlight?.(0);
      this._ent(lk.id)?.craft.setHighlight?.(1);
    }
    this.lock = { id: lk.id, t: lk.t, locked: lk.locked };
    if (lk.locked && !prev.locked) this.onEvent({ type: 'locked' });
    else if (lk.id && !lk.locked) {
      this._lockBeepT = (this._lockBeepT || 0) - FIXED_DT;
      if (this._lockBeepT <= 0) { this._lockBeepT = 0.16; this.onEvent({ type: 'locking' }); }
    }
  }

  _collideShips() {
    const E = this.entities;
    for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
      const a = E[i], b = E[j];
      if (!a.connected || !b.connected || a.sim.dead || b.sim.dead || a.sim.ghost > 0 || b.sim.ghost > 0) continue;
      _v.subVectors(b.sim.pos, a.sim.pos);
      const d = _v.length(), min = (a.sim.p.radius + b.sim.p.radius) * 0.9;
      if (d >= min || d < 1e-4) continue;
      _v.divideScalar(d);
      const pen = min - d;
      const ma = 0.6 + a.sim.p.armor, mb = 0.6 + b.sim.p.armor;
      const sa = mb / (ma + mb), sb = ma / (ma + mb);
      const rel = _w.subVectors(b.sim.vel, a.sim.vel).dot(_v);
      const closing = Math.max(0, -rel);
      // Demolition (Rocket League): a supersonic ship driving INTO a rival wrecks it.
      // The victim's own client decides, so each demo is applied exactly once.
      if (this._tryDemo(a, b, _v, closing) || this._tryDemo(b, a, _x.copy(_v).negate(), closing)) continue;
      if (a.local) { a.sim.pos.addScaledVector(_v, -pen * sa); if (rel < 0) a.sim.vel.addScaledVector(_v, rel * sa * 1.6); }
      if (b.local) { b.sim.pos.addScaledVector(_v, pen * sb); if (rel < 0) b.sim.vel.addScaledVector(_v, -rel * sb * 1.6); }
      // A meaty bump: the harder hit you take, the further you're shoved off your line.
      if (closing > 10 && !this._bumpCd) {
        this._bumpCd = 0.25;
        const mine = a === this.player || b === this.player;
        if (mine || this._near(a.sim.pos, 250)) this.onEvent({ type: 'bump', intensity: clamp(closing / 90, 0.15, 1), mine, distance: this._distN(a.sim.pos) });
        if (mine) this.shake = Math.max(this.shake, clamp(closing / 120, 0.2, 0.8));
        this.sparks.emit(_w.copy(a.sim.pos).addScaledVector(_v, a.sim.p.radius), _x.set(0, 0, 0), 14, a.color, { spread: 45, size: 0.6, life: 0.35 });
      }
    }
    if (this._bumpCd) this._bumpCd = Math.max(0, this._bumpCd - FIXED_DT);
  }

  /** att rams vic: a demolition if att is supersonic and driving into vic. dir = att -> vic. */
  _tryDemo(att, vic, dir, closing) {
    if (!att.sim.supersonic || !vic.local || closing < 20) return false;
    if (att.team != null && att.team === vic.team) return false;
    const sp = att.sim.vel.length();
    if (sp < 1 || att.sim.vel.dot(dir) < sp * 0.55) return false; // must be heading into them
    vic.sim.vel.addScaledVector(dir, 60);
    vic.sim.lastKind = 'demo';
    vic.sim.destroy(att.id);
    if (att === this.player) this.demos++;
    return true;
  }

  /** Near misses (pod-racer thrill): skim an obstacle or a rival at speed for a sip of boost. */
  _nearMiss(dt) {
    const sim = this.player.sim;
    this.nearMissT += dt;
    if (this._nmCd > 0) { this._nmCd -= dt; return; }
    if (sim.speed < sim.p.topSpeed * 0.7) return;
    const R = sim.p.radius;
    let hit = null;
    this.world.forEachNear(sim.pos, R + 14, (c) => {
      if (hit || c.dead || c === this._nmLast) return;
      const gap = Math.hypot(sim.pos.x - c.x, sim.pos.y - c.y, sim.pos.z - c.z) - c.r - R;
      if (gap > 0.3 && gap < 4.5) hit = c;
    });
    if (!hit) for (const e of this.entities) {
      if (e === this.player || e.sim.dead || !e.connected || e === this._nmLast) continue;
      const gap = e.sim.pos.distanceTo(sim.pos) - e.sim.p.radius - R;
      if (gap > 0.3 && gap < 3.5 && Math.abs(_w.subVectors(e.sim.vel, sim.vel).length()) > 25) { hit = e; break; }
    }
    if (!hit) return;
    this._nmLast = hit; this._nmCd = 0.9; this.nearMissT = 0;
    if (sim.supersonic) this.replays?.mark('nearMiss');
    sim.boost = Math.min(1, sim.boost + 0.06);
    this.onEvent({ type: 'nearMiss' });
  }

  /** Doppler whooshes for rivals that whip past the camera. */
  _passBys(dt) {
    const cam = this.camera.position;
    for (const e of this.entities) {
      if (e === this.focus || e.sim.dead || !e.connected) { e._pb = 0; continue; }
      const d = e.sim.pos.distanceTo(cam);
      const was = e._pd ?? d;
      e._pd = d;
      if (e._pb > 0) { e._pb -= dt; continue; }
      if (d < 26 && was >= 26) {
        const rel = _w.subVectors(e.sim.vel, this.focus.sim.vel).length();
        if (rel < 35) continue;
        e._pb = 1.2;
        _x.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
        this.onEvent({ type: 'passBy', pan: clamp(_w.subVectors(e.sim.pos, cam).normalize().dot(_x), -1, 1), speed: clamp(rel / 150, 0, 1), distance: clamp(d / 26, 0, 1) });
      }
    }
  }


  _weaponEvents() {
    for (const ev of this.weapons.events) {
      if (ev.type === 'laserHit') {
        const tgt = this._ent(ev.target);
        this.sparks.emit(ev.point, _v.set(0, 0, 0), 10, ev.color, { spread: 40, size: 0.5, life: 0.3 });
        if (!tgt) continue;
        if (ev.local) {
          if (tgt.local) this._damage(tgt, LASER_DAMAGE, 'laser', ev.owner);
          else this._send('hit', { t: tgt.id, a: LASER_DAMAGE, k: 'laser', by: ev.owner });
          if (ev.owner === this.player?.id) { this.hitMarker = 0.18; this.onEvent({ type: 'hitConfirm' }); }
        }
      } else if (ev.type === 'laserWorld') {
        this.sparks.emit(ev.point, _v.set(0, 0, 0), 6, ev.color, { spread: 30, size: 0.45, life: 0.25 });
        if (ev.local && ev.item && ev.item.maxHp != null) {
          this.world.hitBreakable(ev.item.id, LASER_DAMAGE, ev.owner);
          if (ev.owner === this.player?.id) this.hitMarker = Math.max(this.hitMarker, 0.1);
        }
      } else if (ev.type === 'missileBoom') {
        this.explosions.spawn({ position: ev.pos, size: 0.7, color: new THREE.Color('#ffb36b') });
        this.onEvent({ type: 'explosion', size: 0.5, distance: this._distN(ev.pos) });
        if (!ev.local) continue;
        this._send('mx', { m: ev.missile?.id, p: v3(ev.pos) });
        for (const s of this.entities) {
          if (s.id === ev.owner || s.sim.dead || !s.connected || this.weapons.sameTeam(ev.owner, s)) continue;
          const d = s.sim.pos.distanceTo(ev.pos);
          if (d > MISSILE.splash) continue;
          const dmg = MISSILE.damage * (s.id === ev.direct ? 1 : 1 - (d / MISSILE.splash) * 0.6);
          if (s.local) { this._damage(s, dmg, 'missile', ev.owner); s.sim.stun = Math.max(s.sim.stun, 0.8); }
          else this._send('hit', { t: s.id, a: Math.round(dmg), k: 'missile', by: ev.owner });
          if (ev.owner === this.player?.id) { this.hitMarker = 0.3; this.onEvent({ type: 'hitConfirm' }); }
        }
        this.world.forEachNear(ev.pos, MISSILE.splash, (c) => { if (c.ref && !c.dead) this.world.hitBreakable(c.ref.id, 70, ev.owner); });
        if (this.hz) this.hz.splash(ev.pos, MISSILE.splash, MISSILE.damage, ev.owner);
      }
    }
    this.weapons.events.length = 0;
  }

  _damage(e, amount, kind, by) {
    e.sim.damage(amount, kind, by);
  }

  _worldEvents() {
    for (const ev of this.world.events) {
      if (ev.type === 'broken') {
        const it = ev.item, v = this.itemViews.get(it.id);
        if (v) v.obj.visible = false;
        if (it.type !== 'mine') {
          this.debris.rockBreak(it.pos, it.radius, { kind: it.kind, color: v?.tint || null, velocity: _v.set(0, 0, 0) });
          this.onEvent({ type: 'shatter', size: clamp(it.radius / 12, 0.2, 1), kind: it.kind, distance: this._distN(it.pos) });
        }
        const byLocal = ev.by && this._ent(ev.by)?.local;
        if (!ev.remote && byLocal) this._send('brk', { i: it.id, by: ev.by });
      } else if (ev.type === 'blast') {
        this.explosions.spawn({ position: ev.pos, size: 1.1, color: new THREE.Color('#ff7a4a') });
        this.onEvent({ type: 'explosion', size: 0.8, distance: this._distN(ev.pos) });
        for (const s of this.entities) {
          if (!s.local || s.sim.dead) continue;
          const d = s.sim.pos.distanceTo(ev.pos);
          if (d < ev.radius) { this._damage(s, ev.damage * (1 - (d / ev.radius) * 0.5), 'blast', ev.by); s.sim.stun = Math.max(s.sim.stun, 0.6); }
        }
      } else if (ev.type === 'damaged') {
        const v = this.itemViews.get(ev.item.id);
        if (v) v.flash = 1;
      } else if (ev.type === 'respawned') {
        const v = this.itemViews.get(ev.item.id);
        if (v) { v.obj.visible = true; v.grow = 0; }
      } else if (ev.type === 'pickupSpawn') {
        this.pickupViews.set(ev.pickup.id, pickupMesh(this.scene, ev.pickup.kind));
      } else if (ev.type === 'pickupTaken') {
        const pv = this.pickupViews.get(ev.pickup.id);
        if (pv) { this.scene.remove(pv.group); pv.dispose(); this.pickupViews.delete(ev.pickup.id); }
        const e = this._ent(ev.by);
        if (e && e.local) {
          applyPickup(e.sim, ev.pickup.kind);
          this._send('pk', { i: ev.pickup.id, by: e.id });
          if (e === this.player) this.onEvent({ type: 'pickup', kind: ev.pickup.kind });
        }
      }
    }
    this.world.events.length = 0;
  }

  _processEvents() {
    for (const e of this.entities) {
      const sim = e.sim;
      if (!sim.events.length) continue;
      const isPlayer = e === this.player;
      for (const ev of sim.events) {
        if (ev.type === 'destroyed') {
          this._explodeShip(e);
          e.deaths++;
          const killer = this._ent(ev.by);
          if (killer && killer !== e) killer.kills++;
          this._killFeed(e, killer, ev.cause);
          this._send('die', { id: e.id, by: ev.by || null, c: ev.cause || null });
        }
        if (ev.type === 'scrape' && this.tunnel && this._near(ev.point, 600)) this.tunnel.scrape(ev.point, ev.intensity);
        if (ev.type === 'dodge') { e.dodgeAnim = { t: 0, dir: ev.dir }; if (isPlayer) this.onEvent({ type: 'dodge', dir: ev.dir }); }
        if (ev.type === 'supersonic' && (isPlayer || this._near(e.sim.pos, 300))) this.onEvent({ type: 'supersonic', player: isPlayer, distance: this._distN(e.sim.pos) });
        if (ev.type === 'deflect') {
          this.sparks.emit(e.sim.pos, _x.set(0, 0, 0), 10, new THREE.Color('#bfe8ff'), { spread: 50, size: 0.5, life: 0.25 });
          if (isPlayer) this.onEvent({ type: 'deflect' });
        }
        if (ev.type === 'ring' && this.ringViews[ev.index]) this.ringViews[ev.index].flash = 1;
        if (ev.type === 'lap' && !this.battle) {
          if (e.bestLap == null || ev.time < e.bestLap) e.bestLap = ev.time;
          if (sim.lap >= this.laps && !sim.finished) {
            sim.finished = true;
            e.finishTime = this.raceTime;
            if (!e.ai) e.ai = new FlightAI(e, this.world, { skill: 'easy', seed: 5 });
            if (e.local && this.net) this.net.sendFinish({ id: e.id, time: e.finishTime, bestLap: e.bestLap });
            if (e.kind === 'player' && this.firstHumanFinish == null) this.firstHumanFinish = this.raceTime;
            if (isPlayer) this.onEvent({ type: 'finish', rank: e.rank, time: e.finishTime });
            continue;
          }
        }
        if (isPlayer) {
          if (ev.type === 'start') {}
          else if (ev.type === 'lap') this.onEvent({ type: 'lap', lap: sim.lap, time: ev.time, final: sim.lap === this.laps - 1, best: e.bestLap === ev.time });
          else if (ev.type === 'damaged') this.onEvent({ type: 'hurt', amount: ev.amount, shieldOnly: ev.shieldOnly, kind: ev.kind });
          else this.onEvent({ ...ev, player: true });
          if (ev.type === 'bump' || ev.type === 'destroyed') this.shake = Math.max(this.shake, ev.type === 'destroyed' ? 1.4 : ev.intensity);
          if (ev.type === 'damaged' && !ev.shieldOnly) this.shake = Math.max(this.shake, 0.5);
        }
      }
      sim.events.length = 0;
    }
  }

  _explodeShip(e) {
    this.explosions.spawn({ position: e.sim.pos, size: 1.3, color: e.color.clone().lerp(new THREE.Color('#ffb36b'), 0.6), velocity: e.sim.vel.clone().multiplyScalar(0.3) });
    const demo = e.sim.lastKind === 'demo';
    this.debris.shipBreak(e.craft, { velocity: e.sim.vel, intensity: demo ? 1.6 : 1 });
    this.onEvent({ type: 'explosion', size: 1, ship: true, distance: this._distN(e.sim.pos) });
    if (e === this.focus) this.shake = Math.max(this.shake, 0.9);
    e.trails.forEach((t) => t.trail.reset());
    this.replays?.explosion(e);
  }

  _killFeed(victim, killer, cause = null) {
    const text = killer && killer !== victim && cause === 'demo' ? `${killer.name} demolished ${victim.name}`
      : killer && killer !== victim ? `${killer.name} destroyed ${victim.name}`
      : cause === 'alien' ? `${victim.name} was swarmed by the Vesk`
        : cause === 'plasmoid' ? `${victim.name} was fried by a plasmoid`
          : cause === 'boundary' ? `${victim.name} strayed too far`
            : `${victim.name} crashed`;
    this.killFeed.unshift({ text, t: 4, mine: killer === this.player, me: victim === this.player });
    this.killFeed = this.killFeed.slice(0, 4);
    if (killer === this.player && victim !== this.player) this.onEvent({ type: 'kill', name: victim.name, demo: cause === 'demo' });
    if (cause === 'demo' && (killer === this.player || victim === this.player || this._near(victim.sim.pos, 300))) this.onEvent({ type: 'demolition', distance: this._distN(victim.sim.pos) });
    if (cause === 'demo') {
      this.replays?.demolition(killer, victim);
      if (killer === this.player && victim !== this.player && this.mode === 'solo' && !this.settings.reduceMotion) this.hitStop = HIT_STOP;
    }
  }

  _shotSound(e) {
    if (e === this.player) this.onEvent({ type: 'laser', volume: 0.55 });
    else if (this._near(e.sim.pos, 260)) this.onEvent({ type: 'laser', volume: 0.25 * (1 - this._distN(e.sim.pos)) });
  }

  _near(p, d = 300) { return this.camera.position.distanceTo(p) < d; }
  _distN(p) { return clamp(this.camera.position.distanceTo(p) / 900, 0, 1); }

  _leaderProgress() {
    let m = -Infinity;
    for (const e of this.entities) m = Math.max(m, this._progress(e));
    return m;
  }

  _progress(e) { return e.kind === 'remote' && e.sim._remoteProgress != null ? e.sim._remoteProgress : e.sim.progress(); }

  _rank() {
    const sorted = [...this.entities].sort(this.battle ? battleOrder : (a, b) => {
      const fa = a.finishTime != null, fb = b.finishTime != null;
      if (fa && fb) return a.finishTime - b.finishTime;
      if (fa) return -1;
      if (fb) return 1;
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return this._progress(b) - this._progress(a);
    });
    sorted.forEach((e, i) => (e.rank = i + 1));
    this.standings = sorted;
  }

  _checkFinish(dt) {
    if (this.mode === 'attract' || this.results) return;
    if (this.battle) { this._checkBattle(dt); return; }
    const p = this.player;
    if (!p || !p.sim.finished) return;
    if (this.state !== 'finished') { this.state = 'finished'; this.stateTime = 0; }
    this.finishWait += dt;
    if (this.mode === 'solo') { if (this.finishWait > 3.2) this._finalize(); return; }
    if (this.net?.isHost) {
      const humans = this.entities.filter((e) => !e.isAI && e.connected);
      const allDone = humans.every((e) => e.finishTime != null);
      const timeout = this.firstHumanFinish != null && this.raceTime - this.firstHumanFinish > 45;
      if ((allDone && this.finishWait > 3) || timeout) this._finalize();
    }
  }

  /** Kills per team [blue, red]. */
  teamScores() {
    const sc = [0, 0];
    for (const e of this.entities) if (e.team != null) sc[e.team] += e.kills;
    return sc;
  }

  /** Seconds since GO. Online, from the shared start moment, so every client's clock agrees. */
  matchTime() {
    if (this.mode === 'multi' && this.o.goAt && this.state !== 'intro' && this.state !== 'countdown') return Math.max(0, (performance.now() - this.o.goAt) / 1000);
    return this.raceTime;
  }

  /** Battle ends at the kill target or when time runs out. The host decides online. */
  _checkBattle(dt) {
    if (this.state === 'racing') {
      const top = this.teams ? Math.max(...this.teamScores()) : Math.max(0, ...this.entities.map((e) => e.kills));
      const t = this.matchTime();
      const over = top >= this.target || t >= this.timeLimit;
      const decide = this.mode === 'solo' || this.net?.isHost || t >= this.timeLimit + 6;
      if (over && decide) {
        this.state = 'finished'; this.stateTime = 0; this.finishWait = 0; this.endAt = t;
        for (const e of this.entities) { e.sim.finished = true; e.sim.boosting = false; }
        this._rank();
        const winner = this.standings[0];
        if (this.teams) {
          const [b, r] = this.teamScores();
          const wt = b === r ? null : b > r ? 0 : 1;
          this.onEvent({ type: 'battleOver', winner: wt == null ? 'Draw' : TEAMS[wt].name, you: wt != null && wt === this.player?.team, rank: this.player?.rank, reason: top >= this.target ? 'target' : 'time', team: true });
        } else this.onEvent({ type: 'battleOver', winner: winner?.name, you: winner === this.player, rank: this.player?.rank, reason: top >= this.target ? 'target' : 'time' });
      }
      return;
    }
    if (this.state !== 'finished') return;
    this.finishWait += dt;
    if (this.matchTime() - this.endAt > 3.4) this._finalize();
  }

  /** Fly unfinished AI home quickly (no weapons) so the standings are real. */
  _finalize() {
    if (this.battle) {
      this._rank();
      const results = this.standings.map((e) => ({
        id: e.id, name: e.name, design: e.design, kind: e.isAI ? 'ai' : 'human', kills: e.kills, deaths: e.deaths,
        time: null, bestLap: null, dnf: !e.connected, team: e.team,
      }));
      if (this.net?.isHost) this.net.sendResults(results);
      this._showResults(results);
      return;
    }
    let t = this.raceTime, guard = 0;
    const ships = this.entities;
    while (guard++ < 120 * 180) {
      const pending = ships.filter((e) => e.kind === 'ai' && e.finishTime == null);
      if (!pending.length) break;
      for (const e of pending) {
        const inp = e.ai.think(FIXED_DT, ships, this.aiCtx || { weapons: this.weapons });
        inp.fire = false; inp.missile = false;
        e.sim.step(FIXED_DT, inp, { world: this.world, racing: true, raceTime: t });
        for (const ev of e.sim.events) {
          if (ev.type === 'lap') {
            if (e.bestLap == null || ev.time < e.bestLap) e.bestLap = ev.time;
            if (e.sim.lap >= this.laps) { e.sim.finished = true; e.finishTime = t; }
          }
        }
        e.sim.events.length = 0;
      }
      t += FIXED_DT;
    }
    this.world.events.length = 0;
    this._rank();
    const results = this.standings.map((e) => ({
      id: e.id, name: e.name, design: e.design, kind: e.isAI ? 'ai' : 'human', kills: e.kills,
      time: e.finishTime, bestLap: e.bestLap, dnf: e.finishTime == null || !e.connected,
    }));
    if (this.net?.isHost) this.net.sendResults(results);
    this._showResults(results);
  }

  _showResults(results) {
    if (this.results) return;
    this.results = results;
    const ev = { type: 'results', results, playerId: this.player?.id, game: this.game, teams: this.teams ? this.teamScores() : null };
    // A finish replay still playing holds the results screen back until it ends (or is skipped).
    if (this.replays) this.replays.afterPlay(() => this.onEvent(ev)); else this.onEvent(ev);
  }

  // ---------------------------------------------------------------- rendering
  _placeMesh(e, dt) {
    const sim = e.sim, root = e.craft.root;
    // Visual bank into yaw turns.
    const leanT = clamp(-sim.angVel.y * 0.32, -0.6, 0.6);
    e.lean = dt > 0 ? damp(e.lean, leanT, 6, dt) : leanT;
    root.position.copy(sim.pos);
    let roll = e.lean;
    if (e.dodgeAnim) {
      // Barrel roll for the dodge: one full turn, eased.
      e.dodgeAnim.t += dt;
      const k = clamp(e.dodgeAnim.t / 0.45, 0, 1);
      roll -= e.dodgeAnim.dir * Math.PI * 2 * (1 - Math.pow(1 - k, 3));
      if (k >= 1) e.dodgeAnim = null;
    }
    root.quaternion.copy(sim.quat).multiply(_q.setFromAxisAngle(_v.set(0, 0, 1), roll));
    e.visRoll = roll; // the replay buffer records it
    root.visible = e.connected && !sim.dead && !(e === this.player && this.cameraMode === 'hood' && this.state !== 'intro' && !this._cinematicNow());
    if (sim.ghost > 0 && Math.floor(this.time * 12) % 2 === 0) root.visible = false;
  }

  _render(dt) {
    for (const e of this.entities) {
      this._placeMesh(e, dt);
      if (this.replays?.place(e)) { for (const t of e.trails) t.trail.mesh.visible = false; continue; }
      const sim = e.sim;
      const speedN = clamp(Math.abs(sim.forwardSpeed) / sim.p.topSpeed, 0, 1.5);
      const thrust = this.state === 'intro' || this.state === 'countdown' ? 0.3 + (e.input.throttle || 0) * 0.4 : Math.max(e.input.throttle || 0, speedN * 0.7);
      // Your own exhaust sits right in front of the chase camera: keep it from blooming over the ship.
      const own = e === this.focus && !this._cinematicNow();
      e.craft.setThrust(thrust, sim.boosting ? 1 : 0, this.time, own ? 0.45 : 1);
      e.craft.root.updateMatrixWorld();
      const showTrail = e.craft.root.visible && (this.state === 'racing' || this.state === 'finished');
      _x.set(1, 0, 0).applyQuaternion(e.craft.root.quaternion);
      for (const t of e.trails) {
        t.trail.mesh.visible = showTrail;
        if (!showTrail) continue;
        _w.copy(t.nozzle.pos).applyMatrix4(e.craft.root.matrixWorld);
        t.trail.mat.uniforms.uIntensity.value = (0.25 + speedN * 0.3 + (sim.boosting ? 0.4 : 0)) * (own ? 0.5 : 1);
        t.trail.mat.uniforms.uNear.value = own ? 14 : 6;
        t.trail.push(_w, _x, 0.3 + speedN * 0.3 + (sim.boosting ? 0.4 : 0));
      }
    }
    this.ghostRun?.render(dt, this.time, this.camera.position, !!this.replays?.playing);
    // Items: damage flash and respawn grow-in.
    for (const [id, v] of this.itemViews) {
      if (v.grow < 1) { v.grow = Math.min(1, v.grow + dt * 1.5); const it = this.world.byId.get(id); v.obj.scale.setScalar(it.scale * (0.2 + 0.8 * v.grow)); }
      if (v.flash > 0) { v.flash = Math.max(0, v.flash - dt * 6); const it = this.world.byId.get(id); v.obj.scale.setScalar(it.scale * (1 + v.flash * 0.05)); }
    }
    for (const [id, pv] of this.pickupViews) {
      const pk = this.world.pickups.get(id);
      if (pk) pv.update(dt, pk.pos, this.time);
    }
    // Gates: gentle pulse on the next one, a flash when someone takes one.
    for (const v of this.ringViews) {
      if (v.isNext) { const k = 1 + Math.sin(this.time * 5) * 0.03; v.halo.scale.setScalar(k); }
      if (v.flash > 0) { v.flash = Math.max(0, v.flash - dt * 2.5); v.g.scale.setScalar(1 + (1 - v.flash) * 0.25 * v.flash * 4); v.haloMat.opacity = Math.max(v.isNext ? 0.22 : 0, v.flash * 0.5); }
    }
    updateProps(dt);
    for (const b of this.belts) b.update(dt);
    this.weaponView.update(dt);
    this.sparks.update(dt);
    this.shatter.update(dt);
    this._updateCamera(dt);
    if (this.padViews) this.padViews.update(dt, this.time, this.focus?.id);
    if (this.padFlash) { this.padFlash.t += dt; if (this.padFlash.t > 0.8) this.padFlash = null; }
    if (this.state === 'racing') this._passBys(dt);
    this.debris.update(dt, this.camera, { bounds: this._debrisBounds });
    if (this.speedFx && this.focus) {
      const fs = this.focus.sim, racingNow = this.state === 'racing';
      let wallPoint = null, wallNormal = null;
      if (!this.battle && fs.wall > 0.75 && !fs.dead) {
        // Nearest wall point: from the line's centre out through the ship.
        const loc = this.course.locate(fs.pos, fs.trackI, this._wl || (this._wl = { i: 0, u: 0, c: new THREE.Vector3(), t: new THREE.Vector3() }));
        wallNormal = (this._wn || (this._wn = new THREE.Vector3())).subVectors(fs.pos, loc.c);
        wallNormal.addScaledVector(loc.t, -wallNormal.dot(loc.t)).normalize();
        wallPoint = (this._wp || (this._wp = new THREE.Vector3())).copy(loc.c).addScaledVector(wallNormal, this.course.tunnelRadiusAt(loc.u));
        wallNormal.negate();
      }
      this.speedFx.update(dt, {
        speedN: racingNow && !fs.dead ? clamp(Math.max(0, fs.forwardSpeed) / fs.p.topSpeed, 0, 1.6) : 0,
        boost: fs.boosting && racingNow, supersonic: fs.supersonic && racingNow, wall: this.battle ? 0 : fs.wall,
        wallPoint, wallNormal, nearMiss: this.nearMissT === 0 ? 1 : 0, velocity: fs.vel,
        shipPos: this.focus.craft.root.position, shipQuat: this.focus.craft.root.quaternion, craft: this.focus.craft,
      });
      this.shake = Math.max(this.shake, this.speedFx.shake);
    }
    if (this.tunnel) this.tunnel.update(dt, this.camera, { shipPos: this.replays?.focusPos() || this.focus?.sim.pos || null, speed: Math.max(0, this.focus?.sim.forwardSpeed || 0) });
    this.explosions.update(dt, this.camera);
    this.hzViews?.update(dt, this.camera);
    if (this.dust) this.dust.update(dt, this.camera.position, this.focus?.sim.vel || _v.set(0, 0, 0));
    this.sky.update(this.camera, dt);
  }

  _snapCamera() { this._updateCamera(0, true); }

  _cinematicNow() { return this.mode === 'attract' || this.state === 'intro' || (this.state === 'finished' && this.finishWait > 1); }

  _updateCamera(dt, snap = false) {
    const cam = this.camera, c = this.cam;
    const reduce = this.settings.reduceMotion;
    const baseFov = this.settings.fov || 70;
    if (this.replays?.playing) { this.replays.camera(cam); return; }
    if (this._cinematicNow()) { this._cinematic(dt, snap); return; }
    const e = this.focus, sim = e.sim;
    const speedN = clamp(Math.max(0, sim.forwardSpeed) / sim.p.topSpeed, 0, 1.6);
    const boost = sim.boosting ? 1 : 0;
    // Camera orientation trails the ship's, nudged toward where the player aims.
    const look = _q.copy(sim.quat);
    if (e === this.player && !this.autopilot) {
      const ax = this.aim.x * (reduce ? 0.04 : 0.09), ay = this.aim.y * (reduce ? 0.03 : 0.07);
      look.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(ay, -ax, 0, 'YXZ')));
    }
    if (snap || dt === 0) c.quat.copy(look);
    else c.quat.slerp(look, 1 - Math.exp(-(this.cameraMode === 'hood' ? 20 : 4.6) * dt)); // a lazy follow: the ship swings through the frame
    if (this.cameraMode === 'hood') {
      cam.position.copy(sim.pos).add(_v.set(0, 0.9, -0.5).applyQuaternion(sim.quat));
    } else {
      // Low and close, pulled back as speed builds: the pod-racer view.
      const ss = sim.supersonic ? 1 : 0;
      const back = 11.5 + speedN * 3 + boost * 2 + ss * 1.5, up = 2.9 + speedN * 0.35;
      cam.position.copy(sim.pos).add(_v.set(0, up, back).applyQuaternion(c.quat));
      if (!reduce && dt > 0 && speedN > 0.6) {
        // Engine rumble: a fine, fast shake that grows with speed (never touches the aim).
        const r = (speedN - 0.6) * 0.06 + ss * 0.05 + (sim.scraping ? 0.08 : 0);
        cam.position.x += Math.sin(this.time * 61) * r; cam.position.y += Math.sin(this.time * 47 + 1) * r;
      }
    }
    cam.quaternion.copy(c.quat).multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), this.cameraMode === 'hood' ? 0 : -0.07));
    if (this.shake > 0 && dt > 0) {
      const amp = (reduce ? 0.1 : 0.5) * this.shake;
      cam.position.x += (Math.random() - 0.5) * amp; cam.position.y += (Math.random() - 0.5) * amp; cam.position.z += (Math.random() - 0.5) * amp;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    const targetFov = baseFov + (reduce ? 4 : 8) * Math.min(speedN, 1.3) + (reduce ? 2 : 6) * boost + (this.speedFx && e === this.focus ? this.speedFx.fovKick : 0);
    c.fov = snap ? targetFov : damp(c.fov, targetFov, 2.5, dt);
    cam.fov = c.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  _cinematic(dt, snap) {
    const cam = this.camera, c = this.cam;
    if (this.state === 'intro' && this.player) {
      const sim = this.player.sim;
      const t = clamp(this.stateTime / INTRO, 0, 1);
      const s = t * t * (3 - 2 * t);
      const a = (1 - s) * Math.PI * 0.85;
      const dist = 12.5 + (1 - s) * 10;
      _v.set(Math.sin(a) * dist, 3.4 + (1 - s) * 5, Math.cos(a) * dist).applyQuaternion(sim.quat);
      cam.position.copy(sim.pos).add(_v);
      cam.up.set(0, 1, 0).applyQuaternion(sim.quat);
      cam.lookAt(_w.copy(sim.pos).add(_x.set(0, 1.2, -14 * s).applyQuaternion(sim.quat)));
      c.quat.copy(sim.quat);
      cam.fov = this.settings.fov || 70;
      cam.updateProjectionMatrix();
      return;
    }
    c.shotT -= dt;
    if (c.shotT <= 0 || !c.target || snap || !c.target.connected || c.target.sim.dead) {
      c.shot = (c.shot + 1) % 3;
      c.shotT = 4 + Math.random() * 2.5;
      const pool = (this.standings || this.entities).filter((x) => x.connected && !x.sim.dead);
      c.target = this.state === 'finished' && this.player ? this.player : pool[Math.floor(Math.random() * Math.min(3, pool.length))] || this.entities[0];
      if (c.shot === 1) {
        const sim = c.target.sim;
        c.fixed.copy(sim.pos).addScaledVector(sim.vel, 1.6).add(_v.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).normalize().multiplyScalar(70));
      }
    }
    const sim = c.target.sim;
    _w.set(0, 1, 0).applyQuaternion(sim.quat);
    if (c.shot === 0) {
      cam.position.copy(sim.pos).add(_v.set(15, 4.5, 14).applyQuaternion(sim.quat));
      cam.up.copy(_w);
      cam.lookAt(_x.copy(sim.pos).add(_v.set(0, 0, -10).applyQuaternion(sim.quat)));
    } else if (c.shot === 1) {
      cam.position.copy(c.fixed);
      cam.up.copy(_w);
      cam.lookAt(sim.pos);
      if (cam.position.distanceTo(sim.pos) > 320) c.shotT = 0;
    } else {
      cam.position.copy(sim.pos).add(_v.set(0, 5, 22).applyQuaternion(sim.quat));
      cam.up.copy(_w);
      cam.lookAt(_x.copy(sim.pos).add(_v.set(0, 0, -30).applyQuaternion(sim.quat)));
    }
    cam.fov = 58;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- queries for HUD / audio / app
  hud() {
    const p = this.player;
    if (!p) return null;
    const sim = p.sim;
    const base = {
      game: this.game, state: this.state,
      rank: p.rank, total: this.entities.filter((e) => e.connected).length,
      raceTime: this.raceTime,
      speed: Math.max(0, sim.forwardSpeed), topSpeed: sim.p.topSpeed,
      boost: sim.boost, boosting: sim.boosting,
      hull: sim.hull / sim.p.hull, shield: sim.shield / sim.p.shield,
      heat: sim.heat, overheated: sim.overheated, missiles: sim.missiles,
      dead: sim.dead, respawnIn: sim.dead ? sim.respawnT : 0,
      finished: sim.finished, kills: p.kills, deaths: p.deaths, incoming: this.incoming,
      supersonic: sim.supersonic, boostPad: this.padFlash, demos: this.demos, dodgeReady: sim.dodgeCd <= 0,
      nearMiss: this.nearMissT < 1.2 ? this.nearMissT : null,
      lock: this.lock, hitMarker: this.hitMarker > 0, killFeed: this.killFeed,
      replay: this.replays?.hudState() ?? null,
      standings: this.standings.map((e) => ({ id: e.id, name: e.name, color: e.team != null ? TEAMS[e.team].color : e.design.colors.glow, team: e.team, isPlayer: e === p, finished: e.finishTime != null, connected: e.connected, dead: e.sim.dead, kills: e.kills, deaths: e.deaths })),
    };
    if (this.battle) {
      return Object.assign(base, {
        target: this.target, timeLeft: Math.max(0, this.timeLimit - this.matchTime()),
        outside: sim.outside > 0, outsideFor: sim.outside,
        leaderKills: Math.max(0, ...this.entities.map((e) => e.kills)),
        teams: this.teams ? this.teamScores() : null, myTeam: p.team,
      });
    }
    const L = this.course.length;
    return Object.assign(base, {
      lap: Math.min(sim.lap + 1, this.laps), laps: this.laps,
      lapTime: sim.started ? this.raceTime - sim.lapStart : 0, bestLap: p.bestLap, lastLap: sim.lapTimes[sim.lapTimes.length - 1] ?? null,
      lapFrac: sim.finished ? 1 : clamp(sim.dist / L - sim.lap, 0, 1),
      streak: sim.streak, wrongWay: sim.wrongWay > 0.8 && !sim.dead, wall: sim.wall, scraping: sim.scraping > 0,
      ghostDelta: this.ghostRun?.delta(sim) ?? null,
    });
  }

  audioState() {
    const p = this.player;
    if (!p) return { active: false, speedN: 0, throttle: 0, boost: false };
    const sim = p.sim;
    return {
      active: (!this.paused || this.mode === 'multi') && !sim.dead, speedN: clamp(Math.max(0, sim.forwardSpeed) / sim.p.topSpeed, 0, 1.4),
      throttle: p.input.throttle || 0, boost: sim.boosting, supersonic: sim.supersonic, wall: this.battle ? 0 : sim.wall, scraping: sim.scraping,
    };
  }

  respawnPlayer() {
    if (this.battle) return;
    if (this.player && this.state === 'racing' && !this.player.sim.finished && !this.player.sim.dead) this.player.sim.respawn();
  }

  toggleCamera() { this.cameraMode = this.cameraMode === 'chase' ? 'hood' : 'chase'; return this.cameraMode; }

  setViewport(w, h) { this.viewW = w; this.viewH = h; }

  resize(w, h) {
    this.speedFx?.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.setViewport(w, h);
    if (this.tunnel) this.tunnel.pixelHeight = this.o.renderer?.domElement?.height || h;
  }

  /** Advance AI without rendering — used to spread out the title-screen pack. */
  warmup(seconds) {
    for (let t = 0; t < seconds; t += FIXED_DT) {
      this._step(FIXED_DT, true, null);
      this.raceTime += FIXED_DT;
    }
    for (const e of this.entities) e.sim.events.length = 0;
    this.weapons.lasers.forEach((b) => (b.alive = false));
    this.weapons.events.length = 0;
  }

  dispose() {
    if (this.net && this._netHandlers) for (const [k, fn] of Object.entries(this._netHandlers)) this.net.removeEventListener(k, fn);
    for (const e of this.entities) { this.scene.remove(e.craft.root); e.craft.dispose(); e.trails.forEach((t) => t.trail.dispose()); }
    for (const pv of this.pickupViews.values()) { this.scene.remove(pv.group); pv.dispose(); }
    for (const v of this.itemViews.values()) this.scene.remove(v.obj);
    for (const p of this.propCache.values()) disposeProp(p);
    for (const r of this.ringViews) { this.scene.remove(r.g); r.g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
    this.tunnel?.dispose();
    this.hzViews?.dispose();
    this.debris?.dispose();
    this.speedFx?.dispose();
    this.padViews?.dispose();
    this.hz?.dispose();
    this.replays?.dispose();
    this.ghostRun?.dispose();
    this.belts.forEach((b) => b.dispose());
    this.weaponView.dispose();
    this.sparks.dispose(); this.shatter.dispose(); this.explosions.dispose(); this.dust?.dispose();
    this.sky.dispose();
  }
}

// ------------------------------------------------------------------------------ helpers

function battleOrder(a, b) {
  if (a.connected !== b.connected) return a.connected ? -1 : 1;
  return b.kills - a.kills || a.deaths - b.deaths || a.index - b.index;
}

function v3(v) { return [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100]; }

function validSnap(s) {
  if (!s || typeof s !== 'object') return false;
  const ok = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
  return ok(s.p, 3) && ok(s.q, 4) && ok(s.v, 3) && Number.isFinite(s.c);
}

export function applyPickup(sim, kind) {
  if (kind === 'boost') sim.boost = Math.min(1, sim.boost + 0.4);
  else if (kind === 'missile') sim.missiles = Math.min(4, sim.missiles + 1);
  else if (kind === 'shield') { sim.shield = sim.p.shield; sim.hull = Math.min(sim.p.hull, sim.hull + sim.p.hull * 0.3); }
}

let _mineGeo = null;
function mineMesh() {
  if (!_mineGeo) {
    _mineGeo = {
      core: new THREE.IcosahedronGeometry(1.4, 1),
      spike: new THREE.ConeGeometry(0.28, 1.4, 6),
      light: new THREE.SphereGeometry(0.42, 12, 8),
      shell: new THREE.MeshStandardMaterial({ color: 0x2a2d38, metalness: 0.85, roughness: 0.35, flatShading: true }),
      glow: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.35, 0.25) }),
    };
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(_mineGeo.core, _mineGeo.shell));
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const d of dirs) {
    const s = new THREE.Mesh(_mineGeo.spike, _mineGeo.shell);
    s.position.set(d[0] * 1.6, d[1] * 1.6, d[2] * 1.6);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...d));
    g.add(s);
  }
  for (const d of [[0.9, 0.9, 0.3], [-0.9, -0.6, 0.6], [0.2, -0.9, -0.9]]) {
    const l = new THREE.Mesh(_mineGeo.light, _mineGeo.glow);
    l.position.set(...d);
    g.add(l);
  }
  return g;
}

let _pickupGeo = null;
function pickupMesh(scene, kind) {
  if (!_pickupGeo) _pickupGeo = { core: new THREE.OctahedronGeometry(1.5, 0), ring: new THREE.TorusGeometry(2.6, 0.12, 6, 48) };
  const color = new THREE.Color(PICKUP_COLORS[kind] || '#ffffff');
  const coreMat = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.4) });
  const ringMat = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
  const group = new THREE.Group();
  const core = new THREE.Mesh(_pickupGeo.core, coreMat);
  const ring = new THREE.Mesh(_pickupGeo.ring, ringMat);
  group.add(core, ring);
  scene.add(group);
  return {
    group,
    update(dt, pos, time) {
      group.position.copy(pos);
      core.rotation.y += dt * 2;
      core.rotation.x += dt * 0.7;
      ring.rotation.x = time * 1.3;
      ring.rotation.y = time * 0.9;
      const s = 1 + Math.sin(time * 6) * 0.08;
      group.scale.setScalar(s);
    },
    dispose() { coreMat.dispose(); ringMat.dispose(); },
  };
}
