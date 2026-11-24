// End-to-end over HTTP: a real server process on a spare port, READ_ONLY=1, talking only to the local mock.
// It gets its own data folder, so the real .gh-accounts.json / .claude-auth.json are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, TOK, BAD_KEY } from './mock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3917;
const mock = await startMock();
const data = mkdtempSync(join(tmpdir(), 'ghb-s-'));
writeFileSync(join(data, '.gh-token'), TOK.alice); // a pre-multi-account install

let out = '';
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ACCESS_KEY: '', ALLOWED_HOSTS: '', READ_ONLY: '1',
    GH_BOARD_DATA_DIR: data, GITHUB_API_URL: mock.base, ANTHROPIC_BASE_URL: mock.base,
    GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_CLIENT_ID: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', CLAUDE_MODEL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (c) => (out += c));
child.stderr.on('data', (c) => (out += c));
test.after(async () => { child.kill(); await mock.close(); rmSync(data, { recursive: true, force: true }); });

const bodies = [];
const base = `http://127.0.0.1:${PORT}`;
async function api(path, body) {
  const r = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, json: JSON.parse(text || '{}') };
}
for (let i = 0; i < 100; i++) { try { await fetch(`${base}/api/auth/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

test('existing .gh-token keeps working with no user action', async () => {
  const { json } = await api('/api/auth/status');
  assert.equal(json.connected, true);
  assert.equal(json.login, 'alice');
  assert.equal(json.readOnly, true);
  assert.equal(json.accounts.length, 1);
  assert.equal(existsSync(join(data, '.gh-token')), false);
  assert.equal(existsSync(join(data, '.gh-accounts.json')), true);
});

test('POST /api/auth/token adds a second account instead of replacing the first', async () => {
  const bad = await api('/api/auth/token', { token: TOK.dead });
  assert.equal(bad.status, 500);
  assert.match(bad.json.error, /rejected that token/);
  const { json } = await api('/api/auth/token', { token: TOK.bob });
  assert.deepEqual(json.accounts.map((a) => a.login), ['alice', 'bob']);
  assert.equal(json.login, 'alice', 'the default account is unchanged');
  const l = (await api('/api/auth/accounts?check=1')).json;
  assert.deepEqual(l.accounts.map((a) => [a.login, a.status, a.default]), [['alice', 'ok', true], ['bob', 'ok', false]]);
});

test('repo list is merged and tagged; repo routes use the owning account\'s token', async () => {
  const repos = (await api('/api/repos')).json;
  const by = Object.fromEntries(repos.map((r) => [r.name, r.account]));
  assert.deepEqual(by, { 'alice/app': 'alice', 'shared/lib': 'bob', 'acme/api': 'alice', 'ssoorg/secret': 'alice', 'bob/tool': 'bob' });
  for (const [repo, token] of [['bob/tool', TOK.bob], ['alice/app', TOK.alice], ['shared/lib', TOK.bob]]) {
    for (const route of ['issues', 'labels', 'milestones', 'assignees']) {
      const r = await api(`/api/${route}?repo=${repo}`);
      assert.equal(r.status, 200, `${route} ${repo}`);
      assert.equal(mock.last(`/repos/${repo}/${route}`).token, token, `${route} for ${repo}`);
    }
  }
  assert.equal((await api('/api/repo/account?repo=shared/lib')).json.login, 'bob');
  const sso = await api('/api/issues?repo=ssoorg/secret');
  assert.equal(sso.status, 500);
  assert.match(sso.json.error, /@alice's token is not authorized/);
});

test('READ_ONLY=1 blocks every write route for every account', async () => {
  const before = mock.writes().length;
  for (const repo of ['alice/app', 'bob/tool']) {
    for (const [path, body] of [
      ['/api/move', { repo, number: 1, column: 'Todo' }],
      ['/api/issue/create', { repo, title: 't' }],
      ['/api/issue/update', { repo, number: 1, title: 't' }],
      ['/api/issue/comment', { repo, number: 1, body: 'c' }],
      ['/api/issue/parent', { repo, number: 1, parent: 2 }],
      ['/api/label/create', { repo, name: 'l' }],
    ]) {
      const r = await api(path, body);
      assert.equal(r.status, 500, path);
      assert.match(r.json.error, /Read-only mode/, path);
    }
  }
  assert.equal(mock.writes().length, before, 'no write reached GitHub');
});

test('per-repo override, default switch and disconnect over HTTP', async () => {
  assert.equal((await api('/api/repo/account', { repo: 'shared/lib', login: 'alice' })).json.login, 'alice');
  await api('/api/issues?repo=shared/lib');
  assert.equal(mock.last('/repos/shared/lib/issues').token, TOK.alice);
  assert.equal((await api('/api/auth/default', { login: 'bob' })).json.login, 'bob');
  const after = (await api('/api/auth/logout', { login: 'bob' })).json;
  assert.deepEqual(after.accounts.map((a) => a.login), ['alice']);
  assert.equal(after.login, 'alice');
  const repos = (await api('/api/repos')).json;
  assert.ok(!repos.some((r) => r.name === 'bob/tool'));
  assert.equal((await api('/api/issues?repo=bob/tool')).status, 500, 'alice cannot see bob\'s repo');
});

test('Claude settings: saved server-side, masked in responses, failure path of Test connection', async () => {
  let s = (await api('/api/settings')).json.claude;
  assert.equal(s.method, 'login');
  s = (await api('/api/settings/claude', { method: 'apikey', secret: BAD_KEY, model: 'claude-haiku-5-5' })).json.claude;
  assert.deepEqual([s.method, s.source, s.tail, s.model, s.billing], ['apikey', 'saved', '••••wxyz', 'claude-haiku-5-5', 'api']);
  const st = (await api('/api/auth/status')).json.claude;
  assert.deepEqual([st.method, st.tail, st.model], ['apikey', '••••wxyz', 'claude-haiku-5-5']);
  const t = (await api('/api/settings/claude/test', {})).json;
  assert.equal(t.ok, false);
  assert.match(t.error, /rejected the API key/);
  const bad = await api('/api/settings/claude', { method: 'apikey', secret: 'nope' });
  assert.equal(bad.status, 500);
  s = (await api('/api/settings/claude/remove', { method: 'apikey' })).json.claude;
  assert.deepEqual([s.method, s.saved.apikey], ['login', null]);
});

test('no token or key appears in any HTTP response or in the server log', async () => {
  await new Promise((r) => setTimeout(r, 200));
  const all = bodies.join('\n') + out;
  for (const [k, t] of Object.entries({ ...TOK, BAD_KEY })) assert.ok(!all.includes(t), `leaked ${k}`);
  assert.match(out, /READ_ONLY=1/);
  assert.match(out, /GitHub accounts: @alice/);
});
