// In-match HUD: a pilot's visor. Every instrument sits on one implied ellipse round the
// field of view: the brow arc up top (lap progress / match score), the vitals arcs either
// side of centre (shield left, hull right), and the wake gauge low-centre (speed inside,
// boost wrapped round it). DOM + inline SVG carry the numbers and arcs; one overlay canvas
// draws everything that tracks the 3D world (reticle, nose marker, gate marker, target
// rings, lock-on) plus the radar. Race and battle share the layout; [data-game] swaps the
// mode panels.

import * as THREE from 'three';
import { formatTime, ordinal, escapeHtml, clamp } from '../core/util.js';

const TEAM_COLORS = ['#4da3ff', '#ff4d5e'];
const ION = '#4feaff', NITRO = '#ff7a2f', GOLD = '#ffc94a', HOT = '#ff4d5e', VISOR = '#eef3ff';
const UI_FONT = '"Saira", "Segoe UI", system-ui, sans-serif';
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _inv = new THREE.Quaternion();
const TAU = Math.PI * 2, RAD = Math.PI / 180;

// ---- SVG arc geometry (degrees, SVG convention: 0° = right, 90° = down).
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a * RAD), cy + r * Math.sin(a * RAD)];
/** Arc from a0 to a1; clockwise on screen when a1 > a0. */
function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0, sweep = a1 > a0 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// Wake gauge: a 200° arch open at the bottom.
const G = { cx: 200, cy: 222, a0: 170, a1: 370, rBoost: 170, rSpeed: 138, rText: 151, rRack: 192 };
const SPEED_SPAN = 1.5; // the speed arc reads 0 .. 1.5 × top speed (boost burst tops out near there)
const CRUISE = 1 / SPEED_SPAN;
const gA = (f) => G.a0 + (G.a1 - G.a0) * f;
// Brow: a shallow ∩ across the top, part of a big circle centred far below.
const B = { cx: 300, cy: 1000, r: 980, half: 16.6 };
const bA = (f) => 270 - B.half + 2 * B.half * f;
// Vitals: arcs either side of the screen centre.
const V = { r: 186, span: 30 };
// Ribbons (alerts, messages): text set on a gentle ∩ that follows the brow.
const RB = { cy: 1468, r: 1440, half: 18 };

const gauge = () => {
  const ticks = Array.from({ length: 21 }, (_, i) => {
    const f = i / 20, a = gA(f), major = i % 5 === 0;
    const [x0, y0] = pt(G.cx, G.cy, G.rSpeed - (major ? 13 : 9), a), [x1, y1] = pt(G.cx, G.cy, G.rSpeed - 5, a);
    return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${major ? 'maj' : ''}${f > CRUISE + 0.01 ? ' hot' : ''}"/>`;
  }).join('');
  const [cx0, cy0] = pt(G.cx, G.cy, G.rSpeed - 16, gA(CRUISE)), [cx1, cy1] = pt(G.cx, G.cy, G.rBoost + 11, gA(CRUISE));
  const rack = [0, 1, 2, 3].map((i) => {
    const a = 318 + i * 9;
    const [x0, y0] = pt(G.cx, G.cy, G.rRack - 6, a), [x1, y1] = pt(G.cx, G.cy, G.rRack + 6, a);
    return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
  }).join('');
  const [dx, dy] = pt(G.cx, G.cy, G.rRack, 222);
  return `
  <svg class="hud-gauge" viewBox="0 0 400 262" aria-hidden="true">
    <defs>
      <linearGradient id="hg-boost" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#ff5a1f"/><stop offset="0.55" stop-color="${NITRO}"/><stop offset="1" stop-color="${GOLD}"/></linearGradient>
      <linearGradient id="hg-speed" gradientUnits="userSpaceOnUse" x1="30" x2="370" y1="0" y2="0"><stop offset="0" stop-color="${VISOR}" stop-opacity="0.75"/><stop offset="0.66" stop-color="${VISOR}"/><stop offset="0.72" stop-color="${GOLD}"/><stop offset="1" stop-color="${NITRO}"/></linearGradient>
      <linearGradient id="hg-sonic" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.5" stop-color="#ffe7b0"/><stop offset="1" stop-color="#ff8fc8"/></linearGradient>
      <radialGradient id="hg-well" gradientUnits="userSpaceOnUse" cx="200" cy="200" r="150"><stop offset="0" stop-color="#06081a" stop-opacity="0.7"/><stop offset="0.7" stop-color="#06081a" stop-opacity="0.5"/><stop offset="1" stop-color="#06081a" stop-opacity="0.15"/></radialGradient>
      <path id="hg-groove" d="${arc(G.cx, G.cy, G.rText, 225, 315)}"/>
      <path id="hg-crown" d="${arc(G.cx, G.cy, 206, 228, 312)}"/>
    </defs>
    <path class="g-well" d="${arc(G.cx, G.cy, 134, G.a0, G.a1)}Z"/>
    <path class="g-disc" d="${arc(G.cx, G.cy, 154, G.a0, G.a1)}"/>
    <path class="g-btrack" d="${arc(G.cx, G.cy, G.rBoost, G.a0, G.a1)}" pathLength="100"/>
    <path class="g-bfill" data-k="boostArc" d="${arc(G.cx, G.cy, G.rBoost, G.a0, G.a1)}" pathLength="100"/>
    <path class="g-bnotch" d="${arc(G.cx, G.cy, G.rBoost, G.a0, G.a1)}" pathLength="100"/>
    <path class="g-bpulse" data-k="boostPulse" d="${arc(G.cx, G.cy, G.rBoost, G.a0, G.a1)}" pathLength="100"/>
    <path class="g-bstreak" d="${arc(G.cx, G.cy, G.rBoost, G.a0, G.a1)}" pathLength="100"/>
    <g class="g-ticks">${ticks}</g>
    <path class="g-strack" d="${arc(G.cx, G.cy, G.rSpeed, G.a0, G.a1)}"/>
    <path class="g-sfill" data-k="speedArc" d="${arc(G.cx, G.cy, G.rSpeed, G.a0, G.a1)}" pathLength="100"/>
    <line class="g-cruise" x1="${cx0.toFixed(1)}" y1="${cy0.toFixed(1)}" x2="${cx1.toFixed(1)}" y2="${cy1.toFixed(1)}"/>
    <text class="g-sonic-label" text-anchor="middle"><textPath href="#hg-groove" startOffset="50%">Supersonic</textPath></text>
    <text class="g-near" data-k="nearMiss" text-anchor="middle"><textPath href="#hg-crown" startOffset="50%">Near miss</textPath></text>
    <text class="g-speed" x="${G.cx}" y="198" text-anchor="middle" data-k="speed">0</text>
    <text class="g-unit" x="${G.cx}" y="226" text-anchor="middle">m/s</text>
    <g class="g-rack" data-k="missiles">${rack}</g>
    <g class="g-dodge" data-k="dodge" transform="translate(${dx.toFixed(1)} ${dy.toFixed(1)}) rotate(${222 + 90})" hidden>
      <rect x="-25" y="-9" width="50" height="18" rx="9"/><text x="0" y="4.2" text-anchor="middle">Dodge</text>
    </g>
  </svg>`;
};

