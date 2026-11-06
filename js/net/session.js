// NetSession: host-authoritative lobby + race messaging on top of a Transport.
//
// The host owns the lobby (settings, player list, ready flags, phase) and broadcasts
// the whole lobby object whenever it changes, plus every 2s while in the lobby so late
// joiners and dropped packets recover. Clients only *request* changes (hello, ready,
// profile); the host applies them and rebroadcasts. Race traffic (states, finishes) is
// broadcast peer-to-peer through the transport so it doesn't pay an extra hop via the host.
//
// Wire messages are compact JSON objects keyed by `t`:
//   hello   { t, v, name, design }          client -> host (retried every 1s until joined)
//   reject  { t, why, v }                   host -> one client ('full' | 'started' | 'version')
//   lobby   { t, l }                        host -> all
//   ready   { t, r }                        client -> host
//   profile { t, name, design }             client -> host
//   start   { t, seed, trackId, laps, game, target, timeLimit, teams, roster, countdownMs }   host -> all
//   st      { t, s: [[id, snap], ...] }     anyone -> all
//   fin     { t, id, time, bestLap }        anyone -> all
//   res     { t, r }                        host -> all
//   bye     { t }                           client leaving
//   end     { t }                           host leaving (race is over for everyone)
//
// Times in event details (`t` on 'state', `startedAt` on 'start') are local
// performance.now() values: the moment the message was received (or, for the host's
// own 'start', sent). Clocks are never compared across machines.

import { BroadcastTransport, WsTransport, defaultRelayUrl, emit } from './transport.js';

export const PROTOCOL_VERSION = 2; // v2: free-flight game events
export const MAX_PLAYERS = 8;

const JOIN_TIMEOUT_MS = 4000;
const HELLO_RETRY_MS = 1000;
const LOBBY_REBROADCAST_MS = 2000;
const NAME_MAX = 16;
const DESIGN_MAX_BYTES = 8 * 1024;
// Room codes avoid I and O so they can't be confused with 1 and 0 when read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 32;

function makeCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/** Normalise user-typed codes: uppercase, letters only. */
function cleanCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

/** Names are user input: strip control chars, collapse whitespace, cap at 16 chars. */
export function cleanName(name) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return s || 'Pilot';
}

/** Designs are opaque JSON; only reject things that aren't plain objects or are huge. */
function cleanDesign(design) {
  if (!isObj(design)) return null;
  try {
    return JSON.stringify(design).length <= DESIGN_MAX_BYTES ? design : null;
  } catch {
    return null;
  }
}

function rejectMessage(why, code, hostV) {
  switch (why) {
    case 'full': return `The race ${code} is full (${MAX_PLAYERS} players max).`;
    case 'started': return `The race ${code} has already started. Wait for it to return to the lobby, then try again.`;
    case 'version': return `Your game version doesn't match the host's (protocol v${PROTOCOL_VERSION}, host has v${hostV ?? '?'}). Both players should reload the page.`;
    default: return `The host of ${code} turned down the join request.`;
  }
}

export class NetSession extends EventTarget {
  /**
   * @param {{kind?: 'tabs'|'relay', relayUrl?: string, name?: string, design?: object}} opts
   */
  constructor({ kind = 'tabs', relayUrl, name, design } = {}) {
    super();
    this.kind = kind === 'relay' ? 'relay' : 'tabs';
    this.relayUrl = relayUrl || defaultRelayUrl(globalThis.location);
    this.transport = this.kind === 'relay' ? new WsTransport(this.relayUrl) : new BroadcastTransport();
    this.selfId = this.transport.selfId;
    this.isHost = false;
    this.code = null;
    this.lobby = null;

    this._name = cleanName(name);
    this._design = cleanDesign(design);
    this._timers = new Set();     // every setTimeout/setInterval handle, cleared on teardown
    this._joinPending = null;     // { resolve, reject } while join() is in flight
    this._lastLobbyJson = '';     // to only dispatch 'lobby' when something changed
    this._dead = false;

    this._onMessage = (e) => this._handle(e.detail.from, e.detail.msg);
    this._onPeerLeft = (e) => this._peerGone(e.detail.peerId);
    this._onClosed = (e) => this._fatal(e.detail?.reason || 'Lost connection.');
    this.transport.addEventListener('message', this._onMessage);
    this.transport.addEventListener('peer-left', this._onPeerLeft);
    this.transport.addEventListener('closed', this._onClosed);
  }

