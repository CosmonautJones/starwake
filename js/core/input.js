// Starwake input: keyboard + mouse + gamepad (standard mapping). No dependencies.
//
// Free-flight controls. Per frame:
//   const ctl = input.poll();   // { throttle, brake, boost, roll, aimX, aimY, fire, missile }
//   const c = input.cursor;     // { x, y, px, py } aim + where to draw the reticle (CSS px)
//   if (input.pressed('fire')) ...   // one-frame edges
//   input.endFrame();           // after the game consumed the edges
//
//   throttle/brake 0..1, boost bool, roll -1..1 (+ = roll right / clockwise),
//   aimX/aimY -1..1 virtual stick (+x right, +y UP; vector length <= 1) - the ship turns
//   toward it, fire/missile bool (held).
//
// Keyboard: W throttle, S brake, A/Q roll left, D/E roll right, Space/Shift boost,
//   F/J fire, G/K missile, arrows = aim (ramps in, recentres fast).
//   Edges: pause (Esc, P), back (Esc, Backspace), reset (R), camera (C), confirm (Enter),
//   fire, missile.
// Mouse (race mode only): cursor offset from screen centre is the aim, LMB fire, RMB
//   missile. Optional pointer lock turns the mouse into a virtual stick.
// Gamepad: left stick aim, right stick X roll, RT throttle, LT brake, A boost, RB fire,
//   LB/X missile, Y reset, Start pause, Back camera, B back; d-pad / stick nav edges.
//
// Keys are matched by KeyboardEvent.code (physical position), so WASD stays
// under the left hand on AZERTY/Dvorak layouts too; e.key is a fallback for
// synthetic/virtual keyboards that leave `code` empty.

const AIM_DEADZONE = 0.12; // radial, left stick
const STICK_CURVE = 1.3; // >1 = finer control near centre
const ROLL_DEADZONE = 0.12; // right stick X
const NAV_THRESHOLD = 0.6; // stick deflection that counts as a nav press
const NAV_DELAY = 0.4; // seconds before auto-repeat starts
const NAV_REPEAT = 0.15; // seconds between repeats
const KB_AIM_IN = 0.15; // seconds for keyboard aim to reach full deflection
const KB_AIM_OUT = 0.05; // seconds to recentre (and to reverse through centre)
const BTN_ON = 0.5; // analog button threshold for digital use
const ACTIVITY = 0.1; // analog level that counts as "the pad is being used"
const AIM_RADIUS = 0.36; // fraction of min(innerWidth, innerHeight) that is full aim
const MOUSE_WAKE_PX = 3; // mouse travel needed to take the aim back from the gamepad
const LOCK_MAX_STEP = 0.5; // max virtual-cursor travel per event (filters lock spikes)

// Keys held for continuous controls.
const GAME_CODES = {
  KeyW: 1,
  KeyS: 1,
  KeyA: 1,
  KeyD: 1,
  KeyQ: 1,
  KeyE: 1,
  Space: 1,
  ShiftLeft: 1,
  ShiftRight: 1,
  KeyF: 1,
  KeyJ: 1,
  KeyG: 1,
  KeyK: 1,
  ArrowUp: 1,
  ArrowDown: 1,
  ArrowLeft: 1,
  ArrowRight: 1,
};

// Keys whose default browser action (scrolling) is blocked in race mode.
const SCROLL_CODES = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Space: 1 };

// Fallback for events with an empty `code`.
const KEY_TO_CODE = {
  w: 'KeyW',
  a: 'KeyA',
  s: 'KeyS',
  d: 'KeyD',
  q: 'KeyQ',
  e: 'KeyE',
  f: 'KeyF',
  g: 'KeyG',
  j: 'KeyJ',
  k: 'KeyK',
  p: 'KeyP',
  r: 'KeyR',
  c: 'KeyC',
  x: 'KeyX',
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Shift: 'ShiftLeft',
  Escape: 'Escape',
  Esc: 'Escape',
  Enter: 'Enter',
  Backspace: 'Backspace',
};