const brow = () => `
  <svg class="hud-brow" viewBox="0 0 600 72" aria-hidden="true">
    <path class="b-track" d="${arc(B.cx, B.cy, B.r, bA(0), bA(1))}"/>
    <path class="b-fill" data-k="browA" d="${arc(B.cx, B.cy, B.r, bA(0), bA(1))}" pathLength="100"/>
    <path class="b-fill b-fill-r" data-k="browB" d="${arc(B.cx, B.cy, B.r, bA(1), bA(0))}" pathLength="100"/>
    <g class="b-gates" data-k="browGates"></g>
    <g class="b-dots" data-k="browDots"></g>
  </svg>`;

const vitals = () => `
  <svg class="hud-vitals" viewBox="-210 -210 420 420" aria-hidden="true">
    <defs>
      <path id="hv-sl" d="${arc(0, 0, V.r + 12, 180 + V.span - 2, 180 + 8)}"/>
      <path id="hv-hl" d="${arc(0, 0, V.r + 12, -V.span + 2, -8)}"/>
    </defs>
    <path class="v-track" d="${arc(0, 0, V.r, 180 - V.span, 180 + V.span)}"/>
    <path class="v-fill v-shield" data-k="shieldArc" d="${arc(0, 0, V.r, 180 - V.span, 180 + V.span)}" pathLength="100"/>
    <path class="v-track" d="${arc(0, 0, V.r, V.span, -V.span)}"/>
    <path class="v-fill v-hull" data-k="hullArc" d="${arc(0, 0, V.r, V.span, -V.span)}" pathLength="100"/>
    <text class="v-label v-label-s"><textPath href="#hv-sl" startOffset="0">Shield</textPath></text>
    <text class="v-label v-label-h" text-anchor="end"><textPath href="#hv-hl" startOffset="100%">Hull</textPath></text>
  </svg>`;

const ribbon = (kText, cls) => `
  <svg class="${cls}" viewBox="0 0 900 120" aria-hidden="true">
    <defs><path id="${cls}-p" d="${arc(450, RB.cy, RB.r, 270 - RB.half, 270 + RB.half)}"/></defs>
    <path class="rb-band" d="${arc(450, RB.cy, RB.r, 270 - RB.half, 270 + RB.half)}" pathLength="100"/>
    <text class="rb-text" text-anchor="middle"><textPath href="#${cls}-p" startOffset="50%" data-k="${kText}"></textPath></text>
  </svg>`;

