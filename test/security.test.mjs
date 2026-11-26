// Hardening: response headers, malformed and cross-site requests, GitHub path injection, and where keys can go.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, TOK } from './mock.mjs';
import { createAccounts } from '../accounts.mjs';
import { assertApiPath, assertRepo, issueNumber } from '../security.mjs';
import { checkHostedProvider } from '../hosted.mjs';
import { initProviders, saveProvider, resolveProvider } from '../providers/store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3957;
const data = mkdtempSync(join(tmpdir(), 'ghb-x-'));
const mock = await startMock();
const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ACCESS_KEY: '', ALLOWED_HOSTS: '', GH_BOARD_DATA_DIR: data, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_API_URL: mock.base, PROVIDERS_FILE: join(data, 'p.json') } });
test.after(async () => { child.kill(); await mock.close(); rmSync(data, { recursive: true, force: true }); });
const send = (path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
  req.on('error', reject); req.end();
});
for (let i = 0; i < 100; i++) { try { await send('/api/session'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

test('every response carries the security headers', async () => {
  for (const path of ['/', '/api/session', '/nope']) {
    const { headers } = await send(path);
    assert.match(headers['content-security-policy'], /default-src 'self'.*frame-ancestors 'none'/);
    assert.doesNotMatch(headers['content-security-policy'], /img-src[^;]*(\*| https:(\s|;))|script-src[^;]*unsafe/);
    assert.deepEqual([headers['x-content-type-options'], headers['x-frame-options'], headers['referrer-policy']], ['nosniff', 'DENY', 'same-origin']);
  }
  assert.equal((await send('/api/session')).headers['cache-control'], 'no-store');
});

test('cross-site requests are refused, a malformed address does not stop the server', async () => {
  assert.equal((await send('/api/session', { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.equal((await send('/api/runner/stop-all', { 'sec-fetch-site': 'cross-site' }, 'POST')).statusCode, 403);
  const status = await new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1', () => socket.end(`GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`));
    let text = ''; socket.on('data', (c) => (text += c)); socket.on('close', () => resolve(text.split(' ')[1]));
  });
  assert.equal(status, '400');
  assert.equal((await send('/api/session')).statusCode, 200);
});

test('a repo or number cannot steer a GitHub call to another endpoint', async () => {
  for (const repo of ['a/b/../..', 'a/b#', 'a/b?x=1', 'a/..', 'a', 'a/b/pulls/1/merge', '']) assert.throws(() => assertRepo(repo), repo);
  for (const path of ['/repos/a/b/../../user', '/repos/a/b/%2e%2E/x', '/repos/a/b#/issues/1', '/repos/a\\b', 'https://evil.example/']) assert.throws(() => assertApiPath(path), path);
  assert.equal(assertApiPath('/repos/a/.github/contents/x.y?ref=a%2Fb'), '/repos/a/.github/contents/x.y?ref=a%2Fb');
  for (const n of ['1/merge', 0, -1, 1.5, 'abc', undefined]) assert.throws(() => issueNumber(n), String(n));
  const accounts = createAccounts({ dir: data, apiBase: mock.base, envToken: TOK.alice });
  const before = mock.writes().length;
  await assert.rejects(accounts.forRepo('acme/timesheet#'), /owner\/name/);
  const { gh } = await accounts.forRepo('acme/timesheet');
  await assert.rejects(gh('/repos/acme/timesheet/issues/../../x', { method: 'POST', body: {} }), /not a valid GitHub API path/);
  assert.equal(mock.writes().length, before);
});

test('a saved provider key does not follow a changed address', () => {
  initProviders({ env: {}, file: join(data, 'keys.json') });
  const key = 'sk-security-MOCK-0123456789abcdWXYZ';
  saveProvider('openai', { apiKey: key });
  saveProvider('openai', { models: ['m'] });
  assert.equal(resolveProvider('openai').apiKey, key);
  saveProvider('openai', { baseUrl: 'https://elsewhere.example/v1' });
  assert.throws(() => resolveProvider('openai'), /key/i);
});

test('the hosted board refuses provider settings that could carry its keys away', () => {
  for (const body of [{ keyEnv: 'AI_GATEWAY_API_KEY', baseUrl: 'https://evil.example/v1' }, { id: 'ai-gateway', baseUrl: 'https://evil.example/v1' },
    { id: 'openai', baseUrl: 'https://evil.example/v1' }, { baseUrl: 'http://api.example.com/v1' }, { baseUrl: 'https://169.254.169.254/' }, { baseUrl: 'https://localhost/v1' }, { baseUrl: 'https://[::1]/v1' }]) {
    assert.throws(() => checkHostedProvider(body), JSON.stringify(body));
  }
  for (const body of [{ id: 'openai', apiKey: 'x' }, { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'x' }, { id: 'ai-gateway', models: ['a/b'] }]) checkHostedProvider(body);
});
