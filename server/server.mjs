// Starwake server: static files for the game + a WebSocket relay for multiplayer.
//
//   node server/server.mjs          (or `npm start`)
//   PORT=9000 HOST=127.0.0.1 node server/server.mjs
//   RELAY_ONLY=1 node server/server.mjs      relay + /healthz only, no game files
//
// Environment (all optional):
//   PORT, HOST          where to listen (default 8080 on 0.0.0.0; hosts like Render set PORT)
//   RELAY_ONLY=1        don't serve the game's files (for a relay hosted apart from the game)
//   ALLOWED_ORIGINS     comma-separated pages allowed to open a relay socket, e.g.
//                       "https://travisjohnjones.com,https://*.netlify.app". Entries may omit
//                       the scheme ("example.com") or use "*" to allow any site. Pages served
//                       by this server are always allowed. Default: localhost, travisjohnjones.com.
//   MAX_ROOMS           rooms open at once (default 500)
//   MAX_PEERS           players per room (default 8)
//   MAX_MSG_BYTES       largest message a client may send (default 64 KiB)
//   MSG_RATE, MSG_BURST messages per second per socket, and the burst allowance (200 / 400)
//   PING_MS             keepalive interval (default 25000). A socket that misses a ping is dropped.
//
// The relay is deliberately dumb: it groups sockets into rooms and forwards JSON
// between them. All game logic (lobby, ready flags, race start) lives in the host's
// browser (js/net/session.js). Wire format:
//   client -> relay : { msg, to? } | { sys:'ping', n }
//   relay -> client : { from, msg } | { sys:'peers', peers } | { sys:'joined', peer } | { sys:'left', peer } | { sys:'pong', n }
//
// Close codes the relay uses (the client turns them into messages):
//   4001 room full · 4002 duplicate peer id · 4003 origin not allowed · 4004 relay full
//   4008 too many messages · 1009 message too big · 1001 server shutting down

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM_RE = /^[A-Z]{4}$/;
const PEER_RE = /^[a-z0-9]{4,16}$/;

export const DEFAULT_ORIGINS = ['localhost', '127.0.0.1', '[::1]', 'travisjohnjones.com', 'www.travisjohnjones.com'];