  // ---------------------------------------------------------------------------
  // Hosting
  // ---------------------------------------------------------------------------

  /** Open a new room and become its host (and first player). Resolves with the room code. */
  async host({ trackId = null, laps = 3, aiFill = true, game = 'race', target = 10, timeLimit = 300, teams = false, hazards = 0.6 } = {}) {
    this._assertFresh();
    const code = makeCode();
    this.code = code; // reserve the session so a second host()/join() is refused
    try {
      await this.transport.open(code);
    } catch (err) {
      this._teardown();
      throw err;
    }
    if (this._dead) throw new Error('Left before the race was created.');
    this.isHost = true;
    this.code = code;
    this.lobby = {
      code,
      hostId: this.selfId,
      trackId: typeof trackId === 'string' ? trackId.slice(0, 64) : trackId,
      laps: this._cleanLaps(laps, 3),
      aiFill: this._cleanAiFill(aiFill, true),
      game: game === 'battle' ? 'battle' : 'race',
      target: cleanInt(target, 1, 99, 10),
      timeLimit: cleanInt(timeLimit, 30, 3600, 300),
      teams: !!teams,
      hazards: cleanLevel(hazards, 0.6),
      phase: 'lobby',
      players: [{ id: this.selfId, name: this._name, design: this._design, ready: true, isHost: true }],
    };
    this._every(LOBBY_REBROADCAST_MS, () => {
      if (this.lobby?.phase === 'lobby') this._send({ t: 'lobby', l: this.lobby });
    });
    this._lobbyChanged();
    return code;
  }

  /** Join an existing room. Resolves once the host has added us to its lobby. */
  async join(code) {
    this._assertFresh();
    const clean = cleanCode(code);
    if (clean.length !== 4) throw new Error('Race codes are 4 letters, like ABCD.');
    this.code = clean;
    try {
      await this.transport.open(clean);
    } catch (err) {
      this._teardown();
      throw err;
    }
    if (this._dead) throw new Error('Left before joining.');

    return new Promise((resolve, reject) => {
      this._joinPending = { resolve, reject };
      this._sendHello();
      const retry = this._every(HELLO_RETRY_MS, () => {
        if (this._joinPending) this._sendHello();
        else this._clear(retry);
      });
      this._after(JOIN_TIMEOUT_MS, () => this._failJoin(
        `No race found with code ${clean}. Check the code and that the host is in the lobby.`,
      ));
    });
  }

  // ---------------------------------------------------------------------------
  // Lobby actions
  // ---------------------------------------------------------------------------

  setReady(ready) {
    const r = !!ready;
    if (this.isHost) {
      const me = this._player(this.selfId);
      if (me && me.ready !== r) { me.ready = r; this._broadcastLobby(); }
    } else if (this._hostId()) {
      this._send({ t: 'ready', r }, this._hostId());
    }
  }

  updateProfile({ name, design } = {}) {
    if (name !== undefined) this._name = cleanName(name);
    if (design !== undefined) this._design = cleanDesign(design);
    if (this.isHost) {
      const me = this._player(this.selfId);
      if (me) { me.name = this._name; me.design = this._design; this._broadcastLobby(); }
    } else if (this._hostId()) {
      this._send({ t: 'profile', name: this._name, design: this._design }, this._hostId());
    }
  }

  updateSettings({ trackId, laps, aiFill, game, target, timeLimit, teams, hazards } = {}) {
    if (!this._hostOnly('change race settings')) return false;
    const l = this.lobby;
    if (typeof teams === 'boolean') l.teams = teams;
    if (hazards !== undefined) l.hazards = cleanLevel(hazards, l.hazards ?? 0.6);
    if (game === 'race' || game === 'battle') l.game = game;
    if (target !== undefined) l.target = cleanInt(target, 1, 99, l.target);
    if (timeLimit !== undefined) l.timeLimit = cleanInt(timeLimit, 30, 3600, l.timeLimit);
    if (typeof trackId === 'string') l.trackId = trackId.slice(0, 64);
    if (laps !== undefined) l.laps = this._cleanLaps(laps, l.laps);
    if (aiFill !== undefined) l.aiFill = this._cleanAiFill(aiFill, l.aiFill);
    this._broadcastLobby();
    return true;
  }

