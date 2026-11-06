// Network transports for Starwake multiplayer.
//
// A Transport moves small JSON-able messages between the peers of one "room".
// It knows nothing about lobbies or races; NetSession (session.js) builds that on top.
//
//   BroadcastTransport  - tabs of the same browser (BroadcastChannel). Zero setup.
//   WsTransport         - any machines, via the WebSocket relay in server/server.mjs.
//
// Both work in the browser and in Node 22+ (which has global BroadcastChannel and
// WebSocket), so the networking can be tested headlessly with tools/test-net.mjs.
//
// Events (all carry their payload in event.detail):
//   'message'     { from, msg }
//   'peer-joined' { peerId }
//   'peer-left'   { peerId }
//   'closed'      { reason }   - only for unexpected loss; close() itself is silent

const HEARTBEAT_MS = 1000;
const PEER_TIMEOUT_MS = 20000; // generous: a closed tab says 'bye'; silence only means a crash or a long freeze (loading a match on a slow machine)
const CONNECT_TIMEOUT_MS = 4000;

// CustomEvent exists in browsers and Node 19+; fall back to Event + .detail just in case.
const DetailEvent = typeof CustomEvent === 'function'
  ? CustomEvent
  : class extends Event {
    constructor(type, init = {}) { super(type); this.detail = init.detail ?? null; }
  };