export const DEFAULTS = {
  maxRooms: 500,
  maxPeers: 8,
  maxMsgBytes: 64 * 1024,
  msgRate: 200,
  msgBurst: 400,
  pingMs: 25000,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const NO_CACHE = { 'Cache-Control': 'no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const posInt = (v, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Parse a comma-separated origin list. Empty or missing means "use the defaults". */
export function parseOrigins(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Relay options from environment variables (see the header comment). */
export function configFromEnv(env = process.env) {
  return {
    relayOnly: env.RELAY_ONLY === '1' || env.RELAY_ONLY === 'true',
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    maxRooms: posInt(env.MAX_ROOMS, DEFAULTS.maxRooms),
    maxPeers: posInt(env.MAX_PEERS, DEFAULTS.maxPeers),
    maxMsgBytes: posInt(env.MAX_MSG_BYTES, DEFAULTS.maxMsgBytes),
    msgRate: posInt(env.MSG_RATE, DEFAULTS.msgRate),
    msgBurst: posInt(env.MSG_BURST, DEFAULTS.msgBurst),
    pingMs: posInt(env.PING_MS, DEFAULTS.pingMs),
  };
}

const PATTERN_RE = /^(?:(https?):\/\/)?(\*\.)?(\[[0-9a-f:.]+\]|[^/:*[\]]+)(?::(\d+))?\/?$/i;

/**
 * May a page at `origin` open a relay socket? `host` is the request's Host header, so pages
 * this server serves itself are always allowed. A missing Origin means a non-browser client
 * (tests, bots); browsers always send one, and Origin only guards against other websites.
 */
export function originAllowed(origin, host, patterns = DEFAULT_ORIGINS) {
  if (origin === undefined || origin === '') return true;
  let u;
  try { u = new URL(origin); } catch { return false; } // includes the literal "null" (file://, sandboxed frames)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (host && u.host.toLowerCase() === String(host).toLowerCase()) return true;
  const hostname = u.hostname.toLowerCase();
  for (const p of patterns || DEFAULT_ORIGINS) {
    if (p === '*') return true;
    const m = PATTERN_RE.exec(p);
    if (!m) continue;
    const [, scheme, wild, base, port] = m;
    if (scheme && `${scheme.toLowerCase()}:` !== u.protocol) continue;
    if (port && port !== (u.port || (u.protocol === 'https:' ? '443' : '80'))) continue;
    const b = base.toLowerCase();
    if (wild ? hostname.endsWith(`.${b}`) : hostname === b) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE, ...extra });
  res.end(text);
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendText(res, 405, 'Method not allowed');
  }
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (rel.includes('\0')) return sendText(res, 400, 'Bad request');
  if (rel.endsWith('/')) rel += 'index.html';

  // Resolve against ROOT and make sure we're still inside it (blocks ../ and absolute tricks).
  const file = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return sendText(res, 404, 'Not found');
  // Never expose dependencies' internals or dotfiles (.git, .env) from a LAN-visible server.
  const parts = path.relative(ROOT, file).split(path.sep);
  if (parts.some((p) => p.startsWith('.')) || parts[0] === 'node_modules') return sendText(res, 404, 'Not found');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // Server-Timing tells the page (via performance.getEntriesByType('navigation')) that a relay
    // lives on this host, so a static copy of the game elsewhere doesn't guess wrong.
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Server-Timing': 'starwake-relay', ...NO_CACHE });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export function createRelay(opts = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)) };
  const origins = opts.allowedOrigins || DEFAULT_ORIGINS;
  const log = opts.log || (() => {});
  // ws closes the socket with 1009 for anything bigger than maxPayload, before we parse it.
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxMsgBytes, perMessageDeflate: false });
  /** @type {Map<string, Map<string, import('ws').WebSocket>>} room -> peerId -> socket */
  const rooms = new Map();
  const stats = { started: Date.now(), connections: 0, rejected: 0 };

  const sendJson = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const peerCount = () => { let n = 0; for (const m of rooms.values()) n += m.size; return n; };

  /** Token bucket: true if this message may pass. Kicks sockets that keep flooding. */
  function allowMessage(ws) {
    const t = Date.now();
    const rl = ws.rl;
    rl.tokens = Math.min(cfg.msgBurst, rl.tokens + ((t - rl.last) * cfg.msgRate) / 1000);
    rl.last = t;
    if (t - rl.winStart >= 1000) { rl.winStart = t; rl.dropped = 0; }
    if (rl.tokens >= 1) { rl.tokens -= 1; return true; }
    rl.dropped++;
    if (rl.dropped > cfg.msgRate && !rl.kicked) {
      rl.kicked = true;
      log(`kick ${ws.room}/${ws.peer}: too many messages`);
      ws.close(4008, 'Too many messages');
    }
    return false;
  }

  wss.on('connection', (ws, req, { room, peer }) => {
    stats.connections++;
    let members = rooms.get(room);
    if (!members) {
      if (rooms.size >= cfg.maxRooms) { stats.rejected++; log(`reject ${room}: relay full (${rooms.size} rooms)`); return ws.close(4004, 'Relay full'); }
      rooms.set(room, (members = new Map()));
    }
    if (members.size >= cfg.maxPeers) { stats.rejected++; return ws.close(4001, 'Room full'); }
    if (members.has(peer)) { stats.rejected++; return ws.close(4002, 'Duplicate peer id'); }

    members.set(peer, ws);
    ws.room = room;
    ws.peer = peer;
    ws.isAlive = true;
    ws.rl = { tokens: cfg.msgBurst, last: Date.now(), winStart: Date.now(), dropped: 0, kicked: false };
    ws.on('pong', () => { ws.isAlive = true; });
    if (members.size === 1) log(`room ${room} opened (${rooms.size} rooms, ${peerCount()} peers)`);

    sendJson(ws, { sys: 'peers', peers: [...members.keys()].filter((id) => id !== peer) });
    for (const [id, other] of members) if (id !== peer) sendJson(other, { sys: 'joined', peer });

    ws.on('message', (data, isBinary) => {
      ws.isAlive = true; // any traffic proves the peer is there
      if (!allowMessage(ws)) return;
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.sys === 'ping') { sendJson(ws, { sys: 'pong', n: Number.isFinite(m.n) ? m.n : 0 }); return; }
      if (!('msg' in m)) return;
      const out = JSON.stringify({ from: peer, msg: m.msg });
      if (typeof m.to === 'string') {
        const target = members.get(m.to);
        if (target && m.to !== peer && target.readyState === target.OPEN) target.send(out);
        return;
      }
      for (const [id, other] of members) if (id !== peer && other.readyState === other.OPEN) other.send(out);
    });

    ws.on('close', (code) => {
      if (code === 1009) log(`kick ${room}/${peer}: message too big`);
      if (members.get(peer) !== ws) return;
      members.delete(peer);
      for (const other of members.values()) sendJson(other, { sys: 'left', peer });
      if (members.size === 0 && rooms.get(room) === members) {
        rooms.delete(room);
        log(`room ${room} closed (${rooms.size} rooms, ${peerCount()} peers)`);
      }
    });
    ws.on('error', () => { /* 'close' follows; nothing to do */ });
  });

  // Keepalive: ping every socket; one that hasn't answered (or sent anything) since the last
  // round is dead (sleeping laptop, Wi-Fi drop) and gets dropped, which frees its room slot.
  // The traffic also keeps idle proxies (Render, Fly, Cloudflare) from cutting the socket.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { log(`drop ${ws.room}/${ws.peer}: no reply to ping`); ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
    // Belt and braces: forget rooms whose sockets are all gone.
    for (const [code, members] of rooms) {
      for (const [id, s] of members) if (s.readyState === s.CLOSED) members.delete(id);
      if (members.size === 0) rooms.delete(code);
    }
  }, cfg.pingMs);
  pinger.unref?.();

  const refuse = (socket, status, text) => {
    stats.rejected++;
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { url = null; }
    if (!url || url.pathname !== '/relay') return refuse(socket, 404, 'Not Found');
    const room = url.searchParams.get('room') || '';
    const peer = url.searchParams.get('peer') || '';
    if (!ROOM_RE.test(room) || !PEER_RE.test(peer)) return refuse(socket, 400, 'Bad Request');
    const origin = req.headers.origin;
    if (!originAllowed(origin, req.headers.host, origins)) {
      // Complete the handshake and close with a code, so the game can say why instead of
      // a generic "couldn't connect". Nothing is relayed for this socket.
      log(`reject origin ${String(origin).slice(0, 100)}`);
      stats.rejected++;
      return wss.handleUpgrade(req, socket, head, (ws) => ws.close(4003, 'Origin not allowed'));
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { room, peer }));
  }

  /** Close every socket. `code` 1001 tells clients the server is going away. */
  function close(code) {
    clearInterval(pinger);
    for (const ws of wss.clients) {
      if (code) { try { ws.close(code, 'Server restarting'); } catch { ws.terminate(); } } else ws.terminate();
    }
    wss.close();
  }

  const info = () => ({ ok: true, service: 'starwake-relay', rooms: rooms.size, peers: peerCount(), uptime: Math.round((Date.now() - stats.started) / 1000) });

  return { handleUpgrade, close, rooms, info, wss };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * Start the server. Resolves with { server, port, url, relay, close() } once listening.
 * Pass port 0 for a random free port (used by tools/test-net.mjs). Any relay option
 * (maxRooms, pingMs, allowedOrigins, ...) can be passed here; unset ones come from env.
 */
