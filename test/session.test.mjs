// Session expiry, revocation and the sign-in limit, with a controlled clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessions, fileStore, clientAddress, IDLE_S, MAX_S, TRIES, WINDOW_S } from '../session.mjs';

const KEY = 'session-test-access-key-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'ghb-s-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function setup() {
  let t = 1_800_000_000_000;
  const clock = { pass: (s) => (t += s * 1000) };
  const keys = [KEY];
  const file = join(dir, `${++n}.json`);
  const make = () => createSessions({ store: fileStore(file, () => t), keys: () => keys, now: () => t });
  return { clock, keys, file, make, s: make() };
}

test('a session token is random, is not the key, and only its hash is stored', async () => {
  const { s, file, make } = setup();
  const a = (await s.signIn(KEY, 'ip')).token; const b = (await s.signIn(KEY, 'ip')).token;
  assert.notEqual(a, b);
  const disk = readFileSync(file, 'utf8');
  for (const secret of [KEY, a, b]) assert.ok(!disk.includes(secret));
  assert.equal(await make().check(a), true, 'survives a restart');
  assert.equal(await s.check(KEY), false);
  assert.equal(await s.check('made-up-token-000000000000'), false);
});

test('idle: use keeps it alive, background refreshes do not', async () => {
  const { s, clock } = setup();
  const used = (await s.signIn(KEY, 'ip')).token; const polled = (await s.signIn(KEY, 'ip')).token;
  for (let i = 0; i < 3; i++) { clock.pass(IDLE_S - 100); assert.equal(await s.check(used), true); if (i === 0) assert.equal(await s.check(polled, { touch: false }), true); }
  assert.equal(await s.check(polled, { touch: false }), false);
  clock.pass(IDLE_S + 1);
  assert.equal(await s.check(used), false);
});

test('absolute limit: constant use still ends', async () => {
  const { s, clock } = setup();
  const { token } = await s.signIn(KEY, 'ip');
  for (let spent = 3600; spent < MAX_S; spent += 3600) { clock.pass(3600); assert.equal(await s.check(token), true); }
  clock.pass(3600);
  assert.equal(await s.check(token), false);
});

test('sign out, sign out everywhere, and a changed key', async () => {
  const { s, keys } = setup();
  const sign = async () => (await s.signIn(keys[0], 'ip')).token;
  const [a, b] = [await sign(), await sign()];
  await s.signOut(a);
  assert.deepEqual([await s.check(a), await s.check(b)], [false, true]);
  await s.signOutAll();
  assert.equal(await s.check(b), false);
  const c = await sign();
  assert.equal(await s.check(c), true);
  keys[0] = 'a-different-access-key-9876543210';
  assert.equal(await s.check(c), false);
});

test('too many attempts lock that address out for a while, the right key included', async () => {
  const { s, clock } = setup();
  const open = (await s.signIn(KEY, 'victim')).token;
  for (let i = 0; i < TRIES; i++) assert.deepEqual(await s.signIn('wrong', 'guesser'), {});
  assert.deepEqual(await s.signIn(KEY, 'guesser'), { locked: true });
  assert.ok((await s.signIn(KEY, 'someone-else')).token);
  assert.equal(await s.check(open), true, 'open sessions are unaffected');
  clock.pass(WINDOW_S + 1);
  assert.ok((await s.signIn(KEY, 'guesser')).token);
});

test('the counted address cannot be chosen by a direct caller', () => {
  const req = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
  assert.equal(clientAddress(req('203.0.113.5', { 'x-forwarded-for': '1.1.1.1' })), '203.0.113.5');
  assert.equal(clientAddress(req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1, 100.64.0.9' })), '100.64.0.9');
  assert.equal(clientAddress(req('10.0.0.1', { 'x-real-ip': '198.51.100.7' }), true), '198.51.100.7');
});
