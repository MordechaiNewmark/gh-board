// Hosted (Vercel) mode: the exported handler behind a plain server, talking to the mock GitHub and a mock model.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, TOK } from './mock.mjs';

const mock = await startMock();
// A stand-in for the Redis REST API: GET and SET on an in-memory map.
const DB_TOKEN = 'db-token-MOCK-0123456789';
const rows = new Map();
const db = http.createServer((req, res) => {
  let text = ''; req.on('data', (c) => (text += c));
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${DB_TOKEN}`) { res.writeHead(401); return res.end('{}'); }
    const [cmd, k, v] = JSON.parse(text);
    if (cmd === 'SET') rows.set(k, v);
    res.end(JSON.stringify({ result: cmd === 'SET' ? 'OK' : rows.get(k) ?? null }));
  });
});
await new Promise((r) => db.listen(0, '127.0.0.1', r));
const data = mkdtempSync(join(tmpdir(), 'ghb-h-'));
const KEY = 'hosted-test-access-key-0123456789';
for (const k of Object.keys(process.env)) if (/_API_KEY$/.test(k)) delete process.env[k];
Object.assign(process.env, { HOSTED: '1', ACCESS_KEY: KEY, GH_BOARD_DATA_DIR: data, GITHUB_TOKEN: TOK.alice, GH_TOKEN: '', GITHUB_API_URL: mock.base, READ_ONLY: '', CHAT_MODE: '' });
Object.assign(process.env, { KV_REST_API_URL: `http://127.0.0.1:${db.address().port}`, KV_REST_API_TOKEN: DB_TOKEN });
const { handler } = await import('../server.mjs');
const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
test.after(async () => { db.close(); server.close(); await mock.close(); rmSync(data, { recursive: true, force: true }); });

const HOST = 'gh-board.example.vercel.app';
const send = (path, { headers = {}, body, auth = true } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: body ? 'POST' : 'GET', headers: { host: HOST, 'x-forwarded-proto': 'https', ...(auth ? { cookie: `ghb=${KEY}` } : {}), ...headers } }, (res) => {
    let text = ''; res.on('data', (c) => (text += c));
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text }); });
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});

test('every path needs the key, pages included', async () => {
  for (const path of ['/', '/api/repos', '/api/issues?repo=acme/timesheet']) assert.equal((await send(path, { auth: false })).status, 401);
  const login = await send(`/?key=${KEY}`, { auth: false });
  assert.equal(login.status, 303);
  const page = await send('/', { auth: false });
  assert.match(page.text, /<form method="post" action="\/signin">/);
  const form = (key, origin = `https://${HOST}`) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/signin', method: 'POST', headers: { host: HOST, origin, 'x-forwarded-proto': 'https', 'content-type': 'application/x-www-form-urlencoded' } }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); });
    req.on('error', reject); req.end(new URLSearchParams({ key }).toString());
  });
  const typed = await form(`  ${KEY}
`);
  assert.deepEqual([typed.status, typed.headers.location], [303, '/']);
  assert.match(typed.headers['set-cookie'][0], /^ghb=.*HttpOnly.*Secure/);
  const bad = await form('not-the-key');
  assert.deepEqual([bad.status, bad.headers['set-cookie']], [401, undefined]);
  assert.match(bad.text, /That key is not right/);
  assert.equal((await form(KEY, 'https://evil.example')).status, 403);
  assert.match(login.headers['set-cookie'][0], /Secure/);
  assert.equal((await send('/api/repos', { headers: { origin: 'https://evil.example' } })).status, 403);
});

test('issues work with the environment token', async () => {
  const r = await send('/api/issues?repo=acme/timesheet', { headers: { origin: `https://${HOST}` } });
  assert.equal(r.status, 200);
  assert.ok(r.json.issues.length > 0);
  assert.ok(!r.text.includes(TOK.alice));
});

test('the runner and saved settings are refused', async () => {
  for (const path of ['/api/runner/start', '/api/runner/skill', '/api/settings/claude', '/api/auth/device', '/api/tunnel/enable']) {
    const r = await send(path, { body: { confirm: true } });
    assert.equal(r.status, 403, path);
    assert.match(r.json.error, /Not available on the hosted board/);
  }
  assert.deepEqual((await send('/api/tunnel')).json, { hosted: true });
});

test('chat set to Claude goes to the gateway, and says what is missing without a key', async () => {
  const r = await send('/api/chat', { body: { message: 'hi', repo: 'acme/timesheet' } });
  assert.match(r.text, /Vercel AI Gateway/);
  assert.match((await send('/api/approve', { body: { id: 'nope', ok: true } })).json.error, /could not be delivered/);
});

test('accounts and keys added in the UI are saved to the database, encrypted', async () => {
  assert.equal(process.env.KV_REST_API_TOKEN, undefined, 'child processes cannot inherit the database token');
  const logins = async () => (await send('/api/auth/accounts')).json.accounts.map((a) => a.login).sort();
  assert.deepEqual(await logins(), ['alice']);

  const added = await send('/api/auth/token', { body: { token: TOK.bob } });
  assert.equal(added.status, 200, added.text);
  const llm = 'sk-hosted-MOCK-key-0123456789abcdWXYZ';
  const saved = await send('/api/providers/save', { body: { id: 'openai', apiKey: llm } });
  assert.equal(saved.status, 200, saved.text);
  const stored = [...rows.values()].join();
  for (const secret of [TOK.bob, llm]) assert.ok(!stored.includes(secret) && !added.text.includes(secret) && !saved.text.includes(secret));
  assert.ok(!stored.includes('bob'), 'the whole entry is ciphertext');

  const openai = async () => (await send('/api/providers')).json.providers.find((p) => p.id === 'openai').hasKey;
  assert.deepEqual([await logins(), await openai()], [['alice', 'bob'], true]);
  // The database is the truth: an emptied or altered entry is what every instance then shows.
  const [name, value] = [...rows][0];
  rows.set(name, `x${value.slice(1)}`);
  assert.deepEqual([await logins(), await openai()], [['alice'], false]);
  rows.set(name, value);
  assert.deepEqual([await logins(), await openai()], [['alice', 'bob'], true]);
});
