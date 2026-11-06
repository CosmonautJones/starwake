// Online play helpers: which relay to use, invite links, and waking a sleeping relay.
// Pure functions (no DOM) so tools/test-net.mjs can check them in Node.

import { RELAY_URL } from '../config.js';

export const LOCAL_RELAY = 'ws://localhost:8080/relay';
const CODE_RE = /^[A-Z]{4}$/;
/** Sent by server/server.mjs on every file it serves (Server-Timing is readable from page JS). */
export const RELAY_MARK = 'starwake-relay';

export function isLocalHostname(h) {
  const s = String(h || '').toLowerCase();
  return s === 'localhost' || s.endsWith('.localhost') || s === '127.0.0.1' || s === '[::1]' || s === '::1';
}

const isClaudeHost = (h) => /(^|\.)claude\.ai$/i.test(h) || /claudeusercontent/i.test(h);

/**
 * Turn what a person (or a link) gave as a relay address into a ws(s):// URL, or null.
 * "relay.example.com" -> "wss://relay.example.com/relay"; https:// becomes wss://.
 */
export function normalizeRelayUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
    s = (isLocalHostname(host) ? 'ws://' : 'wss://') + s;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === 'http:') u = new URL('ws:' + u.href.slice(5));
  else if (u.protocol === 'https:') u = new URL('wss:' + u.href.slice(6));
  if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !u.hostname) return null;
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/relay';
  u.hash = '';
  return u.href;
}

/**
 * Was this page served by server/server.mjs (so a relay lives at /relay on the same host)?
 * The server marks its responses with a Server-Timing entry. Browsers only expose that in
 * secure contexts, so for plain http pages (a LAN address) we assume yes, as before.
 */
export function servedByRelay(g = globalThis) {
  const loc = g.location;
  if (!loc || (loc.protocol !== 'http:' && loc.protocol !== 'https:')) return false;
  let entries;
  try { entries = g.performance?.getEntriesByType?.('navigation')?.[0]?.serverTiming; } catch { entries = undefined; }
  if (g.isSecureContext !== false && Array.isArray(entries)) return entries.some((e) => e?.name === RELAY_MARK);
  return loc.protocol === 'http:';
}

/**
 * Pick the relay. Order: the player's own setting, a ?relay= URL param, js/config.js
 * RELAY_URL, the same host when the page came from the relay server, then a localhost
 * relay for local development. Returns { url, source }; url is null (source 'none') when
 * the page is on a static host with nothing configured, i.e. online play isn't set up.
 */
export function resolveRelayUrl({ setting = '', search = '', config = RELAY_URL, location = null, served = false } = {}) {
  let param = null;
  try { param = new URLSearchParams(search || '').get('relay'); } catch { /* ignore */ }
  for (const [value, source] of [[setting, 'setting'], [param, 'param'], [config, 'config']]) {
    const url = normalizeRelayUrl(value);
    if (url) return { url, source };
  }
  const proto = location?.protocol;
  if ((proto === 'http:' || proto === 'https:') && location.host && served && !isClaudeHost(location.hostname || '')) {
    return { url: `${proto === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`, source: 'same-origin' };
  }
  if (!location || !location.host || proto === 'file:' || isLocalHostname(location.hostname) || isClaudeHost(location.hostname || '')) {
    return { url: LOCAL_RELAY, source: 'local' };
  }
  return { url: null, source: 'none' };
}

/** Normalised 4-letter room code, or null. */
export function cleanRoomCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

/**
 * Invite link for a room: <page>?join=CODE, plus &relay= when the relay came from the URL
 * (so a friend's copy uses the same one) and &net=tabs for same-browser lobbies.
 */
export function inviteLink({ location, code, relay = null, kind = 'relay' }) {
  const c = cleanRoomCode(code);
  if (!c || !location) return null;
  const path = location.pathname || '/';
  const base = `${location.origin}${path.endsWith('/') ? `${path}index.html` : path}`;
  const q = new URLSearchParams({ join: c });
  if (relay) q.set('relay', relay);
  if (kind === 'tabs') q.set('net', 'tabs');
  return `${base}?${q}`;
}

/** Read an invite from a query string: { code, relay, kind } or null. */
export function parseInvite(search) {
  let q;
  try { q = new URLSearchParams(search || ''); } catch { return null; }
  const code = cleanRoomCode(q.get('join'));
  if (!code) return null;
  return { code, relay: normalizeRelayUrl(q.get('relay')), kind: q.get('net') === 'tabs' ? 'tabs' : 'relay' };
}

/** The relay's /healthz URL (same host, http(s)). */
export function relayHealthUrl(relayUrl) {
  try {
    const u = new URL(relayUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : null;
    return proto ? `${proto}//${u.host}/healthz` : null;
  } catch {
    return null;
  }
}

const warmed = new Set();
/**
 * Free hosts put an idle relay to sleep. Poke /healthz as soon as the player opens the
 * multiplayer screen so it's awake by the time they press Host or Join. Best effort.
 */
export function warmRelay(relayUrl) {
  const url = relayHealthUrl(relayUrl);
  if (!url || warmed.has(url) || typeof fetch !== 'function') return;
  warmed.add(url);
  fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' }).catch(() => warmed.delete(url));
}