  /** Host only: true when every non-host player is ready (a lone host can always start). */
  canStart() {
    if (!this.isHost || !this.lobby || this.lobby.phase !== 'lobby') return false;
    return this.lobby.players.every((p) => p.isHost || p.ready);
  }

  /** Host only. Broadcasts the start and also dispatches 'start' locally. */
  startRace({ seed = Math.floor(Math.random() * 2 ** 31), roster = [], countdownMs = 3000 } = {}) {
    if (!this._hostOnly('start the race')) return false;
    const l = this.lobby;
    l.phase = 'racing';
    const msg = {
      t: 'start',
      seed: isNum(seed) ? seed : 0,
      trackId: l.trackId,
      laps: l.laps,
      game: l.game || 'race', target: l.target, timeLimit: l.timeLimit, teams: !!l.teams, hazards: l.hazards ?? 0.6,
      roster: Array.isArray(roster) ? roster : [],
      countdownMs: isNum(countdownMs) ? Math.max(0, countdownMs) : 3000,
    };
    this._broadcastLobby();
    this._send(msg);
    this._dispatch('start', this._startDetail(msg));
    return true;
  }

  // ---------------------------------------------------------------------------
  // Race traffic
  // ---------------------------------------------------------------------------

  /** list = [{ id, snap }]. Sent as a single message; caller throttles (~20Hz). */
  sendStates(list) {
    if (!Array.isArray(list) || !list.length || !this.transport.isOpen) return;
    const s = [];
    for (const e of list) if (e && isId(e.id) && isObj(e.snap)) s.push([e.id, e.snap]);
    if (s.length) this._send({ t: 'st', s });
  }

  /**
   * Gameplay events (shots, hits, broken objects, pickups). `type` is a short string,
   * `data` a small plain object. Received as a 'game' event: { type, data, from }.
   */
  sendEvent(type, data = {}) {
    if (typeof type !== 'string' || type.length > 16 || !isObj(data) || !this.transport.isOpen) return;
    this._send({ t: 'ev', y: type, d: data });
  }

  sendFinish({ id, time, bestLap } = {}) {
    if (!isId(id) || !isNum(time)) return;
    this._send({ t: 'fin', id, time, bestLap: isNum(bestLap) ? bestLap : null });
  }

  sendResults(results) {
    if (!this._hostOnly('send results')) return false;
    this._send({ t: 'res', r: results ?? null });
    return true;
  }

  /** Host only: back to the lobby with everyone un-readied. */
  backToLobby() {
    if (!this._hostOnly('return to the lobby')) return false;
    this.lobby.phase = 'lobby';
    for (const p of this.lobby.players) if (!p.isHost) p.ready = false;
    this._broadcastLobby();
    return true;
  }

  /** Leave the session. Idempotent; no 'closed' event is dispatched for a voluntary leave. */
  leave() {
    if (this._dead) return;
    if (this.transport.isOpen) this._send({ t: this.isHost ? 'end' : 'bye' });
    this._failJoin('Left before joining.');
    this._teardown();
  }

  // ---------------------------------------------------------------------------
  // Incoming
  // ---------------------------------------------------------------------------

  _handle(from, m) {
    if (this._dead || !isId(from) || !isObj(m) || typeof m.t !== 'string') return;
    if (this.isHost) this._handleAsHost(from, m);
    else this._handleAsClient(from, m);
  }

