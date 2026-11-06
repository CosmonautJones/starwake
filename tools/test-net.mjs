// Automated test for the multiplayer layer (js/net/*, server/server.mjs).
//
//   node tools/test-net.mjs
//
// Part A runs NetSessions over BroadcastTransport inside this process (Node 22 has a
// global BroadcastChannel). Part B starts the real server on a random port and runs the
// same flow over the WebSocket relay. Exits non-zero if anything fails.

import { NetSession, PROTOCOL_VERSION } from '../js/net/session.js';
import { WsTransport, defaultRelayUrl } from '../js/net/transport.js';
import { start as startServer } from '../server/server.mjs';

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

process.on('unhandledRejection', (err) => { failures++; console.log(`FAIL  unhandled rejection: ${err?.stack || err}`); });

const t0 = Date.now();
const watchdog = setTimeout(() => { console.log('FAIL  test run exceeded 30s'); process.exit(1); }, 30000);
try {
  await partA();
  await partB();
} catch (err) {
  failures++;
  console.log(`FAIL  crashed: ${err?.stack || err}`);
}
clearTimeout(watchdog);
console.log(`\n${passes} passed, ${failures} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
// Exit explicitly: if a timer or channel leaked, that's a bug, but it shouldn't hang CI.
process.exit(failures ? 1 : 0);