// Gamepad buttons (standard mapping) -> edge actions.
const PAD_EDGES = [
  [9, 'pause'],
  [3, 'reset'],
  [8, 'camera'],
  [0, 'confirm'],
  [1, 'back'],
  [5, 'fire'],
  [4, 'missile'],
  [2, 'missile'],
  [1, 'dodge'],
];

const NAV_DIRS = ['up', 'down', 'left', 'right'];
const DPAD = { up: 12, down: 13, left: 14, right: 15 };

// Mouse presses on (or inside) these never count as fire/missile.
const INTERACTIVE =
  'button, a[href], input, select, textarea, label, summary, option, details, [contenteditable=""], ' +
  '[contenteditable="true"], [role="button"], [role="link"], [role="slider"], [role="checkbox"], ' +
  '[role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="radio"], [data-ui-control]';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** True when the event comes from a text-entry element (don't steal typing). */
function isTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

function btnValue(pad, i) {
  const b = pad.buttons && pad.buttons[i];
  if (!b) return 0;
  if (typeof b === 'number') return b; // very old implementations
  return b.pressed && !(b.value > 0) ? 1 : b.value || 0;
}

/** Ramp `cur` towards `target` (-1/0/1): slow in, fast back to (and through) centre. */
function rampAxis(cur, target, dt) {
  if (target === 0 || (cur !== 0 && Math.sign(target) !== Math.sign(cur))) {
    const step = dt / KB_AIM_OUT;
    if (target === 0) return Math.abs(cur) <= step ? 0 : cur - Math.sign(cur) * step;
    return clamp(cur + Math.sign(target) * step, -1, 1);
  }
  const step = dt / KB_AIM_IN;
  return target > 0 ? Math.min(1, cur + step) : Math.max(-1, cur - step);
}

/** Clamp a 2D vector to the unit circle (in place on the returned object). */
function unit(x, y) {
  const m = Math.hypot(x, y);
  if (m > 1) return { x: x / m, y: y / m };
  return { x, y };
}

export class Input {
  constructor(target = window) {
    this.target = target;
    this._held = new Set(); // codes currently down (game keys only)
    this._tapped = new Set(); // codes pressed since last poll (so quick taps count)
    this._edges = new Set(); // actions triggered this frame
    this._kbAimX = 0;
    this._kbAimY = 0;
    this._lastPoll = 0;
    this._device = 'keyboard';
    this._padConnected = false;
    this._padPrev = new Map(); // gamepad index -> Float32Array of previous button values
    this._lastPadIndex = -1;
    this._nav = {};
    for (const d of NAV_DIRS) this._nav[d] = { held: false, timer: 0 };
    this._anyCbs = [];
    this._raceMode = false;

    // Options.
    this._sens = 1;
    this._invertY = false;

    // Mouse state.
    this._mouseKnown = false; // has the cursor position been seen?
    this._mx = 0; // clientX/Y of the real cursor
    this._my = 0;
    this._vx = 0; // virtual cursor (pointer lock), aim units, +y up
    this._vy = 0;
    this._mouseHeld = { fire: false, missile: false };
    this._mouseTap = { fire: false, missile: false };
    this._wake = 0; // mouse travel accumulated while another device is active
    this._exitRequested = false;
    this._wasLocked = false;

    // Last computed aim (for the reticle when the pad/keyboard is aiming).
    this._aimX = 0;
    this._aimY = 0;
    this._aimSource = 'none'; // 'mouse' | 'keyboard' | 'gamepad' | 'none'

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
    this._onLockError = this._onLockError.bind(this);
    this._onPadConnect = this._onPadConnect.bind(this);
    this._onPadDisconnect = this._onPadDisconnect.bind(this);

    const win = typeof window !== 'undefined' ? window : null;
    this._win = win;
    if (target && target.addEventListener) {
      target.addEventListener('keydown', this._onKeyDown);
      target.addEventListener('keyup', this._onKeyUp);
      target.addEventListener('pointerdown', this._onPointerDown);
      target.addEventListener('pointerup', this._onPointerUp);
      target.addEventListener('mousemove', this._onMouseMove);
      target.addEventListener('mousedown', this._onMouseDown);
      target.addEventListener('mouseup', this._onMouseUp);
      target.addEventListener('contextmenu', this._onContextMenu);
    }
    if (win) {
      win.addEventListener('blur', this._onBlur);
      win.addEventListener('gamepadconnected', this._onPadConnect);
      win.addEventListener('gamepaddisconnected', this._onPadDisconnect);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
      document.addEventListener('pointerlockchange', this._onLockChange);
      document.addEventListener('pointerlockerror', this._onLockError);
    }
  }

  /** Remove all listeners (not normally needed; handy for tests/hot reload). */
  destroy() {
    const t = this.target;
    if (t && t.removeEventListener) {
      t.removeEventListener('keydown', this._onKeyDown);
      t.removeEventListener('keyup', this._onKeyUp);
      t.removeEventListener('pointerdown', this._onPointerDown);
      t.removeEventListener('pointerup', this._onPointerUp);
      t.removeEventListener('mousemove', this._onMouseMove);
      t.removeEventListener('mousedown', this._onMouseDown);
      t.removeEventListener('mouseup', this._onMouseUp);
      t.removeEventListener('contextmenu', this._onContextMenu);
    }
    if (this._win) {
      this._win.removeEventListener('blur', this._onBlur);
      this._win.removeEventListener('gamepadconnected', this._onPadConnect);
      this._win.removeEventListener('gamepaddisconnected', this._onPadDisconnect);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
      document.removeEventListener('pointerlockchange', this._onLockChange);
      document.removeEventListener('pointerlockerror', this._onLockError);
    }
    this._anyCbs.length = 0;
  }

  // -------------------------------------------------------------------------
  // Public API

  /** 'keyboard' | 'mouse' | 'gamepad': the device that most recently produced input. */
  get activeDevice() {
    return this._device;
  }

  get gamepadConnected() {
    return this._padConnected;
  }

  /** True while the pointer is locked (virtual-stick mouse mode). */
  get pointerLocked() {
    return typeof document !== 'undefined' && !!document.pointerLockElement;
  }

  /**
   * Aim + reticle position: { x, y, px, py }.
   * x/y are the aim values (+y up). px/py are CSS pixels where the game should draw the
   * reticle: the real mouse position (unlocked mouse), otherwise centre + aim * R (y inverted).
   */
  get cursor() {
    const { cx, cy, R } = this._screen();
    const src = this._aimSource;
    if (src === 'keyboard' || src === 'gamepad') {
      return { x: this._aimX, y: this._aimY, px: cx + this._aimX * R, py: cy - this._aimY * R };
    }
    const m = this._mouseAim();
    if (this.pointerLocked) return { x: m.x, y: m.y, px: cx + m.x * R, py: cy - m.y * R };
    if (this._mouseKnown) return { x: m.x, y: m.y, px: this._mx, py: this._my };
    return { x: m.x, y: m.y, px: cx, py: cy };
  }

  /** Callback fired once on the next keydown / pointerdown / gamepad button. */
  onAnyInput(callback) {
    if (typeof callback === 'function') this._anyCbs.push(callback);
  }

  /**
   * Race mode: game keys (arrows, space) don't scroll the page, the mouse aims and its
   * buttons fire, and the context menu is suppressed. Turning it off releases held mouse
   * buttons (in menus mouse aim is 0 and clicks don't fire).
   */
  setRaceMode(on) {
    this._raceMode = !!on;
    if (!this._raceMode) this._releaseMouse();
  }

  /** { sensitivity = 1, invertY = false }: missing keys keep their value. */
  setOptions(o = {}) {
    if (!o) return;
    if (typeof o.sensitivity === 'number' && Number.isFinite(o.sensitivity)) this._sens = clamp(o.sensitivity, 0.05, 10);
    if (o.invertY !== undefined) this._invertY = !!o.invertY;
  }

  /**
   * Lock the pointer to `element` (default: #scene, else <body>). Call from a user gesture.
   * Never throws; if the browser/iframe refuses, input stays in unlocked mode.
   */
  requestPointerLock(element) {
    if (typeof document === 'undefined') return;
    let el = element;
    if (!el) el = document.getElementById('scene') || document.body;
    if (!el || typeof el.requestPointerLock !== 'function') return;
    this._exitRequested = false;
    try {
      const r = el.requestPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {
      /* refused (no gesture, sandboxed iframe, unsupported): stay unlocked */
    }
  }

  /** Release pointer lock (no-op if not locked). */
  exitPointerLock() {
    if (typeof document === 'undefined') return;
    if (!document.pointerLockElement) return;
    this._exitRequested = true;
    try {
      const r = document.exitPointerLock();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  /** Centre the virtual (pointer-locked) cursor. */
  recenter() {
    this._vx = 0;
    this._vy = 0;
  }

  /** True on the frame `action` was triggered. */
  pressed(action) {
    return this._edges.has(action);
  }

  /** Clear edge flags. Call after the game has consumed them for this frame. */
  endFrame() {
    this._edges.clear();
  }

  /** Read devices once per frame. Returns { throttle, brake, boost, roll, aimX, aimY, fire, missile }. */
  poll() {
    const t = nowMs();
    const dt = this._lastPoll ? clamp((t - this._lastPoll) / 1000, 0, 0.1) : 1 / 60;
    this._lastPoll = t;
    const inv = this._invertY ? -1 : 1;

    // --- Keyboard (held keys plus anything tapped since last poll).
    const k = (code) => this._held.has(code) || this._tapped.has(code);
    let throttle = k('KeyW') ? 1 : 0;
    let brake = k('KeyS') ? 1 : 0;
    let roll = (k('KeyD') || k('KeyE') ? 1 : 0) - (k('KeyA') || k('KeyQ') ? 1 : 0);
    let boost = k('Space') || k('ShiftLeft') || k('ShiftRight');
    let fire = k('KeyF') || k('KeyJ');
    let missile = k('KeyG') || k('KeyK');
    const ax = (k('ArrowRight') ? 1 : 0) - (k('ArrowLeft') ? 1 : 0);
    const ay = ((k('ArrowUp') ? 1 : 0) - (k('ArrowDown') ? 1 : 0)) * inv;
    const arrows = ax !== 0 || ay !== 0;
    this._tapped.clear();
    this._kbAimX = rampAxis(this._kbAimX, ax, dt);
    this._kbAimY = rampAxis(this._kbAimY, ay, dt);
    const kbAiming = arrows || this._kbAimX !== 0 || this._kbAimY !== 0;

    // --- Mouse buttons (race mode only; taps between polls still count).
    if (this._raceMode) {
      if (this._mouseHeld.fire || this._mouseTap.fire) fire = true;
      if (this._mouseHeld.missile || this._mouseTap.missile) missile = true;
    }
    this._mouseTap.fire = false;
    this._mouseTap.missile = false;

    // --- Gamepads (all connected pads are merged; max magnitude wins).
    const pads = this._pads();
    this._padConnected = pads.length > 0;
    const nav = { up: false, down: false, left: false, right: false };
    let padActive = false;
    let padAimX = 0;
    let padAimY = 0;
    let padAimMag = 0;

    for (let p = 0; p < pads.length; p++) {
      const pad = pads[p];
      const n = pad.buttons ? pad.buttons.length : 0;
      let prev = this._padPrev.get(pad.index);
      if (!prev || prev.length !== n) {
        // First sight of this pad: treat currently held buttons as already held
        // so a button held while connecting doesn't fire an edge.
        prev = new Float32Array(n);
        for (let i = 0; i < n; i++) prev[i] = btnValue(pad, i);
        this._padPrev.set(pad.index, prev);
      }

      const axes = pad.axes || [];
      const rt = btnValue(pad, 7);
      const lt = btnValue(pad, 6);
      const lx = axes.length > 0 ? axes[0] || 0 : 0;
      const ly = axes.length > 1 ? axes[1] || 0 : 0;
      const rx = axes.length > 2 ? axes[2] || 0 : 0;

      // Left stick -> aim: radial deadzone, rescale, response curve. Stick up = +y.
      const mag = Math.hypot(lx, ly);
      if (mag > AIM_DEADZONE) {
        const m = Math.pow(clamp((mag - AIM_DEADZONE) / (1 - AIM_DEADZONE), 0, 1), STICK_CURVE);
        if (m > padAimMag) {
          padAimMag = m;
          padAimX = (lx / mag) * m;
          padAimY = (-ly / mag) * m * inv;
        }
      }

      // Right stick X -> roll.
      const rmag = Math.abs(rx);
      if (rmag > ROLL_DEADZONE) {
        const r = Math.sign(rx) * Math.pow(clamp((rmag - ROLL_DEADZONE) / (1 - ROLL_DEADZONE), 0, 1), STICK_CURVE);
        if (Math.abs(r) > Math.abs(roll)) roll = r;
      }

      if (rt > throttle) throttle = rt;
      if (lt > brake) brake = lt;
      if (btnValue(pad, 0) > BTN_ON) boost = true;
      if (btnValue(pad, 5) > BTN_ON) fire = true;
      if (btnValue(pad, 4) > BTN_ON || btnValue(pad, 2) > BTN_ON) missile = true;

      // Edges.
      let anyNewPress = false;
      for (let i = 0; i < n; i++) {
        const v = btnValue(pad, i);
        if (v > BTN_ON && !(prev[i] > BTN_ON)) anyNewPress = true;
      }
      for (const [bi, action] of PAD_EDGES) {
        if (btnValue(pad, bi) > BTN_ON && !(prev[bi] > BTN_ON)) this._edges.add(action);
      }

      // Nav sources (d-pad or left stick past threshold).
      if (btnValue(pad, DPAD.up) > BTN_ON || ly < -NAV_THRESHOLD) nav.up = true;
      if (btnValue(pad, DPAD.down) > BTN_ON || ly > NAV_THRESHOLD) nav.down = true;
      if (btnValue(pad, DPAD.left) > BTN_ON || lx < -NAV_THRESHOLD) nav.left = true;
      if (btnValue(pad, DPAD.right) > BTN_ON || lx > NAV_THRESHOLD) nav.right = true;

      // Activity -> active device.
      let active =
        anyNewPress || mag > AIM_DEADZONE + 0.05 || rmag > ROLL_DEADZONE + 0.05 || rt > ACTIVITY || lt > ACTIVITY;
      if (!active) {
        for (let i = 0; i < n; i++) {
          if (i !== 6 && i !== 7 && btnValue(pad, i) > BTN_ON) {
            active = true;
            break;
          }
        }
      }
      if (active) {
        padActive = true;
        this._lastPadIndex = pad.index;
      }

      for (let i = 0; i < n; i++) prev[i] = btnValue(pad, i);
      if (anyNewPress) this._fireAny();
    }

    // Forget pads that went away.
    if (this._padPrev.size > pads.length) {
      for (const idx of this._padPrev.keys()) {
        if (!pads.some((pd) => pd.index === idx)) this._padPrev.delete(idx);
      }
    }

    // Nav with auto-repeat.
    for (const d of NAV_DIRS) {
      const st = this._nav[d];
      if (nav[d]) {
        if (!st.held) {
          st.held = true;
          st.timer = NAV_DELAY;
          this._edges.add(d);
        } else {
          st.timer -= dt;
          if (st.timer <= 0) {
            this._edges.add(d);
            st.timer += NAV_REPEAT;
            if (st.timer <= 0) st.timer = NAV_REPEAT; // after a long stall
          }
        }
      } else {
        st.held = false;
      }
    }

    if (padActive) this._setDevice('gamepad');

    // --- Aim source. Gamepad owns the aim once used (until the mouse moves again);
    // arrow keys override the mouse while they're in use; otherwise the mouse aims.
    let aim;
    let src;
    if (this._device === 'gamepad') {
      if (kbAiming && Math.hypot(this._kbAimX, this._kbAimY) > padAimMag) {
        aim = { x: this._kbAimX, y: this._kbAimY };
        src = 'keyboard';
      } else {
        aim = { x: padAimX, y: padAimY };
        src = 'gamepad';
      }
    } else if (kbAiming) {
      aim = { x: this._kbAimX, y: this._kbAimY };
      src = 'keyboard';
    } else {
      const m = this._mouseAim();
      if (m.ok) {
        aim = m;
        src = 'mouse';
      } else if (padAimMag > 0) {
        aim = { x: padAimX, y: padAimY };
        src = 'gamepad';
      } else {
        aim = { x: 0, y: 0 };
        src = 'none';
      }
    }
    aim = unit(clamp(aim.x, -1, 1), clamp(aim.y, -1, 1));
    this._aimX = aim.x;
    this._aimY = aim.y;
    this._aimSource = src;

    return {
      throttle: clamp(throttle, 0, 1),
      brake: clamp(brake, 0, 1),
      boost: !!boost,
      roll: clamp(roll, -1, 1),
      aimX: aim.x,
      aimY: aim.y,
      fire: !!fire,
      missile: !!missile,
    };
  }

  /** Dual-rumble on the gamepad in use; silently does nothing if unsupported. */
  rumble(intensity, ms) {
    const mag = clamp(Number(intensity) || 0, 0, 1);
    const dur = clamp(Number(ms) || 0, 0, 5000);
    if (mag <= 0 || dur <= 0) return;
    const pads = this._pads();
    if (!pads.length) return;
    let targets = pads.filter((p) => p.index === this._lastPadIndex);
    if (!targets.length) targets = pads;
    for (const pad of targets) {
      try {
        const act = pad.vibrationActuator;
        if (act && typeof act.playEffect === 'function') {
          const r = act.playEffect(act.type || 'dual-rumble', {
            startDelay: 0,
            duration: dur,
            strongMagnitude: mag,
            weakMagnitude: clamp(mag * 0.6 + 0.15, 0, 1),
          });
          if (r && r.catch) r.catch(() => {});
        } else if (pad.hapticActuators && pad.hapticActuators[0] && pad.hapticActuators[0].pulse) {
          const r = pad.hapticActuators[0].pulse(mag, dur);
          if (r && r.catch) r.catch(() => {});
        }
      } catch (e) {
        /* unsupported: no-op */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals

  /** Connected gamepads (standard mapping preferred but not required). */
  _pads() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') return [];
    let list;
    try {
      list = nav.getGamepads();
    } catch (e) {
      return []; // e.g. blocked by permissions policy
    }
    const out = [];
    if (!list) return out;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p && p.connected !== false) out.push(p);
    }
    return out;
  }

  _setDevice(d) {
    if (d !== this._device) {
      this._device = d;
      this._wake = 0;
    }
  }

  /** Screen centre and full-aim radius, CSS px. */
  _screen() {
    const w = this._win ? this._win.innerWidth || 0 : 0;
    const h = this._win ? this._win.innerHeight || 0 : 0;
    const R = Math.max(1, AIM_RADIUS * Math.min(w || 1, h || 1));
    return { cx: w / 2, cy: h / 2, R };
  }

  /** Aim from the real cursor position (ignores race mode). */
  _rawMouseAim() {
    if (!this._mouseKnown) return { x: 0, y: 0 };
    const { cx, cy, R } = this._screen();
    return unit((this._mx - cx) / R, (cy - this._my) / R);
  }

  /** Mouse aim for the game: { x, y, ok }. Zero (ok=false) outside race mode. */
  _mouseAim() {
    if (!this._raceMode) return { x: 0, y: 0, ok: false };
    if (this.pointerLocked) return { x: this._vx, y: this._vy, ok: true };
    if (!this._mouseKnown) return { x: 0, y: 0, ok: false };
    const a = this._rawMouseAim();
    return { x: a.x, y: a.y, ok: true };
  }

  _fireAny() {
    if (!this._anyCbs.length) return;
    const cbs = this._anyCbs;
    this._anyCbs = [];
    for (const cb of cbs) {
      try {
        cb();
      } catch (e) {
        // A failing callback must not break input handling.
        setTimeout(() => {
          throw e;
        }, 0);
      }
    }
  }

  _codeOf(e) {
    if (e.code) return e.code;
    return KEY_TO_CODE[e.key] || KEY_TO_CODE[(e.key || '').toLowerCase()] || '';
  }

  _onKeyDown(e) {
    this._setDevice('keyboard');
    this._fireAny();

    const code = this._codeOf(e);
    const typing = isTypingTarget(e.target);

    if (typing) {
      // Leave typing alone: no game keys, no shortcut edges, no preventDefault.
      // (The UI can handle Escape on its own text fields if it wants to.)
      return;
    }

    if (this._raceMode && SCROLL_CODES[code] && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();

    const chord = e.ctrlKey || e.metaKey || e.altKey;
    if (GAME_CODES[code]) {
      this._held.add(code);
      this._tapped.add(code);
    }

    // Shortcut edges ignore auto-repeat and browser chords (Ctrl+R etc).
    if (e.repeat || chord) return;
    // Dodge: double-tap a roll key (A/D or Q/E) within 260 ms, or X.
    const side = code === 'KeyA' || code === 'KeyQ' ? -1 : code === 'KeyD' || code === 'KeyE' ? 1 : 0;
    if (side) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (this._lastTap && this._lastTap.side === side && now - this._lastTap.t < 260) {
        this._edges.add(side < 0 ? 'dodgeLeft' : 'dodgeRight');
        this._lastTap = null;
      } else this._lastTap = { side, t: now };
    }
    switch (code) {
      case 'KeyX':
        this._edges.add('dodge');
        break;
      case 'Escape':
        this._edges.add('pause');
        this._edges.add('back');
        break;
      case 'KeyP':
        this._edges.add('pause');
        break;
      case 'KeyR':
        this._edges.add('reset');
        break;
      case 'KeyC':
        this._edges.add('camera');
        break;
      case 'Enter':
      case 'NumpadEnter':
        this._edges.add('confirm');
        break;
      case 'Backspace':
        this._edges.add('back');
        break;
      case 'KeyF':
      case 'KeyJ':
        this._edges.add('fire');
        break;
      case 'KeyG':
      case 'KeyK':
        this._edges.add('missile');
        break;
      default:
        break;
    }
  }

  _onKeyUp(e) {
    const code = this._codeOf(e);
    this._held.delete(code);
    // Shift released: some browsers report the other Shift too late/never.
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      if (!e.shiftKey) {
        this._held.delete('ShiftLeft');
        this._held.delete('ShiftRight');
      }
    }
  }

  _onBlur() {
    this._clearHeld();
  }

  _onVisibility() {
    if (typeof document !== 'undefined' && document.hidden) this._clearHeld();
  }

  _clearHeld() {
    this._held.clear();
    this._tapped.clear();
    this._kbAimX = 0;
    this._kbAimY = 0;
    this._releaseMouse();
  }

  _releaseMouse() {
    this._mouseHeld.fire = false;
    this._mouseHeld.missile = false;
    this._mouseTap.fire = false;
    this._mouseTap.missile = false;
  }

  /** Should a mouse press on `el` count as fire/missile? */
  _isGameSurface(el) {
    if (this.pointerLocked) return true;
    if (typeof document === 'undefined') return false;
    if (!el || el.nodeType !== 1) return el === document || el === this._win;
    if (el.closest && el.closest(INTERACTIVE)) return false;
    if (el === document.body || el === document.documentElement || el.id === 'scene') return true;
    if (el.closest) {
      if (el.closest('#scene, #labels, #hud-root')) return true;
    }
    return false;
  }

  _onMouseMove(e) {
    let dist = 0;
    if (this.pointerLocked) {
      const mx = Number(e.movementX) || 0;
      const my = Number(e.movementY) || 0;
      dist = Math.abs(mx) + Math.abs(my);
      if (dist > 0) {
        const { R } = this._screen();
        const inv = this._invertY ? -1 : 1;
        const dx = clamp((mx * this._sens) / R, -LOCK_MAX_STEP, LOCK_MAX_STEP);
        const dy = clamp((-my * this._sens * inv) / R, -LOCK_MAX_STEP, LOCK_MAX_STEP);
        const v = unit(this._vx + dx, this._vy + dy);
        this._vx = v.x;
        this._vy = v.y;
      }
    } else if (typeof e.clientX === 'number') {
      if (this._mouseKnown) dist = Math.abs(e.clientX - this._mx) + Math.abs(e.clientY - this._my);
      else dist = MOUSE_WAKE_PX; // first sighting counts as movement
      this._mx = e.clientX;
      this._my = e.clientY;
      this._mouseKnown = true;
    }

    // A released button we never saw go up (mouseup outside the window).
    if (typeof e.buttons === 'number') {
      if (this._mouseHeld.fire && !(e.buttons & 1)) this._mouseHeld.fire = false;
      if (this._mouseHeld.missile && !(e.buttons & 2)) this._mouseHeld.missile = false;
    }

    if (this._raceMode && dist > 0 && this._device !== 'mouse') {
      this._wake += dist;
      if (this._wake >= MOUSE_WAKE_PX) this._setDevice('mouse');
    }
  }

  _onMouseDown(e) {
    if (typeof e.clientX === 'number' && !this.pointerLocked) {
      this._mx = e.clientX;
      this._my = e.clientY;
      this._mouseKnown = true;
    }
    if (!this._raceMode) return;
    const which = e.button === 0 ? 'fire' : e.button === 2 ? 'missile' : null;
    if (!which) return;
    if (!this._isGameSurface(e.target)) return;
    if (e.cancelable) e.preventDefault(); // no text selection / focus steal mid-race
    this._setDevice('mouse');
    if (!this._mouseHeld[which]) this._edges.add(which);
    this._mouseHeld[which] = true;
    this._mouseTap[which] = true;
  }

  _onMouseUp(e) {
    if (e.button === 0) this._mouseHeld.fire = false;
    else if (e.button === 2) this._mouseHeld.missile = false;
  }

  _onContextMenu(e) {
    if (!this._raceMode) return;
    if (isTypingTarget(e.target)) return; // keep copy/paste menus on text fields
    if (e.cancelable) e.preventDefault();
  }

  _onLockChange() {
    const locked = this.pointerLocked;
    if (locked && !this._wasLocked) {
      // Start the virtual stick where the real cursor was, so the aim doesn't jump.
      const a = this._rawMouseAim();
      this._vx = a.x;
      this._vy = a.y;
    } else if (!locked && this._wasLocked) {
      // Lock lost without exitPointerLock() (usually Esc, which the browser swallows).
      if (!this._exitRequested) this._edges.add('lockLost');
      this._exitRequested = false;
    }
    this._wasLocked = locked;
  }

  _onLockError() {
    this._exitRequested = false;
    this._wasLocked = this.pointerLocked;
  }

  _onPointerDown(e) {
    // Touch/pen pointerdown is not a user activation for audio in Chrome;
    // wait for pointerup in that case so unlock callbacks actually work.
    if (e && e.pointerType && e.pointerType !== 'mouse') return;
    this._fireAny();
  }

  _onPointerUp(e) {
    if (e && e.pointerType && e.pointerType !== 'mouse') this._fireAny();
  }

  _onPadConnect() {
    this._padConnected = true;
  }

  _onPadDisconnect() {
    this._padConnected = this._pads().length > 0;
  }
}