  _handleAsHost(from, m) {
    const l = this.lobby;
    if (!l) return;
    const p = this._player(from);
    switch (m.t) {
      case 'hello': {
        if (p) {
          // Retry from someone already in: their lobby copy got lost, resend it.
          this._send({ t: 'lobby', l }, from);
          return;
        }
        if (m.v !== PROTOCOL_VERSION) return this._send({ t: 'reject', why: 'version', v: PROTOCOL_VERSION }, from);
        if (l.phase !== 'lobby') return this._send({ t: 'reject', why: 'started' }, from);
        if (l.players.length >= MAX_PLAYERS) return this._send({ t: 'reject', why: 'full' }, from);
        l.players.push({ id: from, name: cleanName(m.name), design: cleanDesign(m.design), ready: false, isHost: false });
        this._broadcastLobby();
        return;
      }
      case 'ready':
        if (p && typeof m.r === 'boolean' && p.ready !== m.r) { p.ready = m.r; this._broadcastLobby(); }
        return;
      case 'profile':
        if (!p) return;
        if (m.name !== undefined) p.name = cleanName(m.name);
        if (m.design !== undefined) p.design = cleanDesign(m.design);
        this._broadcastLobby();
        return;
      case 'bye':
        this._peerGone(from);
        return;
      case 'st':
      case 'fin':
      case 'ev':
        if (p) this._handleRace(from, m);
        return;
      default:
        // 'lobby', 'start', 'res', 'end' from a non-host are ignored on purpose.
    }
  }

  _handleAsClient(from, m) {
    const hostId = this._hostId();
    // Before we've seen a lobby we don't know the host; a lobby that names its sender as
    // host and carries our code is how we learn it.
    if (m.t === 'lobby') {
      if (!this._validLobby(m.l) || m.l.hostId !== from || m.l.code !== this.code) return;
      if (hostId && hostId !== from) return;
      this._acceptLobby(m.l);
      return;
    }
    if (m.t === 'reject') {
      if (this._joinPending) this._failJoin(rejectMessage(m.why, this.code, m.v));
      return;
    }
    if (!hostId) return; // not joined yet: ignore race traffic

    switch (m.t) {
      case 'start':
        if (from !== hostId || !Array.isArray(m.roster)) return;
        if (this.lobby) this.lobby.phase = 'racing';
        this._dispatch('start', this._startDetail(m));
        return;
      case 'res':
        if (from === hostId) this._dispatch('results', { results: m.r });
        return;
      case 'end':
        if (from === hostId) this._fatal('The host left the race.');
        return;
      case 'st':
      case 'fin':
      case 'ev':
        if (from === hostId || this._player(from)) this._handleRace(from, m);
        return;
      default:
    }
  }

  _handleRace(from, m) {
    if (m.t === 'st') {
      if (!Array.isArray(m.s)) return;
      const t = now();
      for (const e of m.s) {
        if (Array.isArray(e) && isId(e[0]) && isObj(e[1])) this._dispatch('state', { id: e[0], snap: e[1], from, t });
      }
    } else if (m.t === 'ev') {
      if (typeof m.y === 'string' && m.y.length <= 16 && isObj(m.d)) this._dispatch('game', { type: m.y, data: m.d, from });
    } else if (m.t === 'fin') {
      if (isId(m.id) && isNum(m.time)) {
        this._dispatch('finish', { id: m.id, time: m.time, bestLap: isNum(m.bestLap) ? m.bestLap : null });
      }
    }
  }

  _acceptLobby(l) {
    const prev = this.lobby;
    // Players the host dropped since the last lobby: surface them as 'peer-left'.
    if (prev) {
      const ids = new Set(l.players.map((p) => p.id));
      for (const p of prev.players) {
        if (!ids.has(p.id) && p.id !== this.selfId) this._dispatch('peer-left', { id: p.id, name: p.name });
      }
    }
    const inLobby = l.players.some((p) => p.id === this.selfId);
    if (this._joinPending) {
      // The host may rebroadcast before processing our hello; wait for a lobby that has us.
      if (!inLobby) return;
      const { resolve } = this._joinPending;
      this._joinPending = null;
      this.lobby = l;
      this._lobbyChanged();
      resolve(l);
      return;
    }
    if (!inLobby && prev) {
      // The host dropped us (e.g. a heartbeat timeout). Treat it as a lost connection.
      this.lobby = l;
      this._fatal('You were disconnected from the race.');
      return;
    }
    this.lobby = l;
    this._lobbyChanged();
  }

  _validLobby(l) {
    if (!isObj(l) || typeof l.code !== 'string' || !isId(l.hostId)) return false;
    if (l.phase !== 'lobby' && l.phase !== 'racing') return false;
    if (!Array.isArray(l.players) || l.players.length > MAX_PLAYERS) return false;
    return l.players.every((p) => isObj(p) && isId(p.id) && typeof p.name === 'string');
  }

