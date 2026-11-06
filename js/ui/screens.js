// DOM screens layered over the 3D canvas. Each screen builder returns
// { el, onBack?, unmount? }. Gamepad users navigate with the d-pad/stick
// (spatial focus), keyboard users with Tab/Enter/Escape.

import { escapeHtml, formatTime, ordinal, $, $$ } from '../core/util.js';
import { storage, DEFAULT_SETTINGS } from '../core/storage.js';
import { isLocalRelayUrl } from '../net/transport.js';
import { resolveRelayUrl, servedByRelay, normalizeRelayUrl, warmRelay, inviteLink } from '../net/online.js';
import { COURSES as TRACKS, getCourseDef as getTrackDef } from '../flight/courseDefs.js';
import { ARENAS, getArenaDef } from '../flight/arenaDefs.js';
import { BODIES, randomDesign, normalizeDesign } from '../craft/parts.js';
import { mulberry32 } from '../core/util.js';
import { HangarScreen } from './hangar.js';
import { rankPill, courseMedal, targetsPanel, resultsPanel } from './careerView.js';

const html = (s) => {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.firstElementChild;
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

export class Screens {
  constructor(app) {
    this.app = app;
    this.root = app.uiRoot;
    this.current = null;
    this.currentName = null;
    this.overlayView = null;
    this.overlayName = null;

    // UI sounds via delegation.
    this.root.addEventListener('pointerover', (e) => {
      const b = e.target.closest('button, .choice');
      if (b && b !== this._lastHover && !b.disabled) { this._lastHover = b; app.audio.play('hover'); }
    });
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b && !b.disabled) app.audio.play(b.dataset.sound || 'click');
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.target.matches('input, select')) return; // handled by Input -> back
    });
  }

  /** Mirror Settings → Reduce motion onto <html> so the stylesheet can calm every screen. */
  syncMotion() {
    document.documentElement.dataset.reduceMotion = this.app.settings.reduceMotion ? '1' : '';
  }

  show(name, props = {}) {
    this.syncMotion();
    this.closeOverlay();
    this.current?.unmount?.();
    const view = this[name](props);
    this.current = view;
    this.currentName = name;
    this.root.replaceChildren(view.el);
    this.root.dataset.screen = name;
    this._autofocus(view.el);
  }

  overlay(name, props = {}) {
    this.closeOverlay();
    const view = this[name](props);
    this.overlayView = view;
    this.overlayName = name;
    view.el.classList.add('overlay');
    this.root.appendChild(view.el);
    this._autofocus(view.el);
  }

  closeOverlay() {
    if (!this.overlayView) return;
    this.overlayView.unmount?.();
    this.overlayView.el.remove();
    this.overlayView = null;
    this.overlayName = null;
  }

  _autofocus(el) {
    const target = el.querySelector('[autofocus]') || el.querySelector('.menu button, .primary') || null;
    if (target && this.app.input.activeDevice === 'gamepad') target.focus({ preventScroll: true });
    else if (target && target.matches('[autofocus]')) target.focus({ preventScroll: true });
  }

  /** Gamepad navigation + back for whichever view is on top. */
  handleInput(input) {
    const view = this.overlayView || this.current;
    if (!view) return;
    const inLiveRace = this.app.race && this.currentName === 'race' && !this.overlayView;
    // Esc is both "back" and "pause": in the pause menu the app's pause toggle owns it.
    const pauseOwnsIt = this.overlayName === 'pause' && input.pressed('pause');
    if (input.pressed('back') && view.onBack && !inLiveRace && !pauseOwnsIt) {
      this.app.audio.play('back');
      view.onBack();
      return;
    }
    const scope = view.el;
    for (const dir of ['up', 'down', 'left', 'right']) {
      if (!input.pressed(dir)) continue;
      const active = document.activeElement;
      if (active && scope.contains(active) && active.matches('input[type=range]') && (dir === 'left' || dir === 'right')) {
        active.value = Number(active.value) + (dir === 'left' ? -1 : 1) * Number(active.step || 1);
        active.dispatchEvent(new Event('input', { bubbles: true }));
        active.dispatchEvent(new Event('change', { bubbles: true }));
        continue;
      }
      if (active && scope.contains(active) && active.dataset.cycle && (dir === 'left' || dir === 'right')) {
        active.dispatchEvent(new CustomEvent('cycle', { detail: dir === 'left' ? -1 : 1, bubbles: true }));
        continue;
      }
      this._moveFocus(scope, dir);
    }
    if (input.pressed('confirm') && input.activeDevice === 'gamepad') {
      const a = document.activeElement;
      if (a && scope.contains(a)) {
        if (a.matches('input[type=checkbox]')) { a.checked = !a.checked; a.dispatchEvent(new Event('change', { bubbles: true })); }
        else a.click();
      }
    }
  }

  _moveFocus(scope, dir) {
    const els = $$(FOCUSABLE, scope).filter((e) => e.offsetParent !== null);
    if (!els.length) return;
    const cur = document.activeElement;
    if (!cur || !scope.contains(cur)) { els[0].focus(); return; }
    const r0 = cur.getBoundingClientRect();
    const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    let best = null, bestScore = Infinity;
    for (const e of els) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect();
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const dx = c.x - c0.x, dy = c.y - c0.y;
      const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
      const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (along <= 4) continue;
      const score = along + across * 2.2;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest' }); this.app.audio.play('hover'); }
  }

  // ================================================================ screens
  loading({ trackId, game }) {
    const def = game === 'battle' ? getArenaDef(trackId) : getTrackDef(trackId);
    return { el: html(`<section class="screen loading"><div class="loading-card"><p>${game === 'battle' ? 'Preparing the arena' : 'Opening the wormhole'}</p><h2>${escapeHtml(def.name)}</h2><div class="loading-bar"><i></i></div></div></section>`) };
  }

  error({ message, fatal }) {
    const el = html(`<section class="screen error-screen"><div class="panel"><h2>Something stopped the race</h2><p>${escapeHtml(message)}</p>
      <div class="row">${fatal ? '' : '<button class="primary" data-act="menu">Back to menu</button>'}<button data-act="reload">Reload the game</button></div></div></section>`);
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'menu') this.app.backToAttract().then(() => this.show('title'));
      if (act === 'reload') location.reload();
    });
    return { el, onBack: fatal ? null : () => this.app.backToAttract().then(() => this.show('title')) };
  }

  title() {
    const app = this.app;
    const d = app.playerDesign();
    const el = html(`
      <section class="screen title">
        <div class="title-block">
          <h1 class="wordmark">Starwake</h1>
          <svg class="wake" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id="wake-grad" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="0.08" stop-color="#4feaff"/><stop offset="0.42" stop-color="#ff7a2f" stop-opacity="0.85"/><stop offset="1" stop-color="#ff7a2f" stop-opacity="0"/></linearGradient></defs>
            <path pathLength="100" d="M4 6 Q 260 40 1000 14"/>
            <path class="thin" pathLength="100" d="M40 16 Q 300 44 900 28"/>
          </svg>
          <p class="tagline">Race down glowing wormholes, or drop into an open arena and fight it out.</p>
          <nav class="menu" aria-label="Main menu">
            <button data-go="play" data-game="race" autofocus><b>Wormhole race</b><small>Fly the tunnel against AI pilots, or practise solo</small></button>
            <button data-go="play" data-game="battle"><b>Battle</b><small>Free-roam dogfight arena — first to the kill target wins</small></button>
            <button data-go="lobbyEntry"><b>Multiplayer</b><small>Host or join a race or battle lobby</small></button>
            <button data-go="hangar"><b>Hangar</b><small>Build and paint your craft</small></button>
            <button data-go="settings"><b>Settings</b><small>Sound, graphics and controls</small></button>
          </nav>
        </div>
        <footer class="title-foot">
          ${rankPill()}
          <span class="chip" style="--c:${d.colors.glow}">${escapeHtml(d.name)}</span>
          <span>flown by ${escapeHtml(app.settings.playerName)}</span>
          ${storage.persistent ? '' : '<span class="warn">Saving is unavailable in this browser mode — designs last until you close the tab.</span>'}
          ${matchMedia('(hover: none) and (pointer: coarse)').matches ? '<span class="warn">Starwake is played with a keyboard or a game controller. Connect one to race.</span>' : ''}
        </footer>
      </section>`);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-go]');
      const go = btn?.dataset.go;
      if (go === 'hangar') this.show('hangar');
      else if (go === 'play') this.show('play', { game: btn.dataset.game });
      else if (go) this.show(go);
    });
    return { el };
  }

  play({ game = 'race' } = {}) {
    const app = this.app;
    const s = app.settings;
    const battle = game === 'battle';
    const records = storage.records();
    const designs = storage.allDesigns();
    const sel = storage.getSelectedId();
    const list = battle ? ARENAS : TRACKS;
    const curId = battle ? s.arenaId : s.trackId;
    const rows = list.map((t) => {
      const r = records[t.id] || {};
      const foot = battle ? `${Math.round(t.radius * 2 / 100) / 10} km across` : r.lap ? `Best lap ${formatTime(r.lap)}` : 'No laps recorded yet';
      return `<button class="track-choice choice ${t.id === curId ? 'is-on' : ''}" data-track="${t.id}" style="--edge:${t.theme.accent}" aria-pressed="${t.id === curId}">
        <span class="track-name">${escapeHtml(t.name)}</span>
        <span class="track-diff" data-d="${t.difficulty}">${t.difficulty}</span>
        <span class="track-blurb">${escapeHtml(t.blurb)}</span>
        <span class="track-best">${foot}</span>
        ${battle ? '' : courseMedal(t.id)}
      </button>`;
    }).join('');
    const seg = (key, values, cur, label = (v) => String(v)) => `<div class="seg" data-k="${key}">${values.map((v) => `<button data-v="${v}" class="${cur === v ? 'is-on' : ''}">${label(v)}</button>`).join('')}</div>`;
    const assistLevels = [0, 0.4, 0.7, 1];
    const assistCur = assistLevels.reduce((b, v) => (Math.abs(v - (s.trackAssist ?? 0.7)) < Math.abs(b - (s.trackAssist ?? 0.7)) ? v : b), 0.7);
    const opts = battle ? `
            <div class="field"><span>Format</span>${seg('battleTeams', [0, 1], s.battleTeams ? 1 : 0, (v) => (v ? 'Teams' : 'Free-for-all'))}</div>
            <div class="field"><span>Bots</span>${seg('battleBots', [1, 3, 5, 7], s.battleBots)}</div>
            <div class="field"><span>Skill</span>${seg('difficulty', ['easy', 'normal', 'hard'], s.difficulty, cap)}</div>
            <div class="field"><span>Kills to win</span>${seg('battleTarget', [5, 10, 15, 25], s.battleTarget)}</div>
            <div class="field"><span>Time limit</span>${seg('battleTime', [180, 300, 480, 600], s.battleTime, (v) => `${v / 60} min`)}</div>
            <div class="field"><span>Hazards</span>${seg('hazards', [0, 0.3, 0.6, 1], [0, 0.3, 0.6, 1].includes(s.hazards) ? s.hazards : 0.6, (v) => ({ 0: 'Off', 0.3: 'Light', 0.6: 'Normal', 1: 'Heavy' })[v])}</div>` : `
            <div class="field"><span>Opponents</span>${seg('aiCount', [0, 1, 3, 5, 7], s.aiCount, (n) => (n === 0 ? 'Time trial' : String(n)))}</div>
            <div class="field"><span>Skill</span>${seg('difficulty', ['easy', 'normal', 'hard'], s.difficulty, cap)}</div>
            <div class="field-pair">
              <div class="field"><span>Laps</span>${seg('laps', [1, 2, 3, 5], s.laps)}</div>
              <div class="field"><span>Ghost</span>${seg('ghost', [1, 0], s.ghost ? 1 : 0, (v) => (v ? 'On' : 'Off'))}</div>
            </div>
            <div class="field"><span>Hazards</span>${seg('hazards', [0, 0.3, 0.6, 1], [0, 0.3, 0.6, 1].includes(s.hazards) ? s.hazards : 0.6, (v) => ({ 0: 'Off', 0.3: 'Light', 0.6: 'Normal', 1: 'Heavy' })[v])}</div>
            <div class="field"><span>Track assist</span>${seg('trackAssist', assistLevels, assistCur, (v) => ({ 0: 'Off', 0.4: 'Light', 0.7: 'Normal', 1: 'Strong' })[v])}</div>`;
    const el = html(`
      <section class="screen setup">
        <header class="screen-head"><button class="back" data-act="back" data-sound="back">Back</button><h2>${battle ? 'Battle setup' : 'Race setup'}</h2></header>
        <div class="setup-grid">
          <div class="track-list" role="group" aria-label="${battle ? 'Arena' : 'Course'}">${rows}</div>
          <div class="panel setup-opts">
            <label class="field"><span>Craft</span>
              <select data-k="design">${designs.map((d) => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${escapeHtml(d.name)} — ${BODIES[d.body].label}</option>`).join('')}</select>
            </label>
            ${opts}
            ${battle ? '' : '<div class="medal-targets" data-k="medals"></div>'}
            <p class="note" data-k="note"></p>
            <button class="primary big" data-act="start">${battle ? 'Start battle' : 'Start race'}</button>
          </div>
        </div>
      </section>`);
    const note = $('[data-k=note]', el);
    const updateNote = () => {
      if (battle) {
        note.textContent = s.battleTeams
          ? `Blue crew (you) against Red crew, ${s.battleBots} bot${s.battleBots > 1 ? 's' : ''} on ${s.difficulty} skill split between the teams. First team to ${s.battleTarget} kills wins, or the higher score after ${s.battleTime / 60} minutes. No friendly fire.`
          : `${s.battleBots} bot${s.battleBots > 1 ? 's' : ''} on ${s.difficulty} skill. First to ${s.battleTarget} kills, or the most kills after ${s.battleTime / 60} minutes. Break rocks and cargo for missiles, shields and boost.`;
        return;
      }
      const assist = (s.trackAssist ?? 0.7) <= 0 ? 'Track assist is off.' : 'Centre the mouse and the ship follows the tunnel by itself.';
      const hz = s.hazards > 0 ? ' Watch for drifting plasmoids and Vesk ambushes.' : '';
      $('[data-k=medals]', el).innerHTML = targetsPanel(getTrackDef(s.trackId), s.laps);
      const ghost = s.ghost && storage.loadGhost(s.trackId, s.laps) ? ' Your best run here races as a ghost.' : '';
      note.textContent = (s.aiCount === 0 ? 'Time trial: just you and the clock. Beat the medal times. ' : `${s.aiCount} AI pilot${s.aiCount > 1 ? 's' : ''} on ${s.difficulty} skill. `) + assist + ' Fly through the amber gates for extra boost.' + hz + ghost;
    };
    updateNote();
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-track]');
      if (t) {
        app.saveSettings({ [battle ? 'arenaId' : 'trackId']: t.dataset.track });
        $$('[data-track]', el).forEach((b) => { b.classList.toggle('is-on', b === t); b.setAttribute('aria-pressed', b === t); });
        updateNote();
      }
      const segBtn = e.target.closest('.seg button');
      if (segBtn) {
        const key = segBtn.parentElement.dataset.k;
        const v = segBtn.dataset.v;
        app.saveSettings({ [key]: isNaN(Number(v)) ? v : Number(v) });
        $$('button', segBtn.parentElement).forEach((b) => b.classList.toggle('is-on', b === segBtn));
        updateNote();
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') this.show('title');
      if (act === 'start') { if (battle) app.startSoloBattle(); else app.startSoloRace(); }
    });
    $('[data-k=design]', el).addEventListener('change', (e) => storage.setSelectedId(e.target.value));
    return { el, onBack: () => this.show('title') };
  }

  settings({ from = 'title' } = {}) {
    const app = this.app;
    const s = app.settings;
    const el = html(`
      <section class="screen settings">
        <header class="screen-head"><button class="back" data-act="back" data-sound="back">Back</button><h2>Settings</h2></header>
        <div class="settings-grid">
          <div class="panel">
            <h3>Pilot</h3>
            <label class="field"><span>Name</span><input data-k="playerName" maxlength="16" value="${escapeHtml(s.playerName)}" autocomplete="off" spellcheck="false"></label>
            <h3>Sound</h3>
            ${slider('masterVol', 'Master', s.masterVol)}
            ${slider('sfxVol', 'Effects', s.sfxVol)}
            ${slider('musicVol', 'Music', s.musicVol)}
          </div>
          <div class="panel">
            <h3>Graphics</h3>
            <div class="field"><span>Quality</span><div class="seg" data-k="quality">${['low', 'medium', 'high'].map((q) => `<button data-v="${q}" class="${s.quality === q ? 'is-on' : ''}">${q[0].toUpperCase() + q.slice(1)}</button>`).join('')}</div></div>
            <label class="field"><span>Field of view <output data-o="fov">${s.fov}°</output></span><input type="range" min="60" max="90" step="1" data-k="fov" value="${s.fov}"></label>
            <label class="check"><input type="checkbox" data-k="reduceMotion" ${s.reduceMotion ? 'checked' : ''}><span>Reduce motion <small>Calmer camera, no speed streaks or shake</small></span></label>
            <div class="field"><span>Speed effects</span><div class="seg" data-k="speedEffects">${[['full', 'Full'], ['reduced', 'Reduced'], ['off', 'Off']].map(([v, l]) => `<button data-v="${v}" class="${(s.speedEffects || 'full') === v ? 'is-on' : ''}">${l}</button>`).join('')}</div><small class="field-note">Speed streaks, radial blur, camera shake and FOV kick. Reduce motion caps this at Reduced.</small></div>
            <label class="check"><input type="checkbox" data-k="showFps" ${s.showFps ? 'checked' : ''}><span>Show frame rate</span></label>
            <h3>Assists</h3>
            ${assistSeg('aimAssist', 'Aim assist', s.aimAssist ?? 1, 'Lasers snap onto rivals near the reticle, and missiles lock on automatically.')}
            ${assistSeg('flightAssist', 'Flight assist', s.flightAssist ?? 0.7, 'Steers you round rocks and mines, keeps your wings level, and eases you onto your target in a dogfight.')}
            ${assistSeg('trackAssist', 'Track assist', s.trackAssist ?? 0.7, 'In races, centre the mouse and the ship follows the tunnel.')}
            <h3>Mouse</h3>
            <label class="field"><span>Sensitivity <output data-o="mouseSens">${Math.round((s.mouseSens ?? 1) * 100)}%</output></span><input type="range" min="30" max="250" step="10" data-k="mouseSens" value="${Math.round((s.mouseSens ?? 1) * 100)}"></label>
            <label class="check"><input type="checkbox" data-k="invertY" ${s.invertY ? 'checked' : ''}><span>Invert up and down</span></label>
            <label class="check"><input type="checkbox" data-k="lockMouse" ${s.lockMouse !== false ? 'checked' : ''}><span>Capture the mouse in races <small>Keeps the cursor inside the game. Press Esc to release it.</small></span></label>
            <h3>Controller</h3>
            <label class="check"><input type="checkbox" data-k="rumble" ${s.rumble !== false ? 'checked' : ''}><span>Controller rumble</span></label>
          </div>
          <div class="panel controls-ref">
            <h3>Controls</h3>
            <table>
              <thead><tr><th></th><th>Keyboard</th><th>Controller</th></tr></thead>
              <tbody>
                <tr><td>Steer</td><td>Mouse (or arrow keys)</td><td>Left stick</td></tr>
                <tr><td>Thrust</td><td>W</td><td>RT</td></tr>
                <tr><td>Brake / reverse</td><td>S</td><td>LT</td></tr>
                <tr><td>Roll</td><td>A D (or Q E)</td><td>Right stick</td></tr>
                <tr><td>Fire lasers</td><td>Left click (or F)</td><td>RB</td></tr>
                <tr><td>Fire missile</td><td>Right click (or G)</td><td>LB</td></tr>
                <tr><td>Boost</td><td>Space or Shift</td><td>A</td></tr>
                <tr><td>Back on track (race)</td><td>R</td><td>Y</td></tr>
                <tr><td>Switch camera</td><td>C</td><td>Back</td></tr>
                <tr><td>Pause</td><td>Esc or P</td><td>Start</td></tr>
              </tbody>
            </table>
            <p class="note">Your ship turns toward the cursor — the further from the centre, the harder it turns. In races, centre the cursor and track assist flies you down the tunnel. Point roughly at a rival and the lock builds by itself; when the ring closes, fire a missile. Lasers overheat if you hold the trigger too long. Boost gates and pickups refill boost.</p>
          </div>
        </div>
      </section>`);
    el.addEventListener('input', (e) => {
      const k = e.target.dataset.k; if (!k) return;
      if (e.target.type === 'range') {
        const v = Number(e.target.value);
        app.saveSettings({ [k]: k === 'fov' ? v : v / 100 });
        const o = $(`[data-o=${k}]`, el); if (o) o.textContent = k === 'fov' ? `${v}°` : `${Math.round(v)}%`;
        if (k === 'mouseSens') return;
        if (k === 'sfxVol' || k === 'masterVol') app.audio.play('gate');
      }
    });
    el.addEventListener('change', (e) => {
      const k = e.target.dataset.k; if (!k) return;
      if (e.target.type === 'checkbox') app.saveSettings({ [k]: e.target.checked });
      if (k === 'reduceMotion') this.syncMotion();
      if (k === 'playerName') app.saveSettings({ playerName: e.target.value.trim().slice(0, 16) || 'Pilot' });
    });
    el.addEventListener('click', (e) => {
      const segBtn = e.target.closest('.seg button');
      if (segBtn) {
        const v = segBtn.dataset.v;
        app.saveSettings({ [segBtn.parentElement.dataset.k]: isNaN(Number(v)) ? v : Number(v) });
        $$('button', segBtn.parentElement).forEach((b) => b.classList.toggle('is-on', b === segBtn));
      }
      if (e.target.closest('[data-act=back]')) back();
    });
    const back = () => {
      const name = $('[data-k=playerName]', el).value.trim().slice(0, 16) || 'Pilot';
      app.saveSettings({ playerName: name });
      this.show(from);
    };
    return { el, onBack: back };
  }

  hangar() {
    const view = new HangarScreen(this.app, () => this.show('title'));
    return view;
  }

  race() {
    return { el: html('<section class="screen race-screen" aria-live="polite"></section>') };
  }

  pause() {
    const app = this.app;
    const multi = app.race?.mode === 'multi';
    const s = app.settings;
    const el = html(`
      <section class="screen pause">
        <div class="panel pause-card">
          <h2>${multi ? 'Match menu' : 'Paused'}</h2>
          ${multi ? '<p class="note">The match keeps running in multiplayer — your craft is coasting.</p>' : ''}
          <nav class="menu compact">
            <button data-act="resume" autofocus>Resume</button>
            ${multi ? '' : `<button data-act="restart">Restart ${app.race?.battle ? 'battle' : 'race'}</button>`}
            <button data-act="camera">Camera: ${app.race?.cameraMode === 'hood' ? 'cockpit' : 'chase'}</button>
            <button data-act="quit" data-sound="back">${multi ? 'Leave match' : 'Quit to menu'}</button>
          </nav>
          ${slider('masterVol', 'Master volume', s.masterVol)}
          ${slider('musicVol', 'Music', s.musicVol)}
        </div>
      </section>`);
    el.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (k) { app.saveSettings({ [k]: Number(e.target.value) / 100 }); $(`[data-o=${k}]`, el).textContent = `${e.target.value}%`; }
    });
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'resume') app.pause(false);
      if (act === 'restart') { app.pause(false); app.restartSolo(); }
      if (act === 'camera') { const m = app.race.toggleCamera(); app.saveSettings({ cameraMode: m }); e.target.textContent = `Camera: ${m === 'hood' ? 'cockpit' : 'chase'}`; }
      if (act === 'quit') {
        if (multi) { this.leaveNet(); }
        app.backToAttract().then(() => this.show(multi ? 'lobbyEntry' : 'title'));
      }
    });
    return { el, onBack: () => app.pause(false) };
  }

  results({ results, rank, records, mode, trackName, game, teams, career }) {
    const app = this.app;
    const me = app.race?.player?.id;
    const battle = game === 'battle';
    const winnerTime = results[0]?.time;
    const rows = results.map((r, i) => `
      <tr class="${r.id === me ? 'me' : ''}">
        <td class="pos">${i + 1}</td>
        <td><span class="swatch" style="--c:${r.team != null ? ['#4da3ff', '#ff4d5e'][r.team] : r.design?.colors?.glow || '#fff'}"></span>${escapeHtml(r.name)}${r.kind === 'ai' ? ' <small>AI</small>' : ''}</td>
        <td>${escapeHtml(r.design?.name || '')}</td>
        ${battle
          ? `<td class="num">${r.kills ?? 0}</td><td class="num">${r.deaths ?? 0}</td>`
          : `<td class="num">${r.dnf ? 'Did not finish' : i === 0 ? formatTime(r.time) : '+' + (r.time - winnerTime).toFixed(3)}</td>
        <td class="num">${r.bestLap ? formatTime(r.bestLap) : '--'}</td>
        <td class="num">${r.kills ?? 0}</td>`}
      </tr>`).join('');
    const myTeam = results.find((r) => r.id === me)?.team;
    const teamLine = teams ? (teams[0] === teams[1] ? `Draw ${teams[0]}–${teams[1]}` : `${teams[0] > teams[1] ? 'Blue' : 'Red'} crew wins ${Math.max(...teams)}–${Math.min(...teams)}`) : '';
    const headline = teams && myTeam != null
      ? (teams[0] === teams[1] ? 'A draw' : (teams[0] > teams[1]) === (myTeam === 0) ? 'Your crew won' : 'Your crew lost')
      : rank == null ? (battle ? 'Battle over' : 'Race complete') : rank === 1 ? (battle ? 'You won the battle' : 'You won') : `You ${battle ? 'placed' : 'finished'} ${ordinal(rank)}`;
    const badges = [records.raceBest && 'New best race time', records.lapBest && 'New best lap'].filter(Boolean);
    const head = battle
      ? '<th>#</th><th>Pilot</th><th>Craft</th><th class="num">Kills</th><th class="num">Deaths</th>'
      : '<th>#</th><th>Pilot</th><th>Craft</th><th class="num">Time</th><th class="num">Best lap</th><th class="num">Kills</th>';
    const isHost = app.net?.isHost;
    const el = html(`
      <section class="screen results">
        <div class="panel results-card">
          <p class="results-track">${escapeHtml(trackName)}</p>
          <h2 class="${(teams ? headline === 'Your crew won' : rank === 1) ? 'win' : ''}">${headline}</h2>
          ${teamLine ? `<p class="team-line">${teamLine}</p>` : ''}
          ${badges.length ? `<p class="badges">${badges.map((b) => `<span>${b}</span>`).join('')}</p>` : ''}
          ${resultsPanel(career)}
          <table class="standings">
            <thead><tr>${head}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="row">
            ${mode === 'multi'
              ? (isHost ? '<button class="primary" data-act="lobby" autofocus>Back to lobby</button>' : '<p class="note waiting">Waiting for the host to return to the lobby…</p>') + '<button data-act="leave" data-sound="back">Leave</button>'
              : `<button class="primary" data-act="again" autofocus>${battle ? 'Fight again' : 'Race again'}</button><button data-act="hangar">Hangar</button><button data-act="menu" data-sound="back">Main menu</button>`}
            ${app.race?.replays?.hasHighlights ? '<button data-act="highlights">Watch highlights</button>' : ''}
          </div>
        </div>
      </section>`);
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'again') app.restartSolo();
      if (act === 'highlights') app.watchHighlights();
      if (act === 'hangar') app.backToAttract().then(() => this.show('hangar'));
      if (act === 'menu') app.backToAttract().then(() => this.show('title'));
      if (act === 'lobby') { app.net.backToLobby(); app.backToAttract().then(() => this.show('lobby')); }
      if (act === 'leave') { this.leaveNet(); app.backToAttract().then(() => this.show('lobbyEntry')); }
    });
    return { el, onBack: mode === 'multi' ? null : () => app.backToAttract().then(() => this.show('title')) };
  }

  // ================================================================ multiplayer
  /** Which relay "Online" would use right now: { url, source } (url null = not set up here). */
  onlineRelay(setting = this.app.settings.relayUrl) {
    return resolveRelayUrl({ setting, search: location.search, location, served: servedByRelay() });
  }

  /**
   * @param {{error?: string, code?: string, invite?: {code: string, kind: 'tabs'|'relay'}}} props
   * `invite` comes from an ?join=CODE link: join that room straight away (after a name).
   */
  lobbyEntry({ error, code: prefill = '', invite = null } = {}) {
    const app = this.app;
    const s = app.settings;
    const kind0 = invite ? invite.kind : s.netKind === 'relay' ? 'relay' : 'tabs';
    const el = html(`
      <section class="screen lobby-entry">
        <header class="screen-head"><button class="back" data-act="back" data-sound="back">Back</button><h2>Multiplayer</h2></header>
        <div class="entry-grid">
          <div class="panel">
            <label class="field"><span>Pilot name</span><input data-k="name" maxlength="16" value="${escapeHtml(s.playerName)}" autocomplete="off" spellcheck="false"></label>
            <fieldset class="field net-kind">
              <legend>Connection</legend>
              <label class="radio"><input type="radio" name="kind" value="tabs" ${kind0 === 'tabs' ? 'checked' : ''}><span><b>This browser</b><small>Race between Starwake tabs or windows on this computer. No server needed.</small></span></label>
              <label class="radio"><input type="radio" name="kind" value="relay" ${kind0 === 'relay' ? 'checked' : ''}><span><b>Online</b><small data-k="onlineNote"></small></span></label>
              <label class="field relay-url" data-k="relayField"><span>Server <small>(optional)</small></span><input data-k="relay" value="${escapeHtml(s.relayUrl || '')}" spellcheck="false" autocomplete="off" aria-label="Online server address"></label>
            </fieldset>
          </div>
          <div class="panel">
            <h3>Host</h3>
            <p class="note">Create a lobby, pick a race or a battle, and invite others with the room code.</p>
            <button class="primary" data-act="host" ${invite ? '' : 'autofocus'}>Host a lobby</button>
            <h3>Join</h3>
            <div class="join-row"><input data-k="code" maxlength="4" placeholder="Code" aria-label="Room code" autocomplete="off" spellcheck="false" value="${escapeHtml(invite?.code || prefill || '')}"><button data-act="join">Join</button></div>
            <p class="status" data-k="status" role="status">${error ? escapeHtml(error) : ''}</p>
          </div>
        </div>
      </section>`);
    const status = $('[data-k=status]', el);
    if (error) status.dataset.tone = 'bad';
    const relayInput = $('[data-k=relay]', el);
    const nameInput = $('[data-k=name]', el);
    const kindNow = () => $('input[name=kind]:checked', el).value;
    const syncOnline = () => {
      const typed = relayInput.value.trim();
      const r = this.onlineRelay(typed);
      const auto = this.onlineRelay('');
      relayInput.placeholder = auto.url || 'wss://relay.example.com/relay';
      $('[data-k=onlineNote]', el).textContent = !r.url
        ? "Online play isn't set up on this site."
        : r.source === 'local'
          ? 'Race other computers through a relay server. Run one with npm start.'
          : 'Race friends anywhere. Share the room code or an invite link.';
      if (kindNow() === 'relay' && r.url && !isLocalRelayUrl(r.url) && r.source !== 'same-origin') warmRelay(r.url);
      return r;
    };
    const syncKind = () => {
      const kind = kindNow();
      $('[data-k=relayField]', el).hidden = kind !== 'relay';
      app.saveSettings({ netKind: kind });
      syncOnline();
    };
    syncKind();
    el.addEventListener('change', (e) => { if (e.target.name === 'kind') syncKind(); });
    relayInput.addEventListener('change', syncOnline);
    const codeInput = $('[data-k=code]', el);
    codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('join'); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && invite) go('join'); });
    const bad = (text) => { status.textContent = text; status.dataset.tone = 'bad'; app.audio.play('error'); };
    let busy = false;
    const go = async (act) => {
      if (busy) return;
      const name = nameInput.value.trim().slice(0, 16) || 'Pilot';
      const typed = relayInput.value.trim();
      app.saveSettings({ playerName: name, relayUrl: typed });
      const code = codeInput.value.trim();
      if (act === 'join' && code.length !== 4) return bad('Enter the 4-letter room code from the host.');
      if (kindNow() === 'relay') {
        if (typed && !normalizeRelayUrl(typed)) return bad("That server address doesn't look right. It should look like wss://relay.example.com/relay.");
        if (!syncOnline().url) return bad("Online play isn't set up on this site. Use This browser, or enter a server address.");
      }
      busy = true;
      status.dataset.tone = '';
      status.textContent = act === 'host' ? 'Opening a lobby…' : `Looking for room ${code}…`;
      $$('button:not([data-act=back])', el).forEach((b) => (b.disabled = true));
      // A relay on a free host can be asleep; say so instead of looking stuck.
      const slow = setTimeout(() => { status.textContent = 'Waking up the online server. This can take up to a minute.'; }, 5000);
      try {
        await this.openNet(act, code);
        clearTimeout(slow);
        busy = false;
        if (this.current?.el !== el) return; // left this screen while connecting
        app.audio.play('join');
        this.show('lobby');
      } catch (err) {
        clearTimeout(slow);
        busy = false;
        this.leaveNet();
        if (this.current?.el !== el) return;
        bad(err.message || String(err));
        $$('button', el).forEach((b) => (b.disabled = false));
      }
    };
    const back = () => { this.leaveNet(); this.show('title'); };
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') back();
      if (act === 'host' || act === 'join') go(act);
    });
    if (invite) {
      // Invite link: join right away if we already know who this is, else ask for a name first.
      const named = s.playerName && s.playerName !== DEFAULT_SETTINGS.playerName;
      if (named) queueMicrotask(() => go('join'));
      else {
        status.textContent = `You're invited to room ${invite.code}. Enter your pilot name, then press Join.`;
        queueMicrotask(() => { nameInput.focus({ preventScroll: true }); nameInput.select(); });
      }
    }
    return { el, onBack: back };
  }

  async openNet(act, code) {
    const app = this.app;
    const { NetSession } = await import('../net/session.js');
    const s = app.settings;
    const kind = s.netKind === 'relay' ? 'relay' : 'tabs';
    const relay = kind === 'relay' ? this.onlineRelay() : { url: null, source: null };
    const net = new NetSession({
      kind,
      relayUrl: relay.url || undefined,
      name: s.playerName,
      design: app.playerDesign(),
    });
    net.relaySource = relay.source;
    this.bindNet(net);
    app.net = net;
    if (act === 'host') await net.host({ trackId: s.trackId, laps: s.laps, aiFill: Math.min(4, s.aiCount), game: 'race', target: s.battleTarget, timeLimit: s.battleTime, hazards: s.hazards ?? 0.6 });
    else await net.join(code);
  }

  bindNet(net) {
    const app = this.app;
    net.addEventListener('start', (e) => {
      app.audio.play('go');
      app.startNetRace(e.detail);
    });
    net.addEventListener('lobby', (e) => {
      const lobby = e.detail;
      if (this.currentName === 'lobby') this.current.refresh?.(lobby);
      // Host went back to the lobby while we sit on the results screen.
      if (lobby.phase === 'lobby' && app.race?.mode === 'multi' && app.race.results && !net.isHost) {
        app.backToAttract().then(() => this.show('lobby'));
      }
    });
    net.addEventListener('ping', () => { if (this.currentName === 'lobby' && app.net === net) this.current.refresh?.(); });
    net.addEventListener('peer-left', (e) => { app.toast(`${e.detail.name || 'A pilot'} left`); app.audio.play('leave'); });
    net.addEventListener('closed', (e) => {
      if (app.net !== net) return;
      app.net = null;
      const reason = e.detail.reason || 'Disconnected.';
      app.toast(reason, 'error');
      app.audio.play('error');
      // Back to the menu from anywhere (lobby, loading, race, results). A client keeps the
      // room code filled in, so trying again is one press of Join.
      const code = net.isHost || /host left/i.test(reason) ? '' : net.code || '';
      app.backToAttract().then(() => this.show('lobbyEntry', { error: code ? `${reason} Press Join to try again.` : reason, code }));
    });
    net.addEventListener('error', (e) => app.toast(e.detail.message, 'error'));
  }

  leaveNet() {
    const net = this.app.net;
    this.app.net = null;
    try { net?.leave(); } catch { /* ignore */ }
  }

  lobby() {
    const app = this.app;
    const net = app.net;
    if (!net) return this.lobbyEntry({ error: 'Not connected.' });
    const el = html(`
      <section class="screen lobby">
        <header class="screen-head"><button class="back" data-act="leave" data-sound="back">Leave</button><h2>Lobby</h2></header>
        <div class="lobby-grid">
          <div class="panel lobby-code">
            <span>Room code</span>
            <strong data-k="code"></strong>
            <div class="row lobby-copy"><button data-act="copy">Copy code</button><button data-act="invite">Copy invite link</button></div>
            <input class="invite-url" data-k="inviteUrl" readonly hidden aria-label="Invite link">
            <p class="note" data-k="how"></p>
            <p class="note net-quality" data-k="quality" hidden></p>
          </div>
          <div class="panel lobby-players">
            <h3>Pilots <small data-k="count"></small></h3>
            <ul data-k="players"></ul>
          </div>
          <div class="panel lobby-settings">
            <h3 data-k="setHead">Match</h3>
            <div data-k="settings"></div>
            <div class="row lobby-actions">
              <button data-act="ready" data-k="readyBtn"></button>
              <button class="primary" data-act="start" data-k="startBtn">Start race</button>
            </div>
            <p class="note" data-k="startNote"></p>
          </div>
        </div>
      </section>`);
    const k = (name) => $(`[data-k=${name}]`, el);
    k('how').textContent = net.kind === 'relay'
      ? 'Send friends the invite link, or have them choose Multiplayer, then Online, and join with this code.'
      : 'Open Starwake in another tab or window of this browser, choose Multiplayer → Join and enter this code.';
    const online = net.kind === 'relay';
    const pingText = (ms) => (ms == null ? '' : `${ms} ms`);
    const quality = () => {
      if (!online) return;
      const mine = net.isHost ? net.transport.rtt : net.pings[net.selfId];
      k('quality').hidden = mine == null;
      k('quality').textContent = mine == null ? '' : `Connection: ${mine} ms to ${net.isHost ? 'the server' : 'the host'}${mine > 250 ? ', expect some lag' : ''}`;
    };
    const qualityTimer = online ? setInterval(quality, 2000) : null;
    const refresh = (lobby = net.lobby) => {
      if (!lobby) return;
      quality();
      k('code').textContent = lobby.code;
      k('count').textContent = `${lobby.players.length} of 8`;
      const active = document.activeElement?.dataset?.act || document.activeElement?.dataset?.k;
      k('players').innerHTML = lobby.players.map((p) => {
        const d = normalizeDesign(p.design);
        return `<li style="--c:${d.colors.glow}">
          <span class="swatch"></span>
          <span class="pname">${escapeHtml(p.name)}${p.id === net.selfId ? ' <small>you</small>' : ''}</span>
          <span class="pcraft">${escapeHtml(d.name)} · ${BODIES[d.body].label}${online && !p.isHost && net.pings[p.id] != null ? ` · <span class="pping">${pingText(net.pings[p.id])}</span>` : ''}</span>
          <span class="pstate ${p.isHost ? 'host' : p.ready ? 'ready' : ''}">${p.isHost ? 'Host' : p.ready ? 'Ready' : 'Not ready'}</span>
        </li>`;
      }).join('') + (lobby.aiFill ? `<li class="ai-fill"><span class="swatch"></span><span class="pname">${lobby.aiFill} AI pilot${lobby.aiFill > 1 ? 's' : ''}</span><span class="pcraft">fill the grid</span><span class="pstate">AI</span></li>` : '');
      const battle = lobby.game === 'battle';
      const place = battle ? getArenaDef(lobby.trackId) : getTrackDef(lobby.trackId);
      k('setHead').textContent = battle ? 'Battle' : 'Race';
      k('startBtn').textContent = battle ? 'Start battle' : 'Start race';
      if (net.isHost) {
        const sig = battle ? 'battle' : 'race';
        if (k('settings').dataset.sig !== sig) {
          k('settings').dataset.sig = sig;
          const opt = (vals, lab = (v) => v) => vals.map((v) => `<option value="${v}">${lab(v)}</option>`).join('');
          k('settings').innerHTML = `
            <label class="field"><span>Mode</span><select data-s="game"><option value="race">Wormhole race</option><option value="battle">Battle</option></select></label>
            ${battle
              ? `<label class="field"><span>Arena</span><select data-s="trackId">${ARENAS.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select></label>
            <label class="field"><span>Format</span><select data-s="teams"><option value="0">Free-for-all</option><option value="1">Teams (Blue vs Red)</option></select></label>
            <label class="field"><span>Kills to win</span><select data-s="target">${opt([5, 10, 15, 25])}</select></label>
            <label class="field"><span>Time limit</span><select data-s="timeLimit">${opt([180, 300, 480, 600], (v) => `${v / 60} min`)}</select></label>`
              : `<label class="field"><span>Course</span><select data-s="trackId">${TRACKS.map((t) => `<option value="${t.id}">${escapeHtml(t.name)} (${t.difficulty})</option>`).join('')}</select></label>
            <label class="field"><span>Laps</span><select data-s="laps">${opt([1, 2, 3, 5])}</select></label>`}
            <label class="field"><span>${battle ? 'Bots' : 'AI pilots'}</span><select data-s="aiFill">${opt([0, 1, 2, 3, 4, 5, 6])}</select></label>
            <label class="field"><span>Hazards</span><select data-s="hazards"><option value="0">Off</option><option value="0.3">Light</option><option value="0.6">Normal</option><option value="1">Heavy</option></select></label>`;
        }
        $('[data-s=game]', el).value = sig;
        $('[data-s=trackId]', el).value = place.id;
        if (battle) { $('[data-s=teams]', el).value = lobby.teams ? '1' : '0'; $('[data-s=target]', el).value = String(lobby.target ?? 10); $('[data-s=timeLimit]', el).value = String(lobby.timeLimit ?? 300); }
        else $('[data-s=laps]', el).value = String(lobby.laps);
        $('[data-s=aiFill]', el).value = String(lobby.aiFill);
        $('[data-s=hazards]', el).value = String(lobby.hazards ?? 0.6);
      } else {
        k('settings').innerHTML = battle
          ? `<dl class="readonly"><dt>Mode</dt><dd>Battle${lobby.teams ? ' — teams' : ''}</dd><dt>Arena</dt><dd>${escapeHtml(place.name)}</dd><dt>Kills to win</dt><dd>${lobby.target ?? 10}</dd><dt>Time limit</dt><dd>${Math.round((lobby.timeLimit ?? 300) / 60)} min</dd><dt>Bots</dt><dd>${lobby.aiFill}</dd></dl>`
          : `<dl class="readonly"><dt>Mode</dt><dd>Wormhole race</dd><dt>Course</dt><dd>${escapeHtml(place.name)} <small>${place.difficulty}</small></dd><dt>Laps</dt><dd>${lobby.laps}</dd><dt>AI pilots</dt><dd>${lobby.aiFill}</dd></dl>`;
      }
      const me = lobby.players.find((p) => p.id === net.selfId);
      k('readyBtn').hidden = net.isHost;
      k('readyBtn').textContent = me?.ready ? 'Not ready' : 'Ready up';
      k('readyBtn').classList.toggle('is-on', !!me?.ready);
      k('startBtn').hidden = !net.isHost;
      const can = net.isHost && net.canStart();
      k('startBtn').disabled = !can;
      const waiting = lobby.players.filter((p) => !p.isHost && !p.ready).length;
      k('startNote').textContent = net.isHost
        ? (waiting ? `Waiting for ${waiting} pilot${waiting > 1 ? 's' : ''} to ready up.` : lobby.players.length === 1 ? 'You can start alone, or wait for others to join.' : 'Everyone is ready.')
        : (me?.ready ? 'Waiting for the host to start.' : 'Ready up when you are set.');
      if (active) $(`[data-act=${active}], [data-k=${active}]`, el)?.focus?.({ preventScroll: true });
    };
    el.addEventListener('change', (e) => {
      const key = e.target.dataset.s;
      if (!key || !net.isHost) return;
      if (key === 'game') {
        const g = e.target.value === 'battle' ? 'battle' : 'race';
        net.updateSettings({ game: g, trackId: g === 'battle' ? app.settings.arenaId : app.settings.trackId });
      } else if (key === 'teams') net.updateSettings({ teams: e.target.value === '1' });
      else net.updateSettings({ [key]: key === 'trackId' ? e.target.value : Number(e.target.value) });
    });
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'leave') { this.leaveNet(); this.show('lobbyEntry'); }
      if (act === 'copy') {
        navigator.clipboard?.writeText(net.lobby.code).then(() => app.toast('Room code copied'), () => app.toast(`Room code: ${net.lobby.code}`));
      }
      if (act === 'invite') {
        const link = inviteLink({ location, code: net.lobby.code, kind: net.kind, relay: net.relaySource === 'param' ? net.relayUrl : null });
        const box = k('inviteUrl');
        box.value = link;
        const showBox = () => { box.hidden = false; box.focus(); box.select(); app.toast('Copy the invite link below'); };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(() => { box.hidden = true; app.toast('Invite link copied'); }, showBox);
        else showBox();
      }
      if (act === 'ready') {
        const me = net.lobby.players.find((p) => p.id === net.selfId);
        net.setReady(!me?.ready);
        app.audio.play('ready');
      }
      if (act === 'start' && net.canStart()) this.hostStart();
    });
    // Keep our profile current (craft may have changed in the hangar).
    net.updateProfile({ name: app.settings.playerName, design: app.playerDesign() });
    refresh();
    return { el, refresh, onBack: () => { this.leaveNet(); this.show('lobbyEntry'); }, unmount: () => clearInterval(qualityTimer) };
  }

  hostStart() {
    const app = this.app;
    const net = app.net;
    const lobby = net.lobby;
    const seed = (Math.random() * 1e9) | 0;
    const rng = mulberry32(seed);
    const names = ['Vex', 'Nova', 'Kestrel', 'Rook', 'Aurora', 'Juno', 'Talon', 'Mira'].sort(() => rng() - 0.5);
    const roster = [];
    const humans = lobby.players.map((p, i) => ({ id: p.id, name: p.name, design: normalizeDesign(p.design), ai: false, team: i % 2 }));
    const count = [0, 0];
    for (const h of humans) count[h.team]++;
    for (let i = 0; i < Math.min(lobby.aiFill, 8 - lobby.players.length); i++) {
      // AI fill evens the teams out.
      const team = count[0] <= count[1] ? 0 : 1;
      count[team]++;
      roster.push({ id: 'ai-' + i, name: names[i], design: randomDesign(rng, names[i]), ai: true, team });
    }
    roster.push(...humans);
    net.startRace({ seed, roster, countdownMs: 6500 });
  }
}

/** Off / Light / Normal / Strong buttons for an assist strength (0..1). */
function assistSeg(key, label, cur, note) {
  const levels = [0, 0.4, 0.7, 1];
  const names = { 0: 'Off', 0.4: 'Light', 0.7: 'Normal', 1: 'Strong' };
  const near = levels.reduce((b, v) => (Math.abs(v - cur) < Math.abs(b - cur) ? v : b), 0.7);
  return `<div class="field"><span>${label}</span><div class="seg" data-k="${key}">${levels.map((v) => `<button data-v="${v}" class="${v === near ? 'is-on' : ''}">${names[v]}</button>`).join('')}</div><small class="field-note">${note}</small></div>`;
}

function cap(v) { return v[0].toUpperCase() + v.slice(1); }

function slider(key, label, value) {
  const v = Math.round(value * 100);
  return `<label class="field"><span>${label} <output data-o="${key}">${v}%</output></span><input type="range" min="0" max="100" step="5" data-k="${key}" value="${v}"></label>`;
}

export { html };