export class Hud {
  constructor(root, race) {
    this.root = root;
    this.race = race;
    this.cache = {};
    const reduce = !!race.settings?.reduceMotion;
    root.innerHTML = `
      <div class="hud" data-state="intro" data-game="${race.game}"${reduce ? ' data-reduce-motion="1"' : ''}>
        <canvas class="hud-overlay" aria-hidden="true"></canvas>
        <div class="hud-vignette" data-k="vignette"></div>
        <div class="hud-padflash" data-k="padFlash" aria-hidden="true"></div>
        ${vitals()}
        <div class="hud-tl">
          <div class="hud-pos"><b data-k="rank">1</b><small data-k="suffix">st</small><em>/ <span data-k="total">1</span></em></div>
          <svg class="hud-swoosh" viewBox="0 0 220 26" aria-hidden="true"><path d="M2 6 Q 70 26 218 14"/><path class="sw-thin" d="M18 14 Q 90 30 200 22"/></svg>
          <div class="race-only hud-splits">
            <div><span>Lap</span><b data-k="lapTime">0:00.000</b></div>
            <div><span>Best</span><b data-k="bestLap">--</b></div>
          </div>
          <div class="battle-only hud-splits">
            <div><span>Kills</span><b data-k="myKills">0</b></div>
            <div><span>Deaths</span><b data-k="myDeaths">0</b></div>
          </div>
          <div class="hud-chip hud-demos" data-k="demosChip" hidden><b data-k="demos">0</b><span data-k="demosLabel">demos</span></div>
        </div>
        <div class="hud-top">
          ${brow()}
          <div class="race-only hud-pill">
            <span class="hud-lap">Lap <b data-k="lap">1</b><i>/</i><span data-k="laps">3</span></span>
            <b class="hud-time" data-k="raceTime">0:00.000</b>
          </div>
          <div class="race-only hud-sub" data-k="ringCount"></div>
          <div class="race-only hud-ghost" data-k="ghost" hidden><span>Ghost</span><b data-k="ghostVal"></b></div>
          <div class="battle-only hud-score" data-k="scoreboard">
            <b class="sc t0" data-k="t0" hidden>0</b>
            <div class="hud-clock" data-k="clock">5:00</div>
            <b class="sc t1" data-k="t1" hidden>0</b>
          </div>
          <div class="battle-only hud-sub" data-k="teamGoal">first to 10</div>
        </div>
        <div class="hud-tr">
          <div class="hud-radar-wrap"><canvas class="hud-radar" width="200" height="200" aria-label="Radar"></canvas></div>
          <ul class="hud-feed" data-k="feed"></ul>
        </div>
        <div class="hud-bl"><ol class="hud-board" data-k="board"></ol></div>
        <div class="hud-cluster">${gauge()}</div>
        <div class="hud-alert" data-k="alert">${ribbon('alertText', 'rb-alert')}</div>
        <div class="hud-msg" data-k="msg">${ribbon('msgText', 'rb-msg')}</div>
        <div class="hud-center" data-k="center"></div>
        <div class="hud-hint" data-k="hint"></div>
        <div class="hud-replay" aria-hidden="true">
          <i class="rp-bar rp-top"></i><i class="rp-bar rp-bot"></i>
          <span class="rp-tag"><b>Replay</b><em data-k="replayLabel"></em></span>
          <span class="rp-skip">Press any key to skip</span>
        </div>
      </div>`;
    this.el = {};
    root.querySelectorAll('[data-k]').forEach((n) => (this.el[n.dataset.k] = n));
    this.hudEl = root.querySelector('.hud');
    this.overlay = root.querySelector('.hud-overlay');
    this.radar = root.querySelector('.hud-radar');
    this.rbAlert = root.querySelector('.rb-alert');
    this.rbMsg = root.querySelector('.rb-msg');
    this.missilePips = [...this.el.missiles.children];
    this.msgTimer = 0;
    this.centerTimer = 0;
    this.hurt = 0;
    this.hitFlash = 0;
    this.lastPad = null;
    this.lastNear = null;
    this.nearTimer = 0;
    this.accent = race.def.theme.accent || ION;
    this._buildBrowMarks();
    this._resize();
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.overlay.width = Math.round(this.w * dpr);
    this.overlay.height = Math.round(this.h * dpr);
    this.race.setViewport?.(this.w, this.h);
  }

