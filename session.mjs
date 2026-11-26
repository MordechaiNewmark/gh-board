// Sign-in sessions. The access key is typed once; the browser then holds a random token that the server can expire
// and revoke. Only the token's hash is stored. A session ends after IDLE_S without use, MAX_S after sign-in,
// on sign out, on "sign out everywhere", or when the key it was created with stops being valid.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const IDLE_S = 12 * 3600;
export const MAX_S = 7 * 86400;
export const TRIES = 10; // sign-in attempts per address
export const WINDOW_S = 15 * 60; // ...in this long
export const COOKIE = 'ghbs';

const sha = (v) => createHash('sha256').update(String(v)).digest();
const entry = (name) => `gh-board:${name}`;
const sessionEntry = (token) => entry(`session:${sha(token).toString('hex')}`);

export const sessionCookie = (token, secure) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? MAX_S : 0}${secure ? '; Secure' : ''}`;
export const readSessionCookie = (header = '') => new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(header)?.[1] || '';

/** Who a sign-in attempt is counted against. Forwarding headers count only when a proxy on this machine, or the platform, set them. */
export function clientAddress(req, hosted = false) {
  const socket = req.socket?.remoteAddress || '';
  const viaProxy = hosted || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return (viaProxy && ((hosted && req.headers['x-real-ip']) || forwarded)) || socket || 'unknown';
}

/** For the board on your own computer: entries in a file, so a restart does not sign everyone out. */
export function fileStore(file, now = Date.now) {
  let rows = {};
  try { rows = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const live = (k) => (rows[k] && (!rows[k].x || rows[k].x > now()) ? rows[k] : null);
  const save = () => {
    for (const k of Object.keys(rows)) if (!live(k)) delete rows[k];
    writeFileSync(`${file}.tmp`, JSON.stringify(rows), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  const put = (k, v, x) => { rows[k] = { v: String(v), x }; save(); };
  return {
    get: async (keys) => keys.map((k) => live(k)?.v ?? null),
    set: async (k, v, ttl) => put(k, v, now() + ttl * 1000),
    del: async (k) => { delete rows[k]; save(); },
    /** Add one to a counter that disappears `ttl` seconds after it started (no ttl: it stays). */
    count: async (k, ttl) => { const have = live(k); const n = Number(have?.v || 0) + 1; put(k, n, have ? have.x : ttl ? now() + ttl * 1000 : 0); return n; },
  };
}

/** For the hosted board: every instance sees the same sessions. `command` runs one Redis command. */
export const redisStore = (command) => ({
  get: async (keys) => command(['MGET', ...keys]),
  set: async (k, v, ttl) => { await command(['SET', k, v, 'EX', String(ttl)]); },
  del: async (k) => { await command(['DEL', k]); },
  count: async (k, ttl) => {
    if (ttl) await command(['SET', k, '0', 'EX', String(ttl), 'NX']);
    const n = Number(await command(['INCR', k]));
    if (ttl && n === 1) await command(['EXPIRE', k, String(ttl)]); // it expired between the two: never leave a counter forever
    return n;
  },
});

/** @param {{ store: ReturnType<typeof fileStore>, keys: () => string[], now?: () => number }} o  keys = the access keys valid right now */
export function createSessions({ store, keys, now = Date.now }) {
  const seconds = () => Math.floor(now() / 1000);
  const valid = () => keys().filter(Boolean);
  const mark = (key) => sha(`session-key:${key}`).toString('hex').slice(0, 32);

  /** { token } on success, { locked: true } after too many attempts, {} for a wrong key. */
  async function signIn(given, address) {
    const tries = entry(`signin:${sha(address).toString('hex').slice(0, 32)}`);
    // Counted before the key is looked at, so parallel guesses cannot slip past the limit.
    if ((await store.count(tries, WINDOW_S)) > TRIES) return { locked: true };
    const key = given && valid().find((k) => timingSafeEqual(sha(given), sha(k)));
    if (!key) return {};
    await store.del(tries);
    const token = randomBytes(32).toString('base64url');
    const [epoch] = await store.get([entry('epoch')]);
    await store.set(sessionEntry(token), JSON.stringify({ c: seconds(), s: seconds(), k: mark(key), e: epoch || '0' }), IDLE_S);
    return { token };
  }

  /** Is this session still good? `touch` counts the request as use (background refreshes do not). */
  async function check(token, { touch = true } = {}) {
    if (!token) return false;
    const id = sessionEntry(token);
    const [raw, epoch] = await store.get([id, entry('epoch')]);
    if (!raw) return false;
    let r; try { r = JSON.parse(raw); } catch { return false; }
    const t = seconds();
    if (!(t - r.c < MAX_S && t - r.s < IDLE_S && r.e === (epoch || '0') && valid().some((k) => mark(k) === r.k))) { await store.del(id); return false; }
    if (touch && t - r.s >= 60) await store.set(id, JSON.stringify({ ...r, s: t }), Math.min(IDLE_S, r.c + MAX_S - t));
    return true;
  }

  const signOut = async (token) => { if (token) await store.del(sessionEntry(token)); };
  const signOutAll = async () => { await store.count(entry('epoch')); };

  return { signIn, check, signOut, signOutAll };
}