export function start(options = {}) {
  const env = configFromEnv();
  const {
    port = Number(process.env.PORT) || 8080,
    host = process.env.HOST || '0.0.0.0',
    quiet = false,
    ...rest
  } = options;
  const cfg = { ...env, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
  const log = quiet ? () => {} : (msg) => console.log(`[relay] ${msg}`);
  const relay = createRelay({ ...cfg, log });

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* serveStatic answers 400 */ }
    if (pathname === '/healthz') {
      // Readable cross-origin so a static copy of the game can wake a sleeping relay and check it.
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...NO_CACHE });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(relay.info()));
    }
    if (cfg.relayOnly) {
      if (pathname === '/') return sendText(res, 200, 'Starwake relay. Games connect over WebSocket at /relay.\n');
      return sendText(res, 404, 'Not found');
    }
    serveStatic(req, res);
  });
  server.on('upgrade', relay.handleUpgrade);
  server.on('clientError', (err, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      const url = `http://localhost:${actual}/`;
      if (!quiet) {
        if (cfg.relayOnly) console.log(`\n  Starwake relay on port ${actual} (relay only, no game files)`);
        else console.log(`\n  Starwake is running at ${url}`);
        const lan = host === '0.0.0.0' || host === '::' ? lanAddresses() : [];
        if (lan.length && !cfg.relayOnly) {
          console.log(`  Friends on your network can join at ${lan.map((ip) => `http://${ip}:${actual}/`).join(' or ')}`);
        }
        console.log(`  Multiplayer relay: ws://localhost:${actual}/relay`);
        console.log(`  Allowed origins: this server${cfg.allowedOrigins ? `, ${cfg.allowedOrigins.join(', ')}` : `, ${DEFAULT_ORIGINS.join(', ')}`}\n  Press Ctrl+C to stop.\n`);
      }
      let closing = null;
      resolve({
        server,
        port: actual,
        url,
        relay,
        close: (code) => closing || (closing = new Promise((done) => {
          relay.close(code);
          server.closeAllConnections?.();
          server.close(() => done());
        })),
      });
    });
  });
}

// Run directly: `node server/server.mjs`
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().then((srv) => {
    // Hosts send SIGTERM before a redeploy: tell players the server is restarting, then exit.
    const stop = (sig) => {
      console.log(`[relay] ${sig}, shutting down`);
      const t = setTimeout(() => process.exit(0), 3000);
      t.unref();
      srv.close(1001).then(() => process.exit(0));
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${err.port} is already in use. Try PORT=8081 npm start`);
    else console.error(err);
    process.exit(1);
  });
}
