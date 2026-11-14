// Touch controls for racing on phones and tablets.
//
//   Left thumb  - a floating stick: touch anywhere on the left of the screen and drag.
//                 Let go and track assist flies the tunnel for you.
//   Right thumb - Boost, Drift (hold in a turn, let go for the kick), Fire, Missile, Dodge.
//   Top         - Pause, Camera, Tilt (steer by turning the phone like a wheel).
//
// Throttle is automatic. The controls feed Input like any other device (input.attachTouch),
// so the race sees the same { throttle, brake, boost, aimX, aimY, fire, missile } it always
// does. Only shown in a race, on a touch screen, and never in battle (that needs a mouse,
// keyboard or controller for now).

const STICK_DEAD = 0.08;
const STICK_CURVE = 1.2;
const TILT_RANGE = 0.42;    // radians of wheel turn (about 24 degrees) for full steer
const TILT_MIN_G = 3;       // m/s^2 of gravity in the screen plane needed (phone not lying flat)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** A phone or tablet: no hover, a coarse pointer. Desktops with touch screens keep the mouse. */
export function isTouchDevice() {
  try { return typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches; } catch { return false; }
}

export class TouchControls {
  /** app: needs .input, .settings, .saveSettings(patch), .toast?(msg). */
  constructor(app) {
    this.app = app;
    this.input = app.input;
    this.enabled = isTouchDevice();
    // What Input reads each poll.
    this.state = { active: false, used: false, aimX: 0, aimY: 0, throttle: 0, brake: 0, boost: false, fire: false, missile: false };
    this._stick = null;          // { id, ox, oy, x, y }
    this._held = new Map();      // pointerId -> action
    this._tilt = { on: !!app.settings.tiltSteer, x: 0, ref: null, ok: false, listening: false };
    this._onMotion = this._onMotion.bind(this);
    this._onOrient = () => { this._tilt.ref = null; };
    if (!this.enabled) return;
    this._build();
    this.input.attachTouch(this.state);
    // Fullscreen + landscape when a race is started by a tap (needs the tap's user activation).
    this._onStartTap = (e) => {
      if (!e.target.closest?.('[data-act="start"], [data-act="restart"], [data-act="again"], [data-act="next"]')) return;
      this.goFullscreen();
      if (this._tilt.on) this._askMotion();
    };
    document.addEventListener('click', this._onStartTap, true);
    window.addEventListener('orientationchange', this._onOrient);
    screen.orientation?.addEventListener?.('change', this._onOrient);
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'touch';
    el.hidden = true;
    el.innerHTML = `
      <div class="t-zone" data-zone></div>
      <div class="t-stick" data-stick hidden><div class="t-knob" data-knob></div></div>
      <div class="t-hint" data-hint>Drag here to steer · let go and the ship follows the tunnel</div>
      <div class="t-top">
        <div class="t-btn t-small" data-t="pause" aria-label="Pause">II</div>
        <div class="t-btn t-small" data-t="camera" aria-label="Camera">Cam</div>
        <div class="t-btn t-small" data-t="tilt" aria-label="Tilt steering">Tilt</div>
      </div>
      <div class="t-pad">
        <div class="t-btn" data-t="missile">Missile</div>
        <div class="t-btn" data-t="fire">Fire</div>
        <div class="t-btn" data-t="dodge">Dodge</div>
        <div class="t-btn t-big t-drift" data-t="drift">Drift</div>
        <div class="t-btn t-big t-boost" data-t="boost">Boost</div>
      </div>
      <div class="t-rotate"><div>Turn your phone sideways to race</div></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.stickEl = el.querySelector('[data-stick]');
    this.knobEl = el.querySelector('[data-knob]');
    this.hintEl = el.querySelector('[data-hint]');
    this.tiltBtn = el.querySelector('[data-t="tilt"]');
    this.tiltBtn.classList.toggle('on', this._tilt.on);

    const opts = { passive: false };
    el.querySelector('[data-zone]').addEventListener('pointerdown', (e) => this._stickDown(e), opts);
    for (const b of el.querySelectorAll('[data-t]')) b.addEventListener('pointerdown', (e) => this._btnDown(e, b.dataset.t), opts);
    el.addEventListener('pointermove', (e) => this._move(e), opts);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => this._up(e), opts);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Called by the app when a race starts or ends, or pause opens and closes. */
  setRace(on, { battle = false } = {}) {
    if (!this.enabled) return;
    const show = on && !battle;
    this.el.hidden = !show;
    this.state.active = show;
    document.documentElement.classList.toggle('touch-race', show);
    if (!show) this._releaseAll();
    else {
      this.hintEl.hidden = false;
      clearTimeout(this._hintT);
      this._hintT = setTimeout(() => { this.hintEl.hidden = true; }, 6000);
      this._tilt.ref = null;
      if (this._tilt.on) this._listenMotion();
    }
  }

  /** Per frame, before input.poll(): throttle and tilt. */
  update() {
    const s = this.state;
    if (!s.active) return;
    if (this.app.race?.results) { this.setRace(false); return; } // results screen: hand the screen back to the buttons
    s.throttle = s.brake > 0 ? 0 : 1;
    let x = this._stick ? this._stickX : 0, y = this._stick ? this._stickY : 0;
    if (this._tilt.on && this._tilt.ok) x = Math.abs(x) > Math.abs(this._tilt.x) ? x : this._tilt.x;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    s.aimX = x; s.aimY = y;
  }

  goFullscreen() {
    if (!this.enabled || document.fullscreenElement) return;
    const de = document.documentElement;
    try {
      const p = de.requestFullscreen?.({ navigationUI: 'hide' });
      p?.then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
    } catch { /* iPhone Safari has no fullscreen for pages: the rotate prompt covers it */ }
  }

  // ---------------------------------------------------------------- stick

  _stickDown(e) {
    e.preventDefault();
    if (this._stick) return;
    this._capture(e);
    this.state.used = true;
    this.input.noteTouch();
    const R = this._radius();
    // Keep the whole ring on screen.
    const ox = clamp(e.clientX, R + 8, window.innerWidth * 0.5), oy = clamp(e.clientY, R + 8, window.innerHeight - R - 8);
    this._stick = { id: e.pointerId, ox, oy };
    this._stickX = 0; this._stickY = 0;
    Object.assign(this.stickEl.style, { left: `${ox}px`, top: `${oy}px`, width: `${R * 2}px`, height: `${R * 2}px` });
    this.stickEl.hidden = false;
    this.hintEl.hidden = true;
    this._stickMove(e);
  }

  _stickMove(e) {
    const st = this._stick, R = this._radius();
    let dx = e.clientX - st.ox, dy = e.clientY - st.oy;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
    const n = Math.min(1, d / R);
    const m = n < STICK_DEAD ? 0 : Math.pow((n - STICK_DEAD) / (1 - STICK_DEAD), STICK_CURVE);
    const inv = this.input._invertY ? -1 : 1;
    this._stickX = d > 0 ? (dx / d) * m : 0;
    this._stickY = d > 0 ? (-dy / d) * m * inv : 0;
  }

  _radius() { return clamp(Math.min(window.innerWidth, window.innerHeight) * 0.15, 44, 84); }

  // ---------------------------------------------------------------- buttons

  _btnDown(e, action) {
    e.preventDefault();
    e.stopPropagation();
    this._capture(e);
    this.state.used = true;
    this.input.noteTouch();
    e.currentTarget.classList.add('down');
    switch (action) {
      case 'pause': this.input.pushEdge('pause'); break;
      case 'camera': this.input.pushEdge('camera'); break;
      case 'dodge': this.input.pushEdge('dodge'); break;
      case 'tilt': this._toggleTilt(); break;
      case 'missile': this.input.pushEdge('missile'); this.state.missile = true; break;
      case 'fire': this.input.pushEdge('fire'); this.state.fire = true; break;
      case 'drift': this.state.brake = 1; break;
      case 'boost': this.state.boost = true; break;
    }
    this._held.set(e.pointerId, { action, el: e.currentTarget });
  }

  _release(h) {
    h.el.classList.remove('down');
    if (h.action === 'fire') this.state.fire = [...this._held.values()].some((o) => o !== h && o.action === 'fire');
    if (h.action === 'missile') this.state.missile = false;
    if (h.action === 'drift') this.state.brake = 0;
    if (h.action === 'boost') this.state.boost = false;
  }

  // ---------------------------------------------------------------- shared pointer plumbing

  _capture(e) { try { e.target.setPointerCapture?.(e.pointerId); } catch { /* already gone */ } }

  _move(e) {
    if (this._stick && e.pointerId === this._stick.id) { e.preventDefault(); this._stickMove(e); }
  }

  _up(e) {
    if (this._stick && e.pointerId === this._stick.id) {
      this._stick = null;
      this._stickX = 0; this._stickY = 0;
      this.stickEl.hidden = true;
      this.knobEl.style.transform = '';
    }
    const h = this._held.get(e.pointerId);
    if (h) { this._held.delete(e.pointerId); this._release(h); }
  }

  _releaseAll() {
    for (const h of this._held.values()) this._release(h);
    this._held.clear();
    this._stick = null;
    if (this.stickEl) this.stickEl.hidden = true;
    Object.assign(this.state, { aimX: 0, aimY: 0, throttle: 0, brake: 0, boost: false, fire: false, missile: false });
  }

  // ---------------------------------------------------------------- tilt

  _toggleTilt() {
    const t = this._tilt;
    t.on = !t.on;
    this.tiltBtn.classList.toggle('on', t.on);
    this.app.saveSettings({ tiltSteer: t.on });
    if (t.on) { t.ref = null; this._askMotion(); this.app.toast?.('Tilt steering on · turn the phone like a wheel · it centres itself at the start of each race'); }
    else { t.ok = false; t.x = 0; }
  }

  /** iOS asks for motion access, and only from inside a tap. */
  _askMotion() {
    const ask = typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission;
    if (!ask) { this._listenMotion(); return; }
    DeviceMotionEvent.requestPermission().then((r) => {
      if (r === 'granted') this._listenMotion();
      else { this._tilt.on = false; this.tiltBtn.classList.remove('on'); this.app.toast?.('Motion access was refused, so tilt steering is off'); }
    }).catch(() => {});
  }

  _listenMotion() {
    if (this._tilt.listening) return;
    this._tilt.listening = true;
    window.addEventListener('devicemotion', this._onMotion);
  }

  /**
   * Steering is the angle the phone has been turned in the plane of its screen since tilt
   * was centred, read from where gravity points. Only that relative turn is used, so it
   * doesn't matter which way up the phone is or how a platform signs its axes.
   */
  _onMotion(e) {
    const g = e.accelerationIncludingGravity, t = this._tilt;
    if (!t.on || !g || g.x == null) return;
    const gx = g.x, gy = g.y;
    if (Math.hypot(gx, gy) < TILT_MIN_G) { t.ok = false; return; } // lying flat: no wheel to read
    if (!t.ref) { t.ref = { x: gx, y: gy }; t.x = 0; t.ok = true; return; }
    const cross = t.ref.x * gy - t.ref.y * gx, dot = t.ref.x * gx + t.ref.y * gy;
    const a = Math.atan2(cross, dot); // + = phone turned clockwise as you look at it = steer right
    t.x = clamp(a / TILT_RANGE, -1, 1);
    if (Math.abs(t.x) < 0.06) t.x = 0;
    t.ok = true;
  }

  dispose() {
    if (!this.enabled) return;
    document.removeEventListener('click', this._onStartTap, true);
    window.removeEventListener('devicemotion', this._onMotion);
    window.removeEventListener('orientationchange', this._onOrient);
    this.el.remove();
  }
}
