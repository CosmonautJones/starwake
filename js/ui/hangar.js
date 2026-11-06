// Hangar: pick, build and paint craft with a live 3D preview. Custom designs
// save automatically; editing a preset forks it into a new custom craft.

import { storage } from '../core/storage.js';
import { SLOTS, LOOK_SLOTS, STAT_KEYS, PAINT_SWATCHES, PRESETS, computeStats, normalizeDesign } from '../craft/parts.js';
import { escapeHtml, randomId, $, $$ } from '../core/util.js';
import { loadCareer, isUnlocked, lockNote } from '../core/career.js';
import { html } from './screens.js';
import { LOCK_ICON } from './careerView.js';

export class HangarScreen {
  constructor(app, onExit) {
    this.app = app;
    this.onExitCb = onExit;
    this.stage = app.showHangarStage();
    this.designs = storage.allDesigns();
    const selId = storage.getSelectedId();
    this.flyingId = selId;
    this.current = normalizeDesign(this.designs.find((d) => d.id === selId) || PRESETS[0]);
    this.current.id = (this.designs.find((d) => d.id === selId) || PRESETS[0]).id;
    this.current.preset = PRESETS.some((p) => p.id === this.current.id);
    this.baseline = computeStats(this.current);

    this.el = html(`
      <section class="screen hangar">
        <header class="screen-head"><button class="back" data-act="back" data-sound="back">Back</button><h2>Hangar</h2><p class="save-state" data-k="saveState" role="status"></p><button class="primary" data-act="fly">Fly this craft</button></header>
        <aside class="panel fleet" aria-label="Your craft">
          <h3>Fleet</h3>
          <ul data-k="list"></ul>
          <div class="row tight">
            <button data-act="new">New</button>
            <button data-act="dup">Copy</button>
            <button data-act="del" data-sound="back">Delete</button>
          </div>
        </aside>
        <div class="hangar-view" data-k="view" aria-label="Craft preview. Drag to rotate."></div>
        <aside class="panel builder" aria-label="Build">
          <label class="field"><span>Name</span><input data-k="name" maxlength="18" autocomplete="off" spellcheck="false"></label>
          <div data-k="slots"></div>
          <div data-k="looks"></div>
          <div data-k="paint"></div>
        </aside>
        <div class="panel stats" data-k="stats" aria-label="Handling"></div>
      </section>`);
    this.k = (n) => $(`[data-k=${n}]`, this.el);

    this._bind();
    this.renderAll();
    this.onBack = () => this.exit();
  }

