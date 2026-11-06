// Automated test for the multiplayer layer (js/net/*, server/server.mjs).
//
//   node tools/test-net.mjs
//
// Part A runs NetSessions over BroadcastTransport inside this process (Node 22 has a
// global BroadcastChannel). Part B starts the real server on a random port and runs the
// same flow over the WebSocket relay. Part C covers the hosted relay (origin allowlist,
// rate and size limits, keepalive, RELAY_ONLY) and the online helpers (relay URL order,
// invite links). Exits non-zero if anything fails.

import WS, { WebSocketServer } from 'ws';
import { NetSession, PROTOCOL_VERSION } from '../js/net/session.js';
import { WsTransport, defaultRelayUrl, closeReason } from '../js/net/transport.js';
import { resolveRelayUrl, normalizeRelayUrl, inviteLink, parseInvite, servedByRelay, relayHealthUrl, LOCAL_RELAY } from '../js/net/online.js';
import { start as startServer, originAllowed, configFromEnv } from '../server/server.mjs';

let failures = 0;
let passes = 0;

function check(label, cond, extra = '') {
  if (cond) { passes++; console.log(`PASS  ${label}`); } else { failures++; console.log(`FAIL  ${label}${extra ? `  (${extra})` : ''}`); }
}

/** Resolve with the first event of `type` on `target` whose detail satisfies `pred`. */
function waitFor(target, type, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.removeEventListener(type, on); reject(new Error(`timed out waiting for '${type}'`)); }, ms);
    function on(e) {
      if (!pred(e.detail)) return;
      clearTimeout(timer);
      target.removeEventListener(type, on);
      resolve(e.detail);
    }
    target.addEventListener(type, on);
  });
}