  /** Boost-gate ticks along the brow (race) and one dot per rival. */
  _buildBrowMarks() {
    const race = this.race;
    const ns = 'http://www.w3.org/2000/svg';
    if (!race.battle && race.course?.rings) {
      this.el.browGates.innerHTML = race.course.rings.map((r) => {
        const [x0, y0] = pt(B.cx, B.cy, B.r - 5, bA(r.u)), [x1, y1] = pt(B.cx, B.cy, B.r + 5, bA(r.u));
        return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`;
      }).join('');
    }
    this.browDots = new Map();
    for (const e of race.entities || []) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('r', e === race.player ? '6' : '4');
      c.setAttribute('class', e === race.player ? 'me' : '');
      c.style.setProperty('--c', e.team != null ? TEAM_COLORS[e.team] : e.design?.colors?.glow || VISOR);
      this.el.browDots.appendChild(c);
      this.browDots.set(e, c);
    }
    // the player's dot draws on top
    const mine = this.browDots.get(race.player);
    if (mine) this.el.browDots.appendChild(mine);
  }

  _set(k, v) {
    if (this.cache[k] === v) return;
    this.cache[k] = v;
    this.el[k].textContent = v;
  }

  /** Fill a pathLength=100 arc to v (0..1). */
  _arc(k, v) {
    const pct = Math.round(clamp(v, 0, 1) * 1000) / 10;
    if (this.cache[k] === pct) return;
    this.cache[k] = pct;
    const n = this.el[k];
    n.style.strokeDasharray = `${pct} 200`;
    n.style.opacity = pct < 0.4 ? '0' : '';
  }

  _flag(cls, on) {
    on = !!on;
    if (this.cache['c:' + cls] === on) return;
    this.cache['c:' + cls] = on;
    this.hudEl.classList.toggle(cls, on);
  }

  /** Restart a CSS animation class on an element. */
  _kick(node, cls) {
    node.classList.remove(cls); void node.getBoundingClientRect(); node.classList.add(cls);
  }

  /** Size a ribbon's band to its text so it reads as one curved tag. */
  _fitRibbon(svg) {
    const text = svg.querySelector('.rb-text');
    const band = svg.querySelector('.rb-band');
    let len = 0;
    try { len = text.getComputedTextLength(); } catch { len = 0; }
    const pathLen = 2 * Math.PI * RB.r * (2 * RB.half / 360);
    const pct = clamp((len + 64) / pathLen * 100, 8, 100);
    band.style.strokeDasharray = `${pct} 200`;
    band.style.strokeDashoffset = String(-(100 - pct) / 2);
  }

  flash(text, ms = 1600, tone = '') {
    const m = this.el.msg;
    this.el.msgText.textContent = text;
    m.dataset.tone = tone;
    this._fitRibbon(this.rbMsg);
    this._kick(m, 'show');
    m.style.setProperty('--ms', `${ms}ms`);
    this.msgTimer = ms / 1000;
  }

  center(text, cls = '') {
    const c = this.el.center;
    c.textContent = text;
    c.className = 'hud-center ' + cls;
    void c.offsetWidth;
    c.classList.add('pop');
    this.centerTimer = 0.9;
  }

  hint(text) { this._set('hint', text); this.el.hint.hidden = !text; }

  damage(amount, shieldOnly) {
    this.hurt = Math.min(1, this.hurt + (shieldOnly ? 0.25 : 0.55) + amount / 80);
    this.el.vignette.dataset.tone = shieldOnly ? 'shield' : 'hull';
    this.hudEl.dataset.hit = shieldOnly ? 'shield' : 'hull';
    this._kick(this.hudEl, 'is-hit');
    this.hitFlash = 0.45;
  }

  update(dt, s) {
    if (!s) return;
    if (this.cache.state !== s.state) { this.cache.state = s.state; this.hudEl.dataset.state = s.state; }
    const battle = s.game === 'battle';
    this._set('rank', String(s.rank));
    this._set('suffix', ordinal(s.rank).replace(/^\d+/, ''));
    this._set('total', String(s.total));
    if (battle) this._battle(s); else this._raceBits(s);
    // Replays: letterbox and a small tag; the instruments step aside.
    this._flag('is-replay', !!s.replay);
    if (s.replay) this._set('replayLabel', s.replay.label + (s.replay.count > 1 ? ` · ${s.replay.index} of ${s.replay.count}` : ''));

    // Wake gauge.
    const top = s.topSpeed || 1;
    const speedN = s.speed / (top * SPEED_SPAN);
    this._set('speed', String(Math.round(s.speed)));
    this._arc('speedArc', speedN);
    this._arc('boostArc', s.boost);
    this.el.boostPulse.style.strokeDasharray = this.el.boostArc.style.strokeDasharray; // the pickup pulse lights only what's in the tank
    this._arc('shieldArc', s.shield);
    this._arc('hullArc', s.hull);
    this._flag('is-boosting', s.boosting);
    this._flag('is-overcruise', s.speed > top * 1.02);
    this._flag('is-supersonic', s.supersonic);
    this._flag('is-overheated', s.overheated);
    this._flag('is-lowhull', s.hull < 0.3 && !s.dead);
    this._flag('is-noshield', s.shield < 0.02);
    this._flag('is-boostempty', s.boost < 0.04);
    this._flag('is-dead', s.dead);
    if (this.cache.missiles !== s.missiles) {
      this.cache.missiles = s.missiles;
      this.missilePips.forEach((p, i) => p.classList.toggle('on', i < s.missiles));
    }
    // Optional fields from newer match code: render when present.
    const hasDodge = typeof s.dodgeReady === 'boolean';
    this.el.dodge.toggleAttribute('hidden', !hasDodge);
    if (hasDodge) this._flag('is-dodgeready', s.dodgeReady);
    const demos = typeof s.demos === 'number' ? s.demos : 0;
    if (this.cache.demos !== demos) {
      this.cache.demos = demos;
      this.el.demosChip.hidden = demos <= 0;
      this.el.demos.textContent = String(demos);
      this.el.demosLabel.textContent = demos === 1 ? 'demo' : 'demos';
      if (demos > 0) this._kick(this.el.demosChip, 'pop');
    }
    const pad = s.boostPad;
    if (pad && typeof pad.t === 'number') {
      if (this.lastPad == null || pad.t < this.lastPad - 1e-3) {
        this.el.boostPulse.classList.toggle('big', !!pad.big);
        this._kick(this.el.boostPulse, 'go');
        this._kick(this.hudEl.querySelector('.hud-gauge'), pad.big ? 'pad-big' : 'pad');
        if (pad.big) this._kick(this.el.padFlash, 'go');
      }
      this.lastPad = pad.t;
    } else this.lastPad = null;
    const near = typeof s.nearMiss === 'number' ? s.nearMiss : null;
    if (near != null && near < 0.25 && (this.lastNear == null || near < this.lastNear - 1e-3)) { this._kick(this.el.nearMiss, 'go'); this.nearTimer = 1.1; }
    if (this.nearTimer > 0) { this.nearTimer -= dt; if (this.nearTimer <= 0) this.el.nearMiss.classList.remove('go'); }
    this.lastNear = near;

    // Alerts, most important first.
    let alert = '', tone = '';
    if (s.dead) { alert = `Ship destroyed. Respawning in ${Math.max(0, s.respawnIn).toFixed(1)}`; tone = 'bad'; }
    else if (s.incoming) { alert = 'Missile incoming'; tone = 'bad'; }
    else if (battle && s.outside) { alert = s.outsideFor > 5 ? 'Outside the arena: taking damage' : 'Leaving the arena. Turn back'; tone = s.outsideFor > 5 ? 'bad' : 'warn'; }
    else if (!battle && s.wrongWay) { alert = 'Wrong way. Centre the stick to turn round'; tone = 'warn'; }
    else if (s.overheated) { alert = 'Lasers overheated'; tone = 'warn'; }
    if (this.cache.alert !== alert) {
      const was = this.cache.alert;
      this.cache.alert = alert;
      if (alert) {
        this.el.alertText.textContent = alert;
        this.el.alert.dataset.tone = tone;
        // Countdown text changes every frame; only refit when the message itself changes.
        if (!was || was.slice(0, 12) !== alert.slice(0, 12)) this._fitRibbon(this.rbAlert);
      }
      this.el.alert.classList.toggle('show', !!alert);
    }

    // Online: each human's round trip to the host, from NetSession's ping table.
    const net = this.race.net;
    const ping = (id) => (net?.kind === 'relay' && id !== net.lobby?.hostId && net.pings?.[id] != null ? net.pings[id] : null);
    const bk = s.standings.map((r) => r.id + (r.finished ? 'f' : '') + (r.connected ? '' : 'x') + (r.dead ? 'd' : '') + (battle ? r.kills + '/' + r.deaths : '') + (ping(r.id) ?? '')).join(',');
    if (this.cache.board !== bk) {
      this.cache.board = bk;
      this.el.board.innerHTML = s.standings.map((r, i) => `<li class="${r.isPlayer ? 'me' : ''}${r.connected ? '' : ' gone'}${r.dead ? ' dead' : ''}" style="--c:${r.color}"><span class="n">${i + 1}</span><span class="nm">${escapeHtml(r.name)}</span>${ping(r.id) != null ? `<em class="ping">${ping(r.id)} ms</em>` : ''}${battle ? `<em class="score">${r.kills}</em>` : r.finished ? '<em class="fin">Finished</em>' : ''}</li>`).join('');
    }
    const fk = s.killFeed.map((k) => k.text).join('|');
    if (this.cache.feed !== fk) {
      this.cache.feed = fk;
      this.el.feed.innerHTML = s.killFeed.map((k) => `<li class="${k.mine ? 'mine' : ''}${k.me ? ' me' : ''}">${escapeHtml(k.text)}</li>`).join('');
    }

    if (this.msgTimer > 0) { this.msgTimer -= dt; if (this.msgTimer <= 0) this.el.msg.classList.remove('show'); }
    if (this.centerTimer > 0) { this.centerTimer -= dt; if (this.centerTimer <= 0) this.el.center.classList.remove('pop'); }
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    this.el.vignette.style.opacity = String(this.hurt * 0.5);

    this._drawOverlay(s);
    this._drawRadar();
  }

  _raceBits(s) {
    this._set('lap', String(s.lap));
    this._set('laps', String(s.laps));
    this._set('raceTime', formatTime(s.raceTime));
    this._set('lapTime', formatTime(s.finished ? s.lastLap : s.lapTime));
    this._set('bestLap', s.bestLap ? formatTime(s.bestLap) : '--');
    this._arc('browA', s.lapFrac);
    this._arc('browB', 0);
    this._set('ringCount', s.streak >= 2 ? `Gate streak ×${s.streak}` : '');
    this._flag('has-streak', s.streak >= 2);
    this._flag('is-scraping', s.scraping);
    this._flag('is-wrongway', s.wrongWay);
    this._flag('is-finallap', s.lap === s.laps && s.laps > 1 && !s.finished);
    // Live gap to your ghost: minus (green) when you're ahead, plus (warm) when behind.
    const gd = s.ghostDelta;
    const gt = gd == null ? '' : `${gd < 0 ? '\u2212' : '+'}${Math.abs(gd).toFixed(2)}`;
    if (this.cache.ghostOn !== !!gt) { this.cache.ghostOn = !!gt; this.el.ghost.hidden = !gt; }
    if (gt) { this._set('ghostVal', gt); this.el.ghost.dataset.tone = gd < 0 ? 'ahead' : 'behind'; }
    // Gates already passed this lap dim on the brow.
    const gk = Math.round(s.lapFrac * 200);
    if (this.cache.gates !== gk) {
      this.cache.gates = gk;
      const rings = this.race.course?.rings || [];
      [...this.el.browGates.children].forEach((n, i) => n.classList.toggle('past', rings[i] && rings[i].u < s.lapFrac));
    }
    // Every pilot's place in the lap, along the brow.
    const L = this.race.course?.length;
    if (L) {
      for (const [e, c] of this.browDots) {
        const sim = e.sim;
        const show = e.connected && sim && !(e !== this.race.player && sim.dead);
        if (!show) { c.style.display = 'none'; continue; }
        c.style.display = '';
        const f = sim.finished ? 1 : clamp(sim.dist / L - sim.lap, 0, 1);
        const [x, y] = pt(B.cx, B.cy, B.r, bA(f));
        c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1));
      }
    }
  }

  _battle(s) {
    this._set('myKills', String(s.kills));
    this._set('myDeaths', String(s.deaths));
    const t = Math.ceil(s.timeLeft);
    this._set('clock', `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
    this._flag('is-lowtime', s.timeLeft < 30 && s.state === 'racing');
    const teams = !!s.teams;
    this._flag('is-teams', teams);
    this.el.t0.hidden = !teams; this.el.t1.hidden = !teams;
    const target = Math.max(1, s.target || 1);
    if (teams) {
      this._set('t0', String(s.teams[0])); this._set('t1', String(s.teams[1]));
      this._set('teamGoal', `First to ${s.target}`);
      this._arc('browA', s.teams[0] / target);
      this._arc('browB', s.teams[1] / target);
    } else {
      const lead = s.leaderKills ?? 0;
      this._set('teamGoal', lead > s.kills ? `Leader on ${lead} of ${s.target}` : `First to ${s.target}`);
      this._arc('browA', s.kills / target);
      this._arc('browB', 0);
    }
    for (const c of this.browDots?.values() || []) c.style.display = 'none';
  }

  // ------------------------------------------------------------------ overlay
  _project(p) {
    const cam = this.race.camera;
    _v.copy(p).project(cam);
    // Behind the camera?
    _w.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const behind = _w.z > 0;
    return { x: (_v.x + 1) / 2 * this.w, y: (1 - _v.y) / 2 * this.h, behind, onScreen: !behind && Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1, dist: _w.length() };
  }

  /** A text label on a dark rounded tag, so names stay legible over bright nebulae. */
  _tag(g, text, x, y, color) {
    const w = g.measureText(text).width + 14, h = 17;
    g.fillStyle = 'rgba(6,8,26,0.62)';
    g.beginPath(); g.roundRect(x - w / 2, y - h + 4, w, h, h / 2); g.fill();
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  _drawOverlay(s) {
    const g = this.overlay.getContext('2d');
    const race = this.race;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (s.state === 'intro' || s.finished || race.player.sim.dead || race.paused) return;
    const p = race.player.sim;
    const now = performance.now() / 1000;
    const still = this.hudEl.dataset.reduceMotion === '1';
    g.lineCap = 'round';
    g.font = `600 12px ${UI_FONT}`;
    g.textAlign = 'center';

    // Rivals: curved brackets, names, lock rings.
    for (const e of race.entities) {
      if (e === race.player || !e.connected || e.sim.dead) continue;
      const pr = this._project(e.sim.pos);
      if (!pr.onScreen || pr.dist > 1400) continue;
      const size = clamp(900 / pr.dist, 10, 34);
      const locked = s.lock.id === e.id;
      const soft = race.aim.onTarget === e.id;
      const mate = e.team != null && e.team === race.player.team;
      if (mate) {
        // Teammates: a quiet ring with a chevron, in team colour, never a target.
        const col = TEAM_COLORS[e.team];
        const r = clamp(700 / pr.dist, 6, 14);
        g.strokeStyle = col; g.lineWidth = 1.6;
        g.beginPath(); g.arc(pr.x, pr.y, r, 0, TAU); g.stroke();
        g.beginPath(); g.moveTo(pr.x - 4, pr.y - r - 8); g.lineTo(pr.x, pr.y - r - 4); g.lineTo(pr.x + 4, pr.y - r - 8); g.stroke();
        if (pr.dist < 600) this._tag(g, e.name, pr.x, pr.y - r - 13, col);
        continue;
      }
      const enemyCol = e.team != null ? TEAM_COLORS[e.team] : 'rgba(238,243,255,0.8)';
      const color = locked ? (s.lock.locked ? HOT : GOLD) : soft ? '#ffffff' : enemyCol;
      g.strokeStyle = color; g.lineWidth = locked || soft ? 2.2 : 1.6;
      // four arc brackets with gaps on the diagonals
      for (let q = 0; q < 4; q++) {
        const mid = q * Math.PI / 2;
        g.beginPath(); g.arc(pr.x, pr.y, size, mid - 0.42, mid + 0.42); g.stroke();
      }
      if (locked) {
        const rr = size + 8;
        if (!s.lock.locked) {
          g.globalAlpha = 0.25; g.beginPath(); g.arc(pr.x, pr.y, rr, 0, TAU); g.stroke(); g.globalAlpha = 1;
          g.lineWidth = 3;
          g.beginPath(); g.arc(pr.x, pr.y, rr, -Math.PI / 2, -Math.PI / 2 + s.lock.t * TAU); g.stroke();
        } else {
          // locked: a closed ring with three turning teeth
          g.lineWidth = 2.4;
          g.beginPath(); g.arc(pr.x, pr.y, rr, 0, TAU); g.stroke();
          const spin = still ? 0 : now * 2.4;
          g.lineWidth = 3.4;
          for (let i = 0; i < 3; i++) {
            const a = spin + i * TAU / 3;
            g.beginPath(); g.arc(pr.x, pr.y, rr + 6, a - 0.25, a + 0.25); g.stroke();
          }
        }
      }
      if (pr.dist < 700) {
        this._tag(g, locked && s.lock.locked ? `${e.name}  locked` : e.name, pr.x, pr.y - size - (locked ? 20 : 10), color);
        // health as a curved arc under the brackets
        const hf = clamp(e.sim.hull / e.sim.p.hull, 0, 1);
        const hr = size + 5, a0 = Math.PI * 0.68, a1 = Math.PI * 0.32;
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(6,8,26,0.65)';
        g.beginPath(); g.arc(pr.x, pr.y, hr, a1, a0); g.stroke();
        g.strokeStyle = hf < 0.3 ? HOT : VISOR;
        if (hf > 0.01) { g.beginPath(); g.arc(pr.x, pr.y, hr, a0 - (a0 - a1) * hf, a0); g.stroke(); }
      }
    }

    if (race.battle) {
      // Off-screen rivals nearby: chevrons on the visor's edge.
      for (const e of race.entities) {
        if (e === race.player || !e.connected || e.sim.dead) continue;
        const pr = this._project(e.sim.pos);
        if (pr.onScreen || pr.dist > 900) continue;
        if (e.team != null && e.team === race.player.team) continue;
        this._edgeArrow(g, pr, e.team != null ? TEAM_COLORS[e.team] : e.design.colors.glow, pr.dist < 350 ? `${Math.round(pr.dist)} m` : '', 0.9);
      }
    } else {
      // Next boost gate: a quiet amber arc-chevron when it's ahead and close; gates are optional.
      const ring = race.course.rings[p.nextRing];
      if (ring) {
        const rp = this._project(ring.pos);
        const ahead = (p.gateLap + ring.u) * race.course.length - p.dist;
        if (rp.onScreen && ahead > 40 && ahead < 650) {
          g.globalAlpha = clamp((650 - ahead) / 200, 0, 1) * 0.9;
          g.strokeStyle = GOLD; g.lineWidth = 2.2;
          const r = clamp(ring.radius * 380 / rp.dist, 6, 40);
          g.beginPath(); g.arc(rp.x, rp.y, r + 8, Math.PI * 1.3, Math.PI * 1.7); g.stroke();
          g.beginPath(); g.moveTo(rp.x - 6, rp.y - r - 18); g.lineTo(rp.x, rp.y - r - 13); g.lineTo(rp.x + 6, rp.y - r - 18); g.stroke();
          g.globalAlpha = 1;
        }
      }
    }

    // Nose marker: where the guns point by default.
    _v.set(0, 0, -400).applyQuaternion(p.quat).add(p.pos);
    const np = this._project(_v);
    const ax = race.aim.px, ay = race.aim.py;
    if (np.onScreen) {
      g.strokeStyle = 'rgba(238,243,255,0.6)'; g.lineWidth = 1.6;
      g.beginPath(); g.arc(np.x, np.y, 5, 0, TAU); g.stroke();
      const d = Math.hypot(ax - np.x, ay - np.y);
      if (d > 30) {
        g.strokeStyle = 'rgba(238,243,255,0.2)'; g.setLineDash([2, 7]);
        g.beginPath(); g.moveTo(np.x + (ax - np.x) / d * 9, np.y + (ay - np.y) / d * 9); g.lineTo(ax - (ax - np.x) / d * 26, ay - (ay - np.y) / d * 26); g.stroke();
        g.setLineDash([]);
      }
    }

    // Lead pip: where the guns are actually aiming on the soft target.
    if (!race.autopilot && race.aim.lead && !race.aim.outOfArc) {
      const lp = this._project(race.aim.lead);
      if (lp.onScreen) {
        g.strokeStyle = HOT; g.lineWidth = 1.8;
        g.beginPath(); g.arc(lp.x, lp.y, 6, 0, TAU); g.stroke();
        g.fillStyle = HOT; g.beginPath(); g.arc(lp.x, lp.y, 1.8, 0, TAU); g.fill();
      }
    }

    // Reticle at the cursor: two curved brackets, a centre pip, heat underneath.
    if (!race.autopilot) {
      const on = race.aim.onTarget;
      const out = race.aim.outOfArc;
      const col = s.overheated ? HOT : out ? 'rgba(238,243,255,0.45)' : on ? HOT : '#ffffff';
      g.strokeStyle = 'rgba(6,8,26,0.45)'; g.lineWidth = 4.5;
      g.beginPath(); g.arc(ax, ay, 16, Math.PI - 0.62, Math.PI + 0.62); g.stroke();
      g.beginPath(); g.arc(ax, ay, 16, -0.62, 0.62); g.stroke();
      g.strokeStyle = col; g.lineWidth = 2;
      if (out) g.setLineDash([3, 4]);
      g.beginPath(); g.arc(ax, ay, 16, Math.PI - 0.62, Math.PI + 0.62); g.stroke();
      g.beginPath(); g.arc(ax, ay, 16, -0.62, 0.62); g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(ax, ay - 21); g.lineTo(ax, ay - 26); g.stroke();
      g.fillStyle = col; g.beginPath(); g.arc(ax, ay, 2, 0, TAU); g.fill();
      if (out) this._tag(g, 'Turn to fire', ax, ay + 46, 'rgba(238,243,255,0.8)');
      // heat: a thin arc cupping the reticle from below
      const h0 = Math.PI * 0.78, h1 = Math.PI * 0.22;
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(238,243,255,0.14)';
      g.beginPath(); g.arc(ax, ay, 24, h1, h0); g.stroke();
      if (s.heat > 0.02) {
        g.strokeStyle = s.overheated ? HOT : s.heat > 0.7 ? NITRO : GOLD;
        g.beginPath(); g.arc(ax, ay, 24, h0 - (h0 - h1) * clamp(s.heat, 0, 1), h0); g.stroke();
      }
      if (s.hitMarker) {
        g.strokeStyle = '#ffffff'; g.lineWidth = 2.2;
        for (let q = 0; q < 4; q++) {
          const mid = Math.PI / 4 + q * Math.PI / 2;
          g.beginPath(); g.arc(ax, ay, 10, mid - 0.32, mid + 0.32); g.stroke();
        }
      }
    }
  }

  _edgeArrow(g, rp, color, label, alpha = 1) {
    let dx = rp.x - this.w / 2, dy = rp.y - this.h / 2;
    if (rp.behind) { dx = -dx; dy = -dy; if (Math.hypot(dx, dy) < 1) dy = 1; }
    const ang = Math.atan2(dy, dx);
    // Pin to an ellipse inside the screen edge, so arrows stay clear of the corner panels.
    const ax = this.w / 2 + Math.cos(ang) * (this.w / 2 - 120), ay = this.h / 2 + Math.sin(ang) * (this.h / 2 - 80);
    g.globalAlpha = alpha;
    g.save(); g.translate(ax, ay); g.rotate(ang);
    g.strokeStyle = color; g.lineWidth = 3; g.lineJoin = 'round';
    g.beginPath(); g.arc(-14, 0, 22, -0.5, 0.5); g.stroke();
    g.fillStyle = color;
    g.beginPath(); g.moveTo(14, 0); g.lineTo(2, -7); g.quadraticCurveTo(5, 0, 2, 7); g.closePath(); g.fill();
    g.restore();
    if (label) this._tag(g, label, ax - Math.cos(ang) * 30, ay - Math.sin(ang) * 30 + 4, color);
    g.globalAlpha = 1;
  }

  _drawRadar() {
    const g = this.radar.getContext('2d');
    const race = this.race;
    const W = this.radar.width, R = W / 2 - 10, cx = W / 2, cy = W / 2;
    g.clearRect(0, 0, W, W);
    const bg = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    bg.addColorStop(0, 'rgba(14,20,52,0.72)'); bg.addColorStop(1, 'rgba(6,8,26,0.72)');
    g.fillStyle = bg;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
    // forward cone
    const cone = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    cone.addColorStop(0, 'rgba(79,234,255,0.20)'); cone.addColorStop(1, 'rgba(79,234,255,0)');
    g.fillStyle = cone;
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(160,190,255,0.16)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, R * 0.5, 0, TAU); g.stroke();
    // bezel with ticks
    g.strokeStyle = 'rgba(160,190,255,0.35)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(79,234,255,0.9)'; g.lineWidth = 3; g.lineCap = 'round';
    g.beginPath(); g.arc(cx, cy, R + 5, -Math.PI / 2 - 0.3, -Math.PI / 2 + 0.3); g.stroke();
    g.strokeStyle = 'rgba(160,190,255,0.3)'; g.lineWidth = 1.5;
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * TAU;
      if (Math.abs(((a + Math.PI / 2) % TAU + TAU) % TAU) < 0.001) continue;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * (R + 3), cy + Math.sin(a) * (R + 3)); g.lineTo(cx + Math.cos(a) * (R + (i % 6 === 0 ? 8 : 5)), cy + Math.sin(a) * (R + (i % 6 === 0 ? 8 : 5))); g.stroke();
    }
    const p = race.player.sim;
    _inv.copy(p.quat).invert();
    const range = 900;
    const plot = (pos, color, size, shape) => {
      _v.subVectors(pos, p.pos).applyQuaternion(_inv); // local: x right, y up, -z forward
      const d = Math.hypot(_v.x, _v.z);
      let x = _v.x / range * R, y = _v.z / range * R;
      const m = Math.hypot(x, y);
      if (m > R - 5) { x *= (R - 5) / m; y *= (R - 5) / m; }
      const elev = clamp(_v.y / range * R, -R * 0.4, R * 0.4);
      g.strokeStyle = color; g.globalAlpha = 0.5; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(cx + x, cy + y); g.lineTo(cx + x, cy + y - elev); g.stroke();
      g.globalAlpha = d > range ? 0.5 : 1;
      g.fillStyle = color;
      if (shape === 'diamond') {
        g.beginPath(); g.moveTo(cx + x, cy + y - elev - size); g.lineTo(cx + x + size, cy + y - elev); g.lineTo(cx + x, cy + y - elev + size); g.lineTo(cx + x - size, cy + y - elev); g.closePath(); g.fill();
      } else {
        g.beginPath(); g.arc(cx + x, cy + y - elev, size, 0, TAU); g.fill();
      }
      g.globalAlpha = 1;
    };
    if (race.battle) plot(race.course.center, 'rgba(238,243,255,0.55)', 4.5, 'diamond');
    else if (race.course.rings[p.nextRing]) plot(race.course.rings[p.nextRing].pos, GOLD, 4.5, 'diamond');
    for (const e of race.entities) if (e !== race.player && e.connected && !e.sim.dead) plot(e.sim.pos, e.team != null ? TEAM_COLORS[e.team] : e.design.colors.glow, 4);
    for (const m of race.weapons.missiles) if (m.alive) plot(m.pos, HOT, 2.5);
    // self
    g.fillStyle = '#ffffff';
    g.beginPath(); g.moveTo(cx, cy - 8); g.quadraticCurveTo(cx + 2, cy, cx + 6, cy + 6); g.lineTo(cx, cy + 3); g.lineTo(cx - 6, cy + 6); g.quadraticCurveTo(cx - 2, cy, cx, cy - 8); g.fill();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.root.innerHTML = '';
  }
}