  _bind() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const pick = e.target.closest('[data-pick]')?.dataset.pick;
      const cyc = e.target.closest('[data-step]');
      const sw = e.target.closest('[data-swatch]');
      if (pick) this.select(pick);
      if (cyc) this.cycle(cyc.closest('[data-cycle]').dataset.cycle, Number(cyc.dataset.step));
      if (sw) this.paint(sw.dataset.swatch, sw.dataset.color);
      if (act === 'back') this.exit();
      if (act === 'new') this.createNew();
      if (act === 'dup') this.duplicate();
      if (act === 'del') this.remove();
      if (act === 'fly') this.fly();
    });
    el.addEventListener('cycle', (e) => this.cycle(e.target.closest('[data-cycle]').dataset.cycle, e.detail));
    el.addEventListener('input', (e) => {
      if (e.target.dataset.k === 'name') { this.mutate((d) => { d.name = e.target.value.slice(0, 18) || 'Unnamed'; }, { keepFocus: true }); }
      if (e.target.dataset.color) this.paint(e.target.dataset.color, e.target.value, true);
    });
    // Drag to orbit the preview.
    const view = this.k('view');
    let drag = null;
    view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; view.setPointerCapture(e.pointerId); });
    view.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.stage.drag(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    });
    view.addEventListener('pointerup', () => (drag = null));
    view.addEventListener('wheel', (e) => { e.preventDefault(); this.stage.zoom(e.deltaY); }, { passive: false });
  }

  // ---------- state changes
  select(id) {
    const d = this.designs.find((x) => x.id === id);
    if (!d) return;
    this.peek = null;
    this.current = { ...normalizeDesign(d), id: d.id, preset: !!d.preset };
    this.baseline = computeStats(this.current);
    this.renderAll();
  }

  /** Apply a change; presets fork into a new custom craft first. */
  mutate(fn, { keepFocus = false } = {}) {
    this.peek = null;
    if (this.current.preset) {
      const fork = { ...normalizeDesign(this.current), colors: { ...this.current.colors }, id: 'c-' + randomId(8), preset: false, name: `${this.current.name} Mk II` };
      this.designs.push(fork);
      this.current = fork;
      fn(this.current);
      this.save('Saved as a new craft — presets stay untouched');
      this.renderAll(keepFocus);
      return;
    }
    fn(this.current);
    const idx = this.designs.findIndex((x) => x.id === this.current.id);
    if (idx >= 0) this.designs[idx] = { ...this.current, colors: { ...this.current.colors } };
    this.save();
    if (keepFocus) { this.renderList(); this.renderStats(); this.stage.setDesign(this.current); }
    else this.renderAll();
  }

  cycle(slot, step) {
    const def = SLOTS.find((s) => s.key === slot) || LOOK_SLOTS.find((s) => s.key === slot);
    const keys = Object.keys(def.options);
    const i = keys.indexOf(this.peek?.slot === slot ? this.peek.key : this.current[slot]);
    const next = keys[(i + step + keys.length) % keys.length];
    // Locked options can be previewed but not fitted; the design keeps what it had.
    if (next !== this.current[slot] && !isUnlocked(slot, next, loadCareer())) {
      this.peek = { slot, key: next };
      this.renderBuilder();
      this.renderStats();
      this.stage.setDesign(this.viewDesign());
    } else if (next === this.current[slot]) {
      this.peek = null;
      this.renderAll();
    } else this.mutate((d) => { d[slot] = next; });
    this.app.audio.play('click');
    // keep focus on the same cycler for gamepad users
    requestAnimationFrame(() => $(`[data-cycle=${slot}]`, this.el)?.focus({ preventScroll: true }));
  }

  paint(part, color, fromPicker = false) {
    this.mutate((d) => { d.colors = { ...d.colors, [part]: color }; }, { keepFocus: fromPicker });
  }

  createNew() {
    this.peek = null;
    const d = { ...normalizeDesign(PRESETS[0]), colors: { ...PRESETS[0].colors }, id: 'c-' + randomId(8), preset: false, name: `Craft ${this.designs.filter((x) => !x.preset).length + 1}` };
    this.designs.push(d);
    this.current = { ...d };
    this.baseline = computeStats(d);
    this.save('New craft created');
    this.renderAll();
    $('[data-k=name]', this.el).select();
  }

  duplicate() {
    this.peek = null;
    const d = { ...normalizeDesign(this.current), colors: { ...this.current.colors }, id: 'c-' + randomId(8), preset: false, name: `${this.current.name} copy`.slice(0, 18) };
    this.designs.push(d);
    this.current = { ...d };
    this.save('Duplicated');
    this.renderAll();
  }

  remove() {
    this.peek = null;
    if (this.current.preset) { this.flashState('Presets can’t be deleted. Duplicate one to make it yours.'); this.app.audio.play('error'); return; }
    const name = this.current.name;
    this.designs = this.designs.filter((x) => x.id !== this.current.id);
    if (this.flyingId === this.current.id) { this.flyingId = PRESETS[0].id; storage.setSelectedId(this.flyingId); }
    this.current = { ...normalizeDesign(PRESETS[0]), id: PRESETS[0].id, preset: true };
    this.save(`Deleted ${name}`);
    this.renderAll();
  }

  fly() {
    if (this.peek) { this.peek = null; this.renderAll(); }
    this.flyingId = this.current.id;
    storage.setSelectedId(this.current.id);
    this.app.net?.updateProfile({ name: this.app.settings.playerName, design: this.app.playerDesign() });
    this.flashState(`${this.current.name} is ready to race`);
    this.app.audio.play('ready');
    this.renderList();
  }

  save(msg) {
    const ok = storage.saveDesigns(this.designs.filter((d) => !d.preset));
    this.flashState(msg || (ok ? 'Saved' : 'Saved for this session only — this browser blocks storage'));
  }

  flashState(msg) {
    const s = this.k('saveState');
    s.textContent = msg;
    s.classList.remove('show'); void s.offsetWidth; s.classList.add('show');
  }

  exit() {
    this.app.backToAttract().then(() => this.onExitCb());
  }

  unmount() { /* stage is kept for next visit */ }

  // ---------- rendering
  /** The design on the turntable: the current one, plus a locked option being previewed. */
  viewDesign() { return this.peek ? { ...this.current, [this.peek.slot]: this.peek.key } : this.current; }

  renderAll(keepFocus = false) {
    this.renderList();
    this.renderBuilder(keepFocus);
    this.renderStats();
    this.stage.setDesign(this.viewDesign());
  }

  renderList() {
    const item = (d) => `<li><button class="choice ${d.id === this.current.id ? 'is-on' : ''}" data-pick="${d.id}" aria-pressed="${d.id === this.current.id}" style="--c:${d.colors.glow}">
      <span class="swatch" style="background:${d.colors.primary}"></span>
      <span class="fname">${escapeHtml(d.name)}</span>
      ${d.id === this.flyingId ? '<span class="tag">Flying</span>' : d.preset ? '<span class="tag dim">Preset</span>' : ''}
    </button></li>`;
    const presets = this.designs.filter((d) => d.preset);
    const mine = this.designs.filter((d) => !d.preset);
    this.k('list').innerHTML = presets.map(item).join('')
      + `<li class="divider">${mine.length ? 'Your designs' : 'Your designs appear here'}</li>`
      + mine.map(item).join('');
    $('[data-act=del]', this.el).disabled = !!this.current.preset;
  }

  renderBuilder(keepFocus) {
    const d = this.current;
    const name = this.k('name');
    if (!keepFocus || document.activeElement !== name) name.value = d.name;
    const career = loadCareer();
    const cycler = (slot) => {
      const key = this.peek?.slot === slot.key ? this.peek.key : d[slot.key];
      const opt = slot.options[key];
      const note = lockNote(slot.key, key, career);
      return `<div class="slot">
        <span class="slot-label">${slot.label}</span>
        <div class="cycler ${note ? 'is-locked' : ''}" data-cycle="${slot.key}" tabindex="0" role="group" aria-label="${slot.label}: ${opt.label}${note ? `, locked. ${note}` : ''}">
          <button data-step="-1" tabindex="-1" aria-label="Previous ${slot.label}">‹</button>
          <span class="cyc-val"><b>${opt.label}</b>${note ? `<small class="lock-note">${LOCK_ICON}${note}${key === d[slot.key] ? '' : ' · preview'}</small>` : `<small>${opt.blurb}</small>`}</span>
          <button data-step="1" tabindex="-1" aria-label="Next ${slot.label}">›</button>
        </div>
      </div>`;
    };
    this.k('slots').innerHTML = SLOTS.map(cycler).join('');
    this.k('looks').innerHTML = LOOK_SLOTS.map(cycler).join('');
    const paints = [['primary', 'Hull'], ['secondary', 'Trim'], ['glow', 'Glow']];
    this.k('paint').innerHTML = paints.map(([key, label]) => `
      <div class="paint-row">
        <span class="slot-label">${label}</span>
        <div class="swatches">${PAINT_SWATCHES.map((c) => `<button class="sw ${c.toLowerCase() === d.colors[key].toLowerCase() ? 'is-on' : ''}" data-swatch="${key}" data-color="${c}" style="--sw:${c}" aria-label="${label} ${c}"></button>`).join('')}
          <input type="color" data-color="${key}" value="${d.colors[key]}" aria-label="Custom ${label.toLowerCase()} color">
        </div>
      </div>`).join('');
    // keyboard: arrows on a focused cycler
    $$('.cycler', this.el).forEach((c) => c.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.cycle(c.dataset.cycle, e.key === 'ArrowLeft' ? -1 : 1); }
    }));
  }

  renderStats() {
    const st = computeStats(this.viewDesign());
    const base = this.baseline;
    this.k('stats').innerHTML = `
      <div class="stat-head"><h3>Performance</h3><span>${st.mass.toLocaleString()} kg</span></div>
      ${STAT_KEYS.map(({ key, label }) => {
        const v = st.ratings[key], b = base.ratings[key];
        const delta = Math.round((v - b) * 10) / 10;
        return `<div class="stat"><span>${label}</span>
          <div class="bar"><i class="ghost" style="width:${b * 10}%"></i><i style="width:${v * 10}%"></i></div>
          <em class="${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' + delta : delta < 0 ? delta : ''}</em></div>`;
      }).join('')}
      <p class="note">Heavier craft accelerate and turn slower but shrug off walls, bumps and hazards.</p>`;
  }
}