/** Run an async step; a thrown error becomes a FAIL line instead of aborting the whole run. */
async function step(label, fn) {
  try {
    const ok = await fn();
    check(label, ok !== false);
  } catch (err) {
    check(label, false, err?.message || String(err));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const design = (body) => ({ body, wings: 'swept', engines: 'twin', colors: { primary: '#ff4400' } });

/** Host + client through the whole lobby -> race -> results -> lobby -> host leaves cycle. */
async function coreFlow(tag, opts) {
  const host = new NetSession({ ...opts, name: '  Hosty McHost  ', design: design('dart') });
  const client = new NetSession({ ...opts, name: 'A very long pilot name indeed', design: design('bike') });
  const sessions = [host, client];
  try {
    let code;
    await step(`${tag}: host() returns a 4-letter code`, async () => {
      code = await host.host({ trackId: 'nebula', laps: 3, aiFill: true });
      return /^[A-HJ-NP-Z]{4}$/.test(code) && host.isHost && host.code === code && host.lobby.players.length === 1;
    });

    await step(`${tag}: join() resolves with a synced lobby (and lowercase code works)`, async () => {
      const hostSees2 = waitFor(host, 'lobby', (l) => l.players.length === 2);
      const l = await client.join(code.toLowerCase());
      await hostSees2;
      const me = l.players.find((p) => p.id === client.selfId);
      return l === client.lobby && l.hostId === host.selfId && l.trackId === 'nebula' && l.laps === 3
        && me && !me.ready && !client.isHost && client.code === code
        && me.design.body === 'bike';
    });

    await step(`${tag}: names are trimmed to 16 chars`, () => {
      const names = client.lobby.players.map((p) => p.name);
      return names.includes('Hosty McHost') && names.includes('A very long pilo') && names.every((n) => n.length <= 16);
    });

    await step(`${tag}: canStart() false until client ready, then true after setReady`, async () => {
      const before = host.canStart();
      const got = waitFor(host, 'lobby', (l) => l.players.find((p) => p.id === client.selfId)?.ready === true);
      client.setReady(true);
      await got;
      return before === false && host.canStart() === true && client.canStart() === false;
    });

    await step(`${tag}: updateSettings reaches the client; non-host is refused`, async () => {
      const got = waitFor(client, 'lobby', (l) => l.laps === 5 && l.trackId === 'rings');
      host.updateSettings({ trackId: 'rings', laps: 5 });
      await got;
      const err = waitFor(client, 'error');
      const ok = client.updateSettings({ laps: 9 });
      await err;
      return ok === false && host.lobby.laps === 5;
    });

    await step(`${tag}: battle settings (mode, kill target, time) reach the client, junk is refused`, async () => {
      const got = waitFor(client, 'lobby', (l) => l.game === 'battle' && l.target === 15 && l.timeLimit === 480 && l.trackId === 'glacier');
      host.updateSettings({ game: 'battle', trackId: 'glacier', target: 15, timeLimit: 480 });
      await got;
      host.updateSettings({ game: 'golf', target: -3, timeLimit: 'soon' });
      return host.lobby.game === 'battle' && host.lobby.target === 15 && host.lobby.timeLimit === 480;
    });

    await step(`${tag}: battle start carries mode, target and time limit to everyone`, async () => {
      const hs = waitFor(host, 'start');
      const cs = waitFor(client, 'start');
      host.startRace({ seed: 77, roster: [], countdownMs: 0 });
      const [a, b] = await Promise.all([hs, cs]);
      const ok = a.game === 'battle' && b.game === 'battle' && b.target === 15 && b.timeLimit === 480 && b.trackId === 'glacier';
      const back = waitFor(client, 'lobby', (l) => l.phase === 'lobby');
      host.backToLobby();
      await back;
      host.updateSettings({ game: 'race', trackId: 'rings' });
      await waitFor(client, 'lobby', (l) => l.game === 'race' && l.trackId === 'rings');
      return ok;
    });

    await step(`${tag}: updateProfile from client is rebroadcast`, async () => {
      const got = waitFor(host, 'lobby', (l) => l.players.some((p) => p.name === 'Renamed' && p.design.body === 'glider'));
      client.updateProfile({ name: 'Renamed', design: design('glider') });
      await got;
      return true;
    });

    const roster = [
      { id: host.selfId, name: 'Hosty McHost', design: design('dart'), ai: false },
      { id: client.selfId, name: 'Renamed', design: design('glider'), ai: false },
      { id: 'ai-1', name: 'Bot', design: design('arrow'), ai: true },
    ];
    await step(`${tag}: startRace -> both host and client get 'start'`, async () => {
      const hs = waitFor(host, 'start');
      const cs = waitFor(client, 'start');
      host.startRace({ seed: 1234, roster, countdownMs: 3000 });
      const [a, b] = await Promise.all([hs, cs]);
      return a.seed === 1234 && b.seed === 1234 && b.trackId === 'rings' && b.laps === 5
        && b.roster.length === 3 && b.countdownMs === 3000 && typeof b.startedAt === 'number'
        && client.lobby.phase === 'racing';
    });

    await step(`${tag}: sendStates both directions, one 'state' event per entry`, async () => {
      const got = [];
      const on = (e) => got.push(e.detail);
      client.addEventListener('state', on);
      const done = waitFor(client, 'state', (d) => d.id === 'ai-1');
      host.sendStates([
        { id: host.selfId, snap: { p: [1, 2, 3], v: 40 } },
        { id: 'ai-1', snap: { p: [4, 5, 6], v: 38 } },
        { id: 'bad' }, // malformed: no snap -> dropped
      ]);
      await done;
      client.removeEventListener('state', on);
      const back = waitFor(host, 'state', (d) => d.id === client.selfId);
      client.sendStates([{ id: client.selfId, snap: { p: [7, 8, 9], v: 41 } }]);
      const h = await back;
      return got.length === 2 && got[0].from === host.selfId && got[0].snap.v === 40 && typeof got[0].t === 'number'
        && h.from === client.selfId && h.snap.p[2] === 9;
    });

    await step(`${tag}: sendFinish reaches the host`, async () => {
      const got = waitFor(host, 'finish');
      client.sendFinish({ id: client.selfId, time: 93.21, bestLap: 30.5 });
      const f = await got;
      return f.id === client.selfId && f.time === 93.21 && f.bestLap === 30.5;
    });

    await step(`${tag}: sendResults reaches the client`, async () => {
      const got = waitFor(client, 'results');
      host.sendResults([{ id: client.selfId, place: 1 }, { id: host.selfId, place: 2 }]);
      const r = await got;
      return Array.isArray(r.results) && r.results[0].place === 1;
    });

    await step(`${tag}: backToLobby resets phase and ready flags`, async () => {
      const got = waitFor(client, 'lobby', (l) => l.phase === 'lobby');
      host.backToLobby();
      const l = await got;
      return l.players.every((p) => p.isHost || p.ready === false) && host.canStart() === false;
    });

    await step(`${tag}: malformed messages are ignored`, async () => {
      // Inject junk straight through the client's transport; nothing should throw or change.
      for (const junk of [null, 42, 'x', [], { t: 'lobby' }, { t: 'lobby', l: { code: 1 } }, { t: 'st', s: 'nope' },
        { t: 'st', s: [[1, 2]] }, { t: 'fin', id: 'x' }, { t: 'hello' }, { t: 'ready', r: 'yes' }]) {
        client.transport.send(junk);
      }
      await sleep(150);
      return host.lobby.players.length === 2 && host.lobby.phase === 'lobby';
    });

    await step(`${tag}: host leave -> client gets 'closed' ("The host left the race.")`, async () => {
      const got = waitFor(client, 'closed');
      host.leave();
      const c = await got;
      return c.reason === 'The host left the race.';
    });
    return code;
  } finally {
    for (const s of sessions) s.leave();
  }
}

/** Joining a code nobody is hosting rejects with the friendly message after ~4s. */
async function noSuchRoom(tag, opts) {
  await step(`${tag}: join to a non-existent room rejects in ~4s with a clear message`, async () => {
    const s = new NetSession({ ...opts, name: 'Lost' });
    const t0 = Date.now();
    try {
      await s.join('QQQZ');
      return false;
    } catch (err) {
      const dt = Date.now() - t0;
      if (!/^No race found with code QQQZ\. Check the code/.test(err.message)) throw new Error(`message: ${err.message}`);
      if (dt < 3500 || dt > 5500) throw new Error(`took ${dt}ms`);
      return true;
    } finally {
      s.leave();
    }
  });
}

async function partA() {
  console.log('\n--- A: BroadcastTransport (same browser) ---');
  const opts = { kind: 'tabs' };
  await Promise.all([coreFlow('tabs', opts), noSuchRoom('tabs', opts)]);

  // Lobby limits: 8 players, no joining mid-race, version mismatch.
  const host = new NetSession({ ...opts, name: 'Host' });
  const extras = [];
  try {
    const code = await host.host({ trackId: 'nebula', laps: 2, aiFill: false });
    await step('tabs: 7 clients can join (8 total)', async () => {
      for (let i = 0; i < 7; i++) extras.push(new NetSession({ ...opts, name: `P${i}` }));
      await Promise.all(extras.map((s) => s.join(code)));
      await sleep(50);
      return host.lobby.players.length === 8 && extras.every((s) => s.lobby.players.length === 8);
    });
    await step('tabs: 9th player is rejected with a "full" message', async () => {
      const s = new NetSession({ ...opts, name: 'Ninth' });
      try { await s.join(code); return false; } catch (err) { return /full/i.test(err.message); } finally { s.leave(); }
    });
    await step('tabs: client leave -> host gets peer-left and drops them', async () => {
      const gone = extras.pop();
      const got = waitFor(host, 'peer-left', (d) => d.id === gone.selfId);
      const others = waitFor(extras[0], 'peer-left', (d) => d.id === gone.selfId);
      gone.leave();
      const d = await got;
      await others;
      return d.name === 'P6' && host.lobby.players.length === 7;
    });
    await step('tabs: joining after the race started is rejected', async () => {
      host.startRace({ seed: 1, roster: [], countdownMs: 0 });
      const s = new NetSession({ ...opts, name: 'Late' });
      try { await s.join(code); return false; } catch (err) { return /already started/i.test(err.message); } finally { s.leave(); }
    });
    await step('tabs: protocol version mismatch is rejected with a message', async () => {
      host.backToLobby();
      const s = new NetSession({ ...opts, name: 'Old' });
      s._sendHello = function () { this._send({ t: 'hello', v: PROTOCOL_VERSION + 99, name: 'Old', design: null }); };
      try { await s.join(code); return false; } catch (err) { return /version/i.test(err.message) && /reload/i.test(err.message); } finally { s.leave(); }
    });
  } finally {
    host.leave();
    for (const s of extras) s.leave();
  }
}

async function partB() {
  console.log('\n--- B: WebSocket relay (server/server.mjs) ---');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  const relayUrl = `ws://127.0.0.1:${srv.port}/relay`;
  const opts = { kind: 'relay', relayUrl };
  try {
    await Promise.all([coreFlow('relay', opts), noSuchRoom('relay', opts)]);

    await step('relay: client leave -> host gets peer-left', async () => {
      const host = new NetSession({ ...opts, name: 'H' });
      const c = new NetSession({ ...opts, name: 'C' });
      try {
        const code = await host.host({});
        await c.join(code);
        const got = waitFor(host, 'peer-left', (d) => d.id === c.selfId);
        c.leave();
        await got;
        return host.lobby.players.length === 1;
      } finally { host.leave(); c.leave(); }
    });

    await step('relay: server shutdown -> client gets "Lost connection" closed event', async () => {
      // Separate server so the main one keeps running for the static checks below.
      const srv2 = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
      const o2 = { kind: 'relay', relayUrl: `ws://127.0.0.1:${srv2.port}/relay` };
      const host = new NetSession({ ...o2, name: 'H' });
      try {
        await host.host({});
        const got = waitFor(host, 'closed');
        await srv2.close();
        const d = await got;
        return d.reason === 'Lost connection to the relay server.';
      } finally { host.leave(); }
    });

    await step('relay: unreachable relay rejects with the friendly message', async () => {
      const t = new WsTransport('ws://127.0.0.1:1/relay');
      try { await t.open('ABCD'); return false; } catch (err) {
        return err.message.startsWith("Couldn't reach the relay server at ws://127.0.0.1:1/relay. Start it with `npm start`");
      } finally { t.close(); }
    });

    await step('relay: 9th socket in a room is closed with 4001 Room full', async () => {
      const ts = Array.from({ length: 8 }, () => new WsTransport(relayUrl));
      try {
        await Promise.all(ts.map((t) => t.open('FULL')));
        const ninth = new WsTransport(relayUrl);
        try { await ninth.open('FULL'); return false; } catch (err) { return /full/i.test(err.message); } finally { ninth.close(); }
      } finally { ts.forEach((t) => t.close()); }
    });

    await step('relay: invalid room/peer params are refused', async () => {
      const res = await new Promise((resolve) => {
        const ws = new WebSocket(`${relayUrl}?room=abc&peer=X!`);
        ws.onopen = () => { ws.close(); resolve('opened'); };
        ws.onerror = () => resolve('refused');
      });
      return res === 'refused';
    });

    await step('static: index.html (or js/net/session.js) served with the right MIME', async () => {
      const r1 = await fetch(`${srv.url}index.html`);
      if (r1.status === 200) return /text\/html/.test(r1.headers.get('content-type'));
      await r1.arrayBuffer();
      const r2 = await fetch(`${srv.url}js/net/session.js`);
      const body = await r2.text();
      return r2.status === 200 && /text\/javascript/.test(r2.headers.get('content-type'))
        && body.includes('class NetSession') && /no-store/.test(r2.headers.get('cache-control'));
    });

    await step('static: 404 for missing files, traversal and node_modules', async () => {
      const codes = [];
      // '..%2fstarwake%2fpackage.json' would only exist if '..' escaped the root (it gets clamped to it).
      for (const p of ['nope.js', '..%2fstarwake%2fpackage.json', '%2e%2e/%2e%2e/etc/passwd', 'node_modules/ws/package.json', '.git/config']) {
        const r = await fetch(`${srv.url}${p}`);
        await r.arrayBuffer();
        codes.push(r.status);
      }
      return codes.every((c) => c === 404) || (console.log('      codes:', codes), false);
    });

    await step('defaultRelayUrl picks same-host relay or localhost fallback', () => (
      defaultRelayUrl({ protocol: 'https:', host: 'race.example.com', hostname: 'race.example.com' }) === 'wss://race.example.com/relay'
      && defaultRelayUrl({ protocol: 'http:', host: '192.168.1.5:8080', hostname: '192.168.1.5' }) === 'ws://192.168.1.5:8080/relay'
      && defaultRelayUrl({ protocol: 'https:', host: 'abc.claudeusercontent.com', hostname: 'abc.claudeusercontent.com' }) === 'ws://localhost:8080/relay'
      && defaultRelayUrl({ protocol: 'https:', host: 'claude.ai', hostname: 'claude.ai' }) === 'ws://localhost:8080/relay'
      && defaultRelayUrl({ protocol: 'file:', host: '', hostname: '' }) === 'ws://localhost:8080/relay'
      && defaultRelayUrl(undefined) === 'ws://localhost:8080/relay'
    ));
  } finally {
    await srv.close();
  }
}

// ---------------------------------------------------------------------------
// C: hosted relay hardening + online helpers
// ---------------------------------------------------------------------------

/** Raw relay socket (the `ws` package, so tests can set Origin and turn off auto-pong). */
function raw(url, room, peer, opts = {}) {
  const ws = new WS(`${url}?room=${room}&peer=${peer}`, opts);
  const msgs = [];
  const opened = new Promise((resolve, reject) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      msgs.push(m);
      if (m.sys === 'peers') resolve(m);
    });
    ws.on('error', reject);
    ws.on('close', (code) => reject(new Error(`closed ${code} before joining`)));
  });
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  opened.catch(() => {});
  return { ws, msgs, opened, closed };
}
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timed out: ${what}`); })]);

async function partC() {
  console.log('\n--- C: hosted relay (origins, limits, keepalive) and online helpers ---');

  await step('origins: defaults allow localhost (any port), travisjohnjones.com, same host; refuse others', () => (
    originAllowed(undefined, 'x')
    && originAllowed('http://localhost:5173', 'relay.example')
    && originAllowed('http://127.0.0.1:8080', 'relay.example')
    && originAllowed('https://travisjohnjones.com', 'relay.example')
    && originAllowed('https://www.travisjohnjones.com', 'relay.example')
    && originAllowed('https://relay.example', 'relay.example')
    && !originAllowed('https://evil.example', 'relay.example')
    && !originAllowed('https://travisjohnjones.com.evil.example', 'relay.example')
    && !originAllowed('null', 'relay.example')
  ));

  await step('origins: ALLOWED_ORIGINS patterns (scheme, port, *.wildcard, *)', () => {
    const pats = ['https://game.example', '*.netlify.app', 'http://lan.example:9000'];
    return originAllowed('https://game.example', 'h', pats)
      && !originAllowed('http://game.example', 'h', pats)
      && originAllowed('https://deploy-preview-3--site.netlify.app', 'h', pats)
      && !originAllowed('https://netlify.app.evil.example', 'h', pats)
      && originAllowed('http://lan.example:9000', 'h', pats)
      && !originAllowed('http://lan.example:9001', 'h', pats)
      && !originAllowed('http://localhost:8080', 'h', pats)
      && originAllowed('https://anything.example', 'h', ['*']);
  });

  await step('config: env vars parse, junk falls back to defaults', () => {
    const c = configFromEnv({ RELAY_ONLY: '1', ALLOWED_ORIGINS: ' a.example , https://b.example ', MAX_ROOMS: '7', MSG_RATE: 'lots', PING_MS: '-5' });
    const d = configFromEnv({});
    return c.relayOnly && c.allowedOrigins.join('|') === 'a.example|https://b.example' && c.maxRooms === 7
      && c.msgRate === 200 && c.pingMs === 25000 && !d.relayOnly && d.allowedOrigins === null;
  });

  const srv = await startServer({
    port: 0, host: '127.0.0.1', quiet: true,
    allowedOrigins: ['https://friends.example'], msgRate: 10, msgBurst: 10, maxMsgBytes: 1024, maxRooms: 3, pingMs: 150,
  });
  const url = `ws://127.0.0.1:${srv.port}/relay`;
  try {
    await step('origin: allowed page joins; same-host page joins', async () => {
      const a = raw(url, 'ORIG', 'peer0001', { origin: 'https://friends.example' });
      const b = raw(url, 'ORIG', 'peer0002', { origin: `http://127.0.0.1:${srv.port}` });
      try { await within(Promise.all([a.opened, b.opened]), 2000, 'join'); return true; } finally { a.ws.close(); b.ws.close(); }
    });

    await step('origin: other page is closed with 4003 and a clear message', async () => {
      const c = raw(url, 'ORIG', 'peer0003', { origin: 'https://evil.example' });
      const code = await within(c.closed, 2000, 'close');
      return code === 4003 && /doesn't accept games from this site/.test(closeReason(4003, false)) && c.msgs.length === 0;
    });

    await step('rate limit: a burst over the allowance is trimmed, a flood is kicked (4008)', async () => {
      const a = raw(url, 'RATE', 'peer0001');
      const b = raw(url, 'RATE', 'peer0002');
      try {
        await within(Promise.all([a.opened, b.opened]), 2000, 'join');
        await sleep(50);
        const before = b.msgs.length;
        for (let i = 0; i < 15; i++) a.ws.send(JSON.stringify({ msg: { i } }));
        await sleep(150);
        const got = b.msgs.length - before;
        if (got < 10 || got > 12) throw new Error(`burst delivered ${got}`);
        for (let i = 0; i < 60; i++) a.ws.send(JSON.stringify({ msg: { i } }));
        const code = await within(a.closed, 2000, 'kick');
        return code === 4008 && /too much data/.test(closeReason(4008, true));
      } finally { a.ws.close(); b.ws.close(); }
    });

    await step('max message size: an oversized message closes the sender (1009), the room hears it left', async () => {
      const a = raw(url, 'SIZE', 'peer0001');
      const b = raw(url, 'SIZE', 'peer0002');
      try {
        await within(Promise.all([a.opened, b.opened]), 2000, 'join');
        a.ws.send(JSON.stringify({ msg: 'x'.repeat(2000) }));
        const code = await within(a.closed, 2000, 'close');
        await sleep(50);
        return code === 1009 && b.msgs.some((m) => m.sys === 'left' && m.peer === 'peer0001') && !b.msgs.some((m) => m.from);
      } finally { a.ws.close(); b.ws.close(); }
    });

    await step('max rooms: a new room past the limit is refused with "busy"', async () => {
      const ts = ['RMAA', 'RMAB', 'RMAC'].map((r) => { const t = new WsTransport(url); return [t, t.open(r)]; });
      try {
        await Promise.all(ts.map(([, p]) => p));
        const extra = new WsTransport(url);
        try { await extra.open('RMAD'); return false; } catch (err) { return /busy/.test(err.message); } finally { extra.close(); }
      } finally { ts.forEach(([t]) => t.close()); }
    });

    await step('rooms are cleaned up when their last peer leaves', async () => {
      await sleep(100);
      return srv.relay.rooms.size === 0;
    });

    await step('keepalive: a socket that stops answering pings is dropped, a live one stays', async () => {
      const dead = raw(url, 'KEEP', 'peer0001', { autoPong: false });
      const live = raw(url, 'KEEP', 'peer0002');
      try {
        await within(Promise.all([dead.opened, live.opened]), 2000, 'join');
        await within(dead.closed, 1500, 'reap');
        await sleep(400); // several more ping rounds
        return live.ws.readyState === WS.OPEN && live.msgs.some((m) => m.sys === 'left' && m.peer === 'peer0001');
      } finally { dead.ws.terminate(); live.ws.close(); }
    });

    await step('relay ping: WsTransport measures a round trip through the relay', async () => {
      const t = new WsTransport(url, { pingMs: 50 });
      try { await t.open('PING'); await sleep(120); return typeof t.rtt === 'number' && t.rtt >= 0 && t.rtt < 500; } finally { t.close(); }
    });

    await step('healthz: JSON status, readable cross-origin', async () => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
      const j = await r.json();
      return r.status === 200 && j.ok === true && j.service === 'starwake-relay' && typeof j.rooms === 'number'
        && r.headers.get('access-control-allow-origin') === '*';
    });

    await step('static files carry the Server-Timing relay mark', async () => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/js/net/online.js`);
      await r.arrayBuffer();
      return r.status === 200 && /starwake-relay/.test(r.headers.get('server-timing') || '');
    });
  } finally {
    await srv.close();
  }

  await step('RELAY_ONLY: no game files, but /, /healthz and the relay work', async () => {
    const s2 = await startServer({ port: 0, host: '127.0.0.1', quiet: true, relayOnly: true });
    try {
      const codes = [];
      for (const p of ['index.html', 'js/net/session.js', '', 'healthz']) {
        const r = await fetch(`http://127.0.0.1:${s2.port}/${p}`);
        await r.arrayBuffer();
        codes.push(r.status);
      }
      const t = new WsTransport(`ws://127.0.0.1:${s2.port}/relay`);
      try { await t.open('ONLY'); } finally { t.close(); }
      return codes.join(',') === '404,404,200,200' || (console.log('      codes:', codes), false);
    } finally { await s2.close(); }
  });

  await step('shutdown with 1001: clients are told the server restarted', async () => {
    const s3 = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    const host = new NetSession({ kind: 'relay', relayUrl: `ws://127.0.0.1:${s3.port}/relay`, name: 'H' });
    try {
      await host.host({});
      const got = waitFor(host, 'closed');
      await s3.close(1001);
      return /restarted/.test((await got).reason);
    } finally { host.leave(); }
  });

  await step('relay silence: a relay that stops answering pings ends the session', async () => {
    // A fake relay that joins us, answers one ping, then goes quiet (a dead network path).
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    let pongs = 0;
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ sys: 'peers', peers: [] }));
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.sys === 'ping' && pongs++ < 1) ws.send(JSON.stringify({ sys: 'pong', n: m.n })); });
    });
    const t = new WsTransport(`ws://127.0.0.1:${wss.address().port}/relay`, { pingMs: 40, silenceMs: 200 });
    try {
      await t.open('DEAD');
      const c = await waitFor(t, 'closed', () => true, 2000);
      return /Lost connection/.test(c.reason) && !t.isOpen;
    } finally { t.close(); for (const c of wss.clients) c.terminate(); wss.close(); }
  });

  for (const tag of ['tabs', 'relay']) {
    const s4 = tag === 'relay' ? await startServer({ port: 0, host: '127.0.0.1', quiet: true }) : null;
    const opts = s4 ? { kind: 'relay', relayUrl: `ws://127.0.0.1:${s4.port}/relay` } : { kind: 'tabs' };
    await step(`${tag}: ping table reaches host and client; a silent host ends the client's session`, async () => {
      const host = new NetSession({ ...opts, name: 'H', pingMs: 50, hostSilenceMs: 400 });
      const client = new NetSession({ ...opts, name: 'C', pingMs: 50, hostSilenceMs: 400 });
      try {
        const code = await host.host({});
        const hostPing = waitFor(host, 'ping', (d) => typeof d.pings[client.selfId] === 'number', 2000);
        await client.join(code);
        await waitFor(client, 'ping', (d) => typeof d.pings[client.selfId] === 'number', 2000);
        await hostPing;
        if (host.pings[host.selfId] !== 0) throw new Error('host table');
        host._send = () => {}; // freeze the host without it saying goodbye
        const c = await waitFor(client, 'closed', () => true, 2000);
        return c.reason === 'Lost connection to the host.';
      } finally { host.leave(); client.leave(); }
    });
    if (s4) await s4.close();
  }

  await step('relay URLs: typed addresses are normalised; junk is refused', () => (
    normalizeRelayUrl('relay.example.com') === 'wss://relay.example.com/relay'
    && normalizeRelayUrl('https://relay.example.com') === 'wss://relay.example.com/relay'
    && normalizeRelayUrl('http://localhost:8080') === 'ws://localhost:8080/relay'
    && normalizeRelayUrl('localhost:9000') === 'ws://localhost:9000/relay'
    && normalizeRelayUrl('wss://r.example/custom') === 'wss://r.example/custom'
    && normalizeRelayUrl('  ') === null && normalizeRelayUrl('ftp://x.example') === null && normalizeRelayUrl('wss://') === null
  ));

  await step('relay URL order: setting > ?relay= > config > same host > localhost > none', () => {
    const portfolio = { protocol: 'https:', host: 'travisjohnjones.com', hostname: 'travisjohnjones.com' };
    const relayHost = { protocol: 'https:', host: 'sw.onrender.com', hostname: 'sw.onrender.com' };
    const local = { protocol: 'http:', host: 'localhost:3000', hostname: 'localhost' };
    const r = (o) => { const x = resolveRelayUrl(o); return `${x.source} ${x.url}`; };
    const cases = [
      [{ setting: 'wss://mine.example/relay', search: '?relay=wss://p.example', config: 'wss://c.example/relay', location: relayHost, served: true }, 'setting wss://mine.example/relay'],
      [{ setting: '', search: '?join=ABCD&relay=wss%3A%2F%2Fp.example', config: 'wss://c.example/relay', location: relayHost, served: true }, 'param wss://p.example/relay'],
      [{ search: '', config: 'wss://c.example/relay', location: relayHost, served: true }, 'config wss://c.example/relay'],
      [{ config: '', location: relayHost, served: true }, 'same-origin wss://sw.onrender.com/relay'],
      [{ config: '', location: { protocol: 'http:', host: 'localhost:9000', hostname: 'localhost' }, served: true }, 'same-origin ws://localhost:9000/relay'],
      [{ config: '', location: local, served: false }, `local ${LOCAL_RELAY}`],
      [{ config: '', location: null }, `local ${LOCAL_RELAY}`],
      [{ config: '', location: portfolio, served: false }, 'none null'],
      [{ config: 'wss://c.example/relay', location: portfolio, served: false }, 'config wss://c.example/relay'],
    ];
    const bad = cases.filter(([o, want]) => r(o) !== want);
    if (bad.length) throw new Error(bad.map(([o, want]) => `${want} != ${r(o)}`).join('; '));
    return true;
  });

  await step('servedByRelay reads the Server-Timing mark (assumes yes on insecure http)', () => {
    const g = (protocol, secure, entries) => ({
      location: { protocol }, isSecureContext: secure,
      performance: { getEntriesByType: () => [{ serverTiming: entries }] },
    });
    return servedByRelay(g('https:', true, [{ name: 'starwake-relay' }]))
      && !servedByRelay(g('https:', true, []))
      && servedByRelay(g('http:', false, undefined))
      && !servedByRelay(g('file:', true, []))
      && !servedByRelay({});
  });

  await step('invite links: build and parse, with relay param and same-browser flag', () => {
    const loc = { origin: 'https://travisjohnjones.com', pathname: '/starwake/index.html' };
    const a = inviteLink({ location: loc, code: 'abcd' });
    const b = inviteLink({ location: loc, code: 'WXYZ', relay: 'wss://r.example/relay' });
    const c = inviteLink({ location: { origin: 'http://localhost:8080', pathname: '/' }, code: 'QRST', kind: 'tabs' });
    const pb = parseInvite(new URL(b).search);
    const pc = parseInvite(new URL(c).search);
    return a === 'https://travisjohnjones.com/starwake/index.html?join=ABCD'
      && b.startsWith('https://travisjohnjones.com/starwake/index.html?join=WXYZ&relay=wss%3A%2F%2F')
      && c === 'http://localhost:8080/index.html?join=QRST&net=tabs'
      && pb.code === 'WXYZ' && pb.relay === 'wss://r.example/relay' && pb.kind === 'relay'
      && pc.code === 'QRST' && pc.kind === 'tabs' && pc.relay === null
      && parseInvite('?join=abcd').code === 'ABCD'
      && parseInvite('?join=AB1D') === null && parseInvite('?join=ABCDE') === null && parseInvite('') === null
      && inviteLink({ location: loc, code: 'nope!' }) === null;
  });

  await step('health URL derives from the relay URL', () => (
    relayHealthUrl('wss://sw.onrender.com/relay') === 'https://sw.onrender.com/healthz'
    && relayHealthUrl('ws://localhost:8080/relay') === 'http://localhost:8080/healthz'
    && relayHealthUrl('nope') === null
  ));
}

process.on('unhandledRejection', (err) => { failures++; console.log(`FAIL  unhandled rejection: ${err?.stack || err}`); });

const t0 = Date.now();
const watchdog = setTimeout(() => { console.log('FAIL  test run exceeded 30s'); process.exit(1); }, 30000);
try {
  await partA();
  await partB();
  await partC();
} catch (err) {
  failures++;
  console.log(`FAIL  crashed: ${err?.stack || err}`);
}
clearTimeout(watchdog);
console.log(`\n${passes} passed, ${failures} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
// Exit explicitly: if a timer or channel leaked, that's a bug, but it shouldn't hang CI.
process.exit(failures ? 1 : 0);
