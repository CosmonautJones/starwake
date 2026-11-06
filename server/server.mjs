// Starwake dev server: static files for the game + a WebSocket relay for multiplayer.
//
//   node server/server.mjs          (or `npm start`)
//   PORT=9000 HOST=127.0.0.1 node server/server.mjs
//
// The relay is deliberately dumb: it groups sockets into rooms and forwards JSON
// between them. All game logic (lobby, ready flags, race start) lives in the host's
// browser (js/net/session.js). Wire format:
//   client -> relay : { msg, to? }
//   relay -> client : { from, msg } | { sys:'peers', peers } | { sys:'joined', peer } | { sys:'left', peer }

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PEERS = 8;
const MAX_MSG_BYTES = 32 * 1024;
const PING_MS = 15000;
const ROOM_RE = /^[A-Z]{4}$/;
const PEER_RE = /^[a-z0-9]{4,16}$/;

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
// Static files
// ---------------------------------------------------------------------------

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE });
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
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, ...NO_CACHE });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

function createRelay() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES * 2 });
  /** @type {Map<string, Map<string, import('ws').WebSocket>>} room -> peerId -> socket */
  const rooms = new Map();

  const sendJson = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  wss.on('connection', (ws, req, { room, peer }) => {
    let members = rooms.get(room);
    if (!members) rooms.set(room, (members = new Map()));
    if (members.size >= MAX_PEERS) return ws.close(4001, 'Room full');
    if (members.has(peer)) return ws.close(4002, 'Duplicate peer id');

    members.set(peer, ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    sendJson(ws, { sys: 'peers', peers: [...members.keys()].filter((id) => id !== peer) });
    for (const [id, other] of members) if (id !== peer) sendJson(other, { sys: 'joined', peer });

    ws.on('message', (data, isBinary) => {
      if (isBinary || data.length > MAX_MSG_BYTES) return; // drop oversized / binary frames
      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!m || typeof m !== 'object' || !('msg' in m)) return;
      const out = JSON.stringify({ from: peer, msg: m.msg });
      if (typeof m.to === 'string') {
        const target = members.get(m.to);
        if (target && m.to !== peer && target.readyState === target.OPEN) target.send(out);
        return;
      }
      for (const [id, other] of members) if (id !== peer && other.readyState === other.OPEN) other.send(out);
    });

    ws.on('close', () => {
      if (members.get(peer) !== ws) return;
      members.delete(peer);
      for (const other of members.values()) sendJson(other, { sys: 'left', peer });
      if (members.size === 0) rooms.delete(room);
    });
    ws.on('error', () => { /* 'close' follows; nothing to do */ });
  });

  // Keepalive: a socket that misses one ping round is assumed dead (sleeping laptop, Wi-Fi drop).
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, PING_MS);
  pinger.unref?.();

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { url = null; }
    if (!url || url.pathname !== '/relay') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const room = url.searchParams.get('room') || '';
    const peer = url.searchParams.get('peer') || '';
    if (!ROOM_RE.test(room) || !PEER_RE.test(peer)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { room, peer }));
  }

  function close() {
    clearInterval(pinger);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { handleUpgrade, close, rooms };
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
 * Start the server. Resolves with { server, port, url, close() } once listening.
 * Pass port 0 for a random free port (used by tools/test-net.mjs).
 */
export function start({ port = Number(process.env.PORT) || 8080, host = process.env.HOST || '0.0.0.0', quiet = false } = {}) {
  const relay = createRelay();
  const server = http.createServer(serveStatic);
  server.on('upgrade', relay.handleUpgrade);
  server.on('clientError', (err, socket) => socket.destroy());

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      const url = `http://localhost:${actual}/`;
      if (!quiet) {
        console.log(`\n  Starwake is running at ${url}`);
        const lan = host === '0.0.0.0' || host === '::' ? lanAddresses() : [];
        if (lan.length) {
          console.log(`  Friends on your network can join at ${lan.map((ip) => `http://${ip}:${actual}/`).join(' or ')}`);
        }
        console.log(`  Multiplayer relay: ws://localhost:${actual}/relay\n  Press Ctrl+C to stop.\n`);
      }
      resolve({
        server,
        port: actual,
        url,
        close: () => new Promise((done) => { relay.close(); server.closeAllConnections?.(); server.close(() => done()); }),
      });
    });
  });
}

// Run directly: `node server/server.mjs`
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().catch((err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${err.port} is already in use. Try PORT=8081 npm start`);
    else console.error(err);
    process.exit(1);
  });
}