/** Dispatch a CustomEvent-style event with `detail` on any EventTarget. */
export function emit(target, type, detail) {
  target.dispatchEvent(new DetailEvent(type, { detail }));
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random lowercase alphanumeric id (matches the relay's [a-z0-9]{4,16} rule). */
export function randomId(len = 8) {
  const bytes = new Uint8Array(len);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

/** Base class. Subclasses implement open/send/close. */
export class Transport extends EventTarget {
  constructor() {
    super();
    this.selfId = randomId(8);
    this.room = null;
    this.isOpen = false;
  }

  /** Join `room`. Resolves when messages can be sent. */
  async open(room) { throw new Error('Transport.open() not implemented'); } // eslint-disable-line no-unused-vars

  /** Send `msg` to every other peer in the room, or only to peer `to` if given. */
  send(msg, to) {} // eslint-disable-line no-unused-vars

  /** Leave the room. Safe to call more than once. */
  close() {}

  _emit(type, detail) { emit(this, type, detail); }
}

// ---------------------------------------------------------------------------
// Same-browser transport
// ---------------------------------------------------------------------------

/**
 * Envelopes on the channel:
 *   { from, msg, to? }  data
 *   { from, sys:'hb' }  heartbeat (every second)
 *   { from, sys:'bye' } clean leave
 * Any envelope from a peer counts as a sign of life. A peer silent for more than
 * PEER_TIMEOUT_MS (closed tab, crashed tab) is reported as 'peer-left'.
 */
export class BroadcastTransport extends Transport {
  constructor() {
    super();
    this._ch = null;
    this._peers = new Map(); // peerId -> last heard (ms)
    this._hbTimer = null;
  }

  async open(room) {
    if (this._ch) throw new Error('Transport is already open.');
    if (typeof BroadcastChannel !== 'function') {
      throw new Error("This browser can't do same-browser races (no BroadcastChannel). Use the relay server instead.");
    }
    this.room = room;
    this._ch = new BroadcastChannel(`starwake-room-${room}`);
    this._ch.onmessage = (e) => this._onEnvelope(e.data);
    this._hbTimer = setInterval(() => this._tick(), HEARTBEAT_MS);
    this.isOpen = true;
    this._post({ from: this.selfId, sys: 'hb' }); // announce ourselves right away
  }

  send(msg, to) {
    if (!this._ch) return;
    const env = { from: this.selfId, msg };
    if (to) env.to = to;
    this._post(env);
  }

  close() {
    if (!this._ch) return;
    this._post({ from: this.selfId, sys: 'bye' });
    clearInterval(this._hbTimer);
    this._hbTimer = null;
    this._ch.onmessage = null;
    this._ch.close();
    this._ch = null;
    this._peers.clear();
    this.isOpen = false;
  }

  _post(env) {
    try {
      this._ch.postMessage(env);
    } catch (err) {
      // Only fails for non-cloneable payloads, which is a caller bug; don't crash the game loop.
      console.warn('[starwake/net] BroadcastChannel post failed:', err);
    }
  }

  _onEnvelope(env) {
    if (!env || typeof env !== 'object' || typeof env.from !== 'string' || !env.from) return;
    const from = env.from;
    if (from === this.selfId) return;

    if (env.sys === 'bye') {
      if (this._peers.delete(from)) this._emit('peer-left', { peerId: from });
      return;
    }
    if (!this._peers.has(from)) {
      this._peers.set(from, Date.now());
      this._emit('peer-joined', { peerId: from });
    } else {
      this._peers.set(from, Date.now());
    }
    if (env.sys) return; // heartbeat
    if (env.to && env.to !== this.selfId) return; // addressed to someone else
    if ('msg' in env) this._emit('message', { from, msg: env.msg });
  }

  _tick() {
    if (!this._ch) return;
    this._post({ from: this.selfId, sys: 'hb' });
    const now = Date.now();
    // If *this* tab stalled (e.g. building a race, or the tab was throttled), our view of
    // everyone else is stale too — don't blame them. Give peers a fresh grace period.
    const gap = this._lastTick ? now - this._lastTick : 0;
    this._lastTick = now;
    if (gap > HEARTBEAT_MS * 2.5) {
      for (const id of this._peers.keys()) this._peers.set(id, now);
      return;
    }
    for (const [id, seen] of this._peers) {
      if (now - seen > PEER_TIMEOUT_MS) {
        this._peers.delete(id);
        this._emit('peer-left', { peerId: id });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket relay transport
// ---------------------------------------------------------------------------

/**
 * Wire format (see server/server.mjs):
 *   client -> relay : { msg, to? }
 *   relay -> client : { from, msg } | { sys:'peers', peers:[...] } | { sys:'joined', peer } | { sys:'left', peer }
 * open() resolves once the relay has confirmed the join with its 'peers' list.
 */
export class WsTransport extends Transport {
  constructor(relayUrl) {
    super();
    this.relayUrl = relayUrl || 'ws://localhost:8080/relay';
    this._ws = null;
    this._closing = false;
    this._peers = new Set();
    this._abortOpen = null;
  }

  open(room) {
    if (this._ws) return Promise.reject(new Error('Transport is already open.'));
    this.room = room;
    this._closing = false;
    const unreachable = `Couldn't reach the relay server at ${this.relayUrl}. Start it with \`npm start\`, or pick 'This browser' mode.`;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let ws;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._abortOpen = null;
        this._detach(ws);
        reject(new Error(message));
      };
      // close() during the handshake must still settle this promise.
      this._abortOpen = () => fail('The connection was cancelled.');

      if (typeof WebSocket !== 'function') {
        fail("This environment has no WebSocket support, so it can't reach the relay server.");
        return;
      }
      try {
        const sep = this.relayUrl.includes('?') ? '&' : '?';
        ws = new WebSocket(`${this.relayUrl}${sep}room=${encodeURIComponent(room)}&peer=${encodeURIComponent(this.selfId)}`);
      } catch {
        fail(unreachable); // malformed URL etc.
        return;
      }
      this._ws = ws;
      timer = setTimeout(() => fail(unreachable), CONNECT_TIMEOUT_MS);

      ws.onmessage = (e) => {
        let data;
        try { data = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)); } catch { return; }
        if (!data || typeof data !== 'object') return;
        if (data.sys === 'peers' && !settled) {
          settled = true;
          clearTimeout(timer);
          this._abortOpen = null;
          this.isOpen = true;
          resolve();
        }
        this._onRelay(data);
      };
      ws.onerror = () => {
        // Before open: fail fast instead of waiting out the timeout. After open, 'close' follows.
        if (!settled) fail(unreachable);
      };
      ws.onclose = (e) => {
        if (!settled) {
          if (e.code === 4001) fail('That race is full (8 players max).');
          else if (e.code === 4002) fail('Connection rejected by the relay (duplicate player id). Try again.');
          else fail(unreachable);
          return;
        }
        const wasOpen = this.isOpen;
        this._detach(ws);
        if (wasOpen && !this._closing) this._emit('closed', { reason: 'Lost connection to the relay server.' });
      };
    });
  }

  send(msg, to) {
    const ws = this._ws;
    if (!ws || !this.isOpen || ws.readyState !== 1 /* OPEN */) return;
    const out = to ? { to, msg } : { msg };
    try { ws.send(JSON.stringify(out)); } catch (err) { console.warn('[starwake/net] relay send failed:', err); }
  }

  close() {
    if (this._abortOpen) this._abortOpen(); // rejects a pending open() and detaches
    if (!this._ws) return;
    this._closing = true;
    const ws = this._ws;
    this._detach(ws);
    try { ws.close(1000, 'bye'); } catch { /* already closing */ }
  }

  _detach(ws) {
    if (ws) { ws.onmessage = ws.onerror = ws.onclose = null; }
    if (ws && ws.readyState === 0 /* CONNECTING */) {
      // Closing a CONNECTING socket is allowed; it just aborts the handshake.
      try { ws.close(); } catch { /* ignore */ }
    }
    if (this._ws === ws) this._ws = null;
    this.isOpen = false;
    this._peers.clear();
  }

  _onRelay(data) {
    switch (data.sys) {
      case 'peers':
        if (!Array.isArray(data.peers)) return;
        for (const p of data.peers) {
          if (typeof p === 'string' && p !== this.selfId && !this._peers.has(p)) {
            this._peers.add(p);
            this._emit('peer-joined', { peerId: p });
          }
        }
        return;
      case 'joined':
        if (typeof data.peer === 'string' && data.peer !== this.selfId && !this._peers.has(data.peer)) {
          this._peers.add(data.peer);
          this._emit('peer-joined', { peerId: data.peer });
        }
        return;
      case 'left':
        if (typeof data.peer === 'string' && this._peers.delete(data.peer)) {
          this._emit('peer-left', { peerId: data.peer });
        }
        return;
      case undefined:
        if (typeof data.from === 'string' && data.from !== this.selfId && 'msg' in data) {
          this._emit('message', { from: data.from, msg: data.msg });
        }
        return;
      default:
        // Unknown system message from a newer relay: ignore.
    }
  }
}

/**
 * Best guess for the relay URL. When the game is served by server/server.mjs the relay
 * lives on the same host at /relay. Artifact hosts (claude.ai, claudeusercontent) and
 * file:// pages can't host one, so fall back to a local server.
 */
export function defaultRelayUrl(location) {
  const fallback = 'ws://localhost:8080/relay';
  if (!location || typeof location.protocol !== 'string' || !location.host) return fallback;
  const { protocol, host, hostname = '' } = location;
  if (protocol !== 'http:' && protocol !== 'https:') return fallback;
  if (/(^|\.)claude\.ai$/i.test(hostname) || /claudeusercontent/i.test(hostname)) return fallback;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/relay`;
}