  /** A peer disappeared from the transport (or said bye). */
  _peerGone(peerId) {
    if (this._dead) return;
    if (this.isHost) {
      const l = this.lobby;
      const i = l ? l.players.findIndex((p) => p.id === peerId) : -1;
      if (i < 0) return;
      const [gone] = l.players.splice(i, 1);
      this._broadcastLobby();
      this._dispatch('peer-left', { id: gone.id, name: gone.name });
    } else if (peerId === this._hostId()) {
      this._fatal('The host left the race.');
    }
    // Other clients leaving are reported via the host's next lobby (see _acceptLobby).
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _sendHello() {
    this._send({ t: 'hello', v: PROTOCOL_VERSION, name: this._name, design: this._design });
  }

  _send(msg, to) {
    if (!this._dead) this.transport.send(msg, to);
  }

  _broadcastLobby() {
    this._send({ t: 'lobby', l: this.lobby });
    this._lobbyChanged();
  }

  _lobbyChanged() {
    const json = JSON.stringify(this.lobby);
    if (json === this._lastLobbyJson) return;
    this._lastLobbyJson = json;
    this._dispatch('lobby', this.lobby);
  }

  _startDetail(m) {
    return {
      seed: m.seed, trackId: m.trackId, laps: m.laps, roster: m.roster, countdownMs: m.countdownMs, startedAt: now(),
      game: m.game === 'battle' ? 'battle' : 'race', target: cleanInt(m.target, 1, 99, 10), timeLimit: cleanInt(m.timeLimit, 30, 3600, 300),
      teams: m.teams === true,
      hazards: cleanLevel(m.hazards, 0.6),
    };
  }

  _hostId() { return this.lobby?.hostId ?? null; }
  _player(id) { return this.lobby?.players.find((p) => p.id === id) ?? null; }

  _cleanLaps(v, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 99 ? n : fallback;
  }

  _cleanAiFill(v, fallback) {
    // Booleans or a target player count are both accepted; the game decides what it means.
    return typeof v === 'boolean' || isNum(v) ? v : fallback;
  }

  _hostOnly(what) {
    if (this.isHost && this.lobby && !this._dead) return true;
    this._dispatch('error', { message: `Only the host can ${what}.` });
    return false;
  }

  _assertFresh() {
    if (this._dead) throw new Error('This session has ended. Create a new NetSession.');
    if (this.transport.isOpen || this.code) throw new Error('This session is already hosting or joining a race.');
  }

  _failJoin(message) {
    if (!this._joinPending) return;
    const { reject } = this._joinPending;
    this._joinPending = null;
    this._teardown();
    reject(new Error(message));
  }

  /** Unrecoverable: tell the game and shut down. Dispatched at most once. */
  _fatal(reason) {
    if (this._dead) return;
    if (this._joinPending) { this._failJoin(reason); return; }
    this._teardown();
    this._dispatch('closed', { reason });
  }

  _teardown() {
    if (this._dead) return;
    this._dead = true;
    for (const h of this._timers) { clearTimeout(h); clearInterval(h); }
    this._timers.clear();
    this.transport.removeEventListener('message', this._onMessage);
    this.transport.removeEventListener('peer-left', this._onPeerLeft);
    this.transport.removeEventListener('closed', this._onClosed);
    this.transport.close();
  }

  _every(ms, fn) { const h = setInterval(fn, ms); this._timers.add(h); return h; }
  _after(ms, fn) {
    const h = setTimeout(() => { this._timers.delete(h); fn(); }, ms);
    this._timers.add(h);
    return h;
  }
  _clear(h) { clearTimeout(h); clearInterval(h); this._timers.delete(h); }

  _dispatch(type, detail) {
    // A throwing listener must not break the network handler that called us.
    try { emit(this, type, detail); } catch (err) { console.error(`[starwake/net] '${type}' listener threw:`, err); }
  }
}

/** Hazard level: one of 0 / 0.3 / 0.6 / 1. */
function cleanLevel(v, fallback) {
  const n = Number(v);
  return [0, 0.3, 0.6, 1].includes(n) ? n : fallback;
}

function cleanInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}
