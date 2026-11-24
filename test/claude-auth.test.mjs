// Claude credential settings. Secrets are fake; the only "Anthropic" contacted is the local mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAuth, mask } from '../claude-auth.mjs';
import { startMock, GOOD_KEY, BAD_KEY } from './mock.mjs';

const OAT = 'sk-ant-oat01-FAKEtoken00000000000000000000000qrst';
const mock = await startMock();
test.after(() => mock.close());
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (dotenv) => { const d = mkdtempSync(join(tmpdir(), 'ghb-c-')); dirs.push(d); if (dotenv !== undefined) writeFileSync(join(d, '.env'), dotenv); return d; };
const noSecrets = (v, label) => { const s = typeof v === 'string' ? v : JSON.stringify(v); for (const t of [OAT, GOOD_KEY, BAD_KEY]) assert.ok(!s.includes(t), `${label} leaks a secret`); };

test('defaults to the claude login session and passes no credential to the agent', () => {
  const ca = createClaudeAuth({ dir: tmp(), env: { PATH: 'x', GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh', ACCESS_KEY: 'k' } });
  const s = ca.status();
  assert.deepEqual([s.method, s.source, s.tail, s.billing], ['login', 'default', '', 'subscription']);
  assert.deepEqual(ca.agentEnv(), { PATH: 'x' });
});

test('.env is the fallback: OAuth token first, then an API key written in .env', () => {
  const both = createClaudeAuth({ dir: tmp(`ANTHROPIC_API_KEY=${GOOD_KEY}\n`), env: { CLAUDE_CODE_OAUTH_TOKEN: OAT, ANTHROPIC_API_KEY: GOOD_KEY } });
  assert.deepEqual([both.status().method, both.status().source], ['oauth', 'env']);
  assert.deepEqual(both.agentEnv(), { CLAUDE_CODE_OAUTH_TOKEN: OAT });

  const key = createClaudeAuth({ dir: tmp(`ANTHROPIC_API_KEY=${GOOD_KEY}\n`), env: { ANTHROPIC_API_KEY: GOOD_KEY } });
  assert.deepEqual([key.status().method, key.status().source, key.status().billing, key.status().tail], ['apikey', 'env', 'api', '••••abcd']);
  assert.deepEqual(key.agentEnv(), { ANTHROPIC_API_KEY: GOOD_KEY });
  noSecrets(key.status(), 'status');
});

test('an API key that is only exported in the shell is not used', () => {
  const ca = createClaudeAuth({ dir: tmp(''), env: { ANTHROPIC_API_KEY: GOOD_KEY, HOME: 'h' } });
  assert.equal(ca.status().method, 'login');
  assert.equal(ca.status().ambientApiKeyIgnored, true);
  assert.deepEqual(ca.agentEnv(), { HOME: 'h' });
});

test('a saved setting overrides .env, is stored server-side only, and survives a restart', () => {
  const dir = tmp();
  const env = { CLAUDE_CODE_OAUTH_TOKEN: OAT, CLAUDE_MODEL: 'claude-sonnet-5-5' };
  const ca = createClaudeAuth({ dir, env });
  const s = ca.update({ method: 'apikey', secret: `  ${GOOD_KEY}\n` });
  assert.deepEqual([s.method, s.source, s.tail, s.billing], ['apikey', 'saved', '••••abcd', 'api']);
  noSecrets(s, 'update response');
  assert.deepEqual(ca.agentEnv(env), { CLAUDE_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: GOOD_KEY }, 'exactly one Claude credential reaches the agent');
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude-auth.json'), 'utf8')).apiKey, GOOD_KEY);

  const again = createClaudeAuth({ dir, env });
  assert.equal(again.status().method, 'apikey');
  // Choosing the login session explicitly beats the .env token.
  assert.equal(again.update({ method: 'login' }).method, 'login');
  assert.deepEqual(again.agentEnv(env), { CLAUDE_MODEL: 'claude-sonnet-5-5' });
  // Switching back needs no re-paste: the key is still saved.
  assert.equal(again.update({ method: 'apikey' }).source, 'saved');
  // Remove forgets it and falls back to .env.
  const r = again.remove('apikey');
  assert.deepEqual([r.method, r.source, r.saved.apikey], ['oauth', 'env', null]);
  assert.ok(!readFileSync(join(dir, '.claude-auth.json'), 'utf8').includes(GOOD_KEY));
});

test('validation: missing, malformed and mismatched secrets are refused', () => {
  const ca = createClaudeAuth({ dir: tmp(), env: {} });
  assert.throws(() => ca.update({ method: 'apikey' }), /Paste an Anthropic API key/);
  assert.throws(() => ca.update({ method: 'oauth' }), /claude setup-token/);
  assert.throws(() => ca.update({ method: 'apikey', secret: 'short' }), /does not look like/);
  assert.throws(() => ca.update({ method: 'apikey', secret: OAT }), /looks like an OAuth token/);
  assert.throws(() => ca.update({ method: 'oauth', secret: GOOD_KEY }), /looks like an Anthropic API key/);
  assert.throws(() => ca.update({ method: 'bogus', secret: GOOD_KEY }), /Unknown/);
  assert.throws(() => ca.update({ model: 'bad model; rm -rf' }), /model name/);
  assert.equal(ca.status().method, 'login');
});

test('model: saved value overrides CLAUDE_MODEL; empty means the default', () => {
  const ca = createClaudeAuth({ dir: tmp(), env: { CLAUDE_MODEL: 'claude-sonnet-5-5' } });
  assert.deepEqual([ca.model(), ca.status().modelSource], ['claude-sonnet-5-5', 'env']);
  ca.update({ model: 'claude-haiku-5-5' });
  assert.deepEqual([ca.model(), ca.status().modelSource], ['claude-haiku-5-5', 'saved']);
  ca.update({ model: '' });
  assert.equal(ca.model(), '');
  ca.update({ model: null });
  assert.equal(ca.model(), 'claude-sonnet-5-5');
});

test('Test connection: API key is checked with a free request; failure is readable and leaks nothing', async () => {
  const env = { ANTHROPIC_BASE_URL: mock.base };
  const ca = createClaudeAuth({ dir: tmp(), env });
  ca.update({ method: 'apikey', secret: BAD_KEY });
  const bad = await ca.test();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Anthropic rejected the API key \(401: invalid x-api-key\)/);
  assert.equal(bad.tail, '••••wxyz');
  noSecrets(bad, 'failed test result');

  ca.update({ method: 'apikey', secret: GOOD_KEY });
  const good = await ca.test();
  assert.equal(good.ok, true);
  noSecrets(good, 'test result');
  assert.equal(mock.log.filter((e) => e.anthropic).at(-1).key, GOOD_KEY);
});

test('Test connection: login/OAuth go through the injected agent runner with the right env', async () => {
  const ca = createClaudeAuth({ dir: tmp(), env: { CLAUDE_MODEL: 'm1' } });
  ca.update({ method: 'oauth', secret: OAT });
  let seen;
  const okRes = await ca.test({ runAgent: async (env, model) => { seen = { env, model }; return 'Claude answered.'; } });
  assert.equal(okRes.ok, true);
  assert.equal(seen.env.CLAUDE_CODE_OAUTH_TOKEN, OAT);
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(seen.model, 'm1');
  const fail = await ca.test({ runAgent: async () => { throw new Error(`401 invalid token ${OAT}`); } });
  assert.equal(fail.ok, false);
  noSecrets(fail, 'failed test result');
});

test('mask shows only a short tail', () => {
  assert.equal(mask(GOOD_KEY), '••••abcd');
  assert.equal(mask('tiny'), '••••');
  assert.equal(mask(''), '');
});
