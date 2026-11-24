// End-to-end check of the non-Claude chat path against a real gh-board server in READ_ONLY mode and a
// scripted mock model (test/mock-llm.mjs). It needs GitHub read access (your normal gh-board auth) and
// git, and it never writes to GitHub: the server runs with READ_ONLY=1 and the script fails if a write
// tool ever reports success.
//
//   node test/e2e-providers.mjs [owner/name]        default repo: E2E_REPO or MordechaiNewmark/timesheet
//
// Not part of `npm test` because it talks to GitHub.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-llm.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = process.argv[2] || process.env.E2E_REPO || 'MordechaiNewmark/timesheet';
const PORT = Number(process.env.E2E_PORT || 3917);
const BASE = `http://localhost:${PORT}`;
const KEYS = { openai: 'sk-e2e-OPENAI-key-0123456789abcdEFGH', gemini: 'AIza-e2e-GEMINI-key-0123456789IJKL', env: 'sk-e2e-ENV-fallback-key-0123456MNOP', wrong: 'sk-e2e-WRONG-key-000000000000QRST' };
const tmp = mkdtempSync(join(tmpdir(), 'ghb-e2e-'));
const seen = []; // every byte the server sent us or logged, for the secret scan
let serverOut = '';
const step = (name) => console.log(`\n== ${name}`);
const pass = (msg) => console.log(`   ok  ${msg}`);

const mock = await startMock({ key: KEYS.openai });
const mockGem = await startMock({ key: KEYS.gemini });

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', READ_ONLY: '1', ACCESS_KEY: '', ALLOWED_HOSTS: '', PROVIDERS_FILE: join(tmp, 'providers.json'), OPENAI_API_KEY: KEYS.env, GEMINI_API_KEY: '', GOOGLE_API_KEY: '' },
});
child.stdout.on('data', (d) => { serverOut += d; });
child.stderr.on('data', (d) => { serverOut += d; });
const stop = async () => { child.kill(); await mock.close(); await mockGem.close(); rmSync(tmp, { recursive: true, force: true }); };

async function api(path, body) {
  const r = await fetch(BASE + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text(); seen.push(text);
  const j = JSON.parse(text);
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

/** One chat turn. Returns the parsed SSE events. `onEvent` may return 'abort' to stop the request. */
async function chat(body, onEvent) {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: REPO, chatId: 'e2e', ...body }), signal: ac.signal });
  assert.equal(res.status, 200);
  const events = []; let buf = '';
  const dec = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      const text = dec.decode(chunk, { stream: true }); seen.push(text); buf += text;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i).replace(/^data: /, '')); buf = buf.slice(i + 2);
        events.push(ev);
        if (onEvent?.(ev) === 'abort') ac.abort();
      }
    }
  } catch (e) { if (!ac.signal.aborted) throw e; }
  return events;
}
const textOf = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const toolsOf = (events) => events.filter((e) => e.type === 'tool').map((e) => ({ ...e, result: events.find((r) => r.type === 'tool_result' && r.id === e.id) }));

try {
  step('start server (READ_ONLY=1) and connect');
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/providers`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const auth = await api('/api/auth/status');
  assert.equal(auth.readOnly, true, 'server must be read-only for this test');
  assert.equal(auth.connected, true, `GitHub is not connected: ${auth.error}`);
  pass(`GitHub connected as ${auth.login}, readOnly=true`);

  step('settings API');
  let view = await api('/api/providers');
  let openai = view.providers.find((p) => p.id === 'openai');
  assert.deepEqual([openai.hasKey, openai.keySource, openai.keyTail], [true, 'env:OPENAI_API_KEY', '••••MNOP']);
  pass('env fallback: OPENAI_API_KEY is picked up and shown only as ••••MNOP');
  assert.equal(view.providers.find((p) => p.id === 'gemini').status, 'needs-key');

  view = await api('/api/providers/save', { id: 'openai', apiKey: KEYS.openai, baseUrl: `${mock.origin}/v1`, models: ['mock-gpt'] });
  openai = view.providers.find((p) => p.id === 'openai');
  assert.deepEqual([openai.keySource, openai.keyTail, openai.status], ['saved', '••••EFGH', 'ready']);
  view = await api('/api/providers/save', { id: 'gemini', apiKey: KEYS.gemini, baseUrl: `${mockGem.origin}/v1beta`, models: ['mock-gemini'] });
  const custom = await api('/api/providers/add', { label: 'Local mock (no key)', baseUrl: `${mock.origin}/nokey/v1`, models: ['mock-local'] });
  pass('saved OpenAI + Gemini keys with base URL overrides, added a keyless OpenAI-compatible provider');
  assert.ok(readFileSync(join(tmp, 'providers.json'), 'utf8').includes(KEYS.openai), 'the key is in the server-side file');

  for (const id of ['openai', 'gemini', custom.id]) { const t = await api('/api/providers/test', { id }); assert.equal(t.ok, true, t.message); pass(`test connection ${id}: ${t.message}`); }
  await api('/api/providers/save', { id: 'openai', apiKey: KEYS.wrong });
  const badTest = await api('/api/providers/test', { id: 'openai' });
  assert.equal(badTest.ok, false); assert.match(badTest.message, /OpenAI rejected the API key \(HTTP 401\)/);
  pass(`wrong key: "${badTest.message}"`);
  const badChat = await chat({ provider: 'openai', model: 'mock-gpt', message: '[[script:hello]]' });
  assert.match(badChat.at(-1).error, /OpenAI rejected the API key/);
  pass('wrong key in chat: readable error event');
  await api('/api/providers/save', { id: 'openai', apiKey: KEYS.openai });
  await assert.rejects(api('/api/providers/save', { id: 'openai', baseUrl: 'file:///etc/passwd' }), /http:\/\/ or https:\/\//);
  pass('non-http base URL rejected');

  for (const [provider, model, m] of [['openai', 'mock-gpt', mock], ['gemini', 'mock-gemini', mockGem]]) {
    step(`full scripted run on ${provider} against ${REPO}`);
    const from = m.log.length;
    const events = await chat({ provider, model, message: '[[script:full]] Audit this repo.' });
    const tools = toolsOf(events);
    const by = (name) => tools.filter((t) => t.name === name);
    assert.equal(events[0].type, 'session'); assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).error, undefined, events.at(-1).error);
    assert.deepEqual(tools.map((t) => t.name), ['sync_repo', 'list_issues', 'Grep', 'Glob', 'Read', 'Read', 'Read', 'Grep', 'Glob', 'Read', 'create_issues', 'generate_file']);
    pass(`tool calls in order: ${tools.map((t) => t.name).join(', ')}`);
    assert.ok(events.some((e) => e.type === 'progress'), 'sync progress events');
    assert.equal(by('sync_repo')[0].result.isError, false);
    assert.equal(by('list_issues')[0].result.isError, false);

    // What the model received back, straight from the mock's request log.
    const reqs = m.log.slice(from).filter((r) => r.method === 'POST');
    const last = JSON.stringify(reqs.at(-1).body);
    assert.ok(reqs.every((r) => r.auth === 'ok' && !r.keyInUrl), 'key only in the auth header');
    assert.match(last, /"sha\\?":\\?"[0-9a-f]{40}/, 'sync_repo result (sha) reached the model');
    assert.ok(!last.includes('.repo-cache'), 'the local checkout path is not sent to the provider');
    assert.match(last, /matches? in \d+ files?|No matches for/, 'grep output reached the model');
    assert.match(last, /README\.md \(lines 1-\d+ of \d+\)/, 'read_file_local output reached the model');
    assert.match(last, /\d+ files? match/, 'glob output reached the model');
    pass('tool results flowed back to the model (sync sha, issues, grep, glob, file lines)');

    // Path guard: 3rd..5th Read, 2nd Grep and 2nd Glob are the escape attempts.
    const reads = by('Read'); const greps = by('Grep'); const globs = by('Glob');
    assert.equal(reads[0].result.isError, false);
    for (const t of [reads[1], reads[2], reads[3], greps[1], globs[1]]) assert.equal(t.result.isError, true, `${t.name} ${JSON.stringify(t.input)} should be denied`);
    assert.match(last, /Outside the repo checkout/); assert.match(last, /\.git is excluded from analysis/);
    assert.ok(!/createSdkMcpServer|\[remote \\+"origin|for 16-bit app support/.test(last), 'no content from outside the checkout or from .git reached the model');
    pass('path guard denied ../../server.mjs, .git/config, grep ../.., glob ../*, C:/Windows/win.ini');

    // Write path: an approval event, blocked, and the tool reports an error.
    const ap = events.filter((e) => e.type === 'approval');
    assert.equal(ap.length, 1); assert.deepEqual([ap[0].blocked, ap[0].id, ap[0].tool], [true, '', 'create_issues']);
    assert.equal(ap[0].toolUseId, by('create_issues')[0].id);
    assert.equal(ap[0].input.issues[0].children[0].title, 'Mock child issue', 'the approval card gets the full proposal');
    assert.equal(by('create_issues')[0].result.isError, true);
    assert.match(last, /read-only mode \(READ_ONLY=1\)/);
    pass('create_issues produced an approval event and was blocked by READ_ONLY');

    const file = events.find((e) => e.type === 'file');
    assert.equal(file.name, 'mock-report.md');
    const dl = await fetch(`${BASE}/api/download?id=${file.id}`);
    assert.match(await dl.text(), /# Mock report/);
    pass('generate_file produced a download card and the file downloads');
    assert.match(textOf(events), /I will sync the repo first\.[\s\S]*## Findings[\s\S]*Done\. The write was blocked/);
    pass('text streamed as deltas');

    // Session continuity: the next turn carries the earlier conversation.
    const again = await chat({ provider, model, sessionId: events[0].sessionId, message: 'And [[script:hello]]' });
    assert.equal(again[0].sessionId, events[0].sessionId);
    assert.ok(JSON.stringify(m.log.at(-1).body).includes('Mock child issue'), 'history kept server-side');
    pass('second turn reuses the session and its history');
  }

  step('READ_ONLY also blocks the board API');
  await assert.rejects(api('/api/issue/create', { repo: REPO, title: 'must not be created' }), /Read-only mode/);
  pass('POST /api/issue/create refused');

  step('abort');
  const n = mock.log.length;
  let deltas = 0;
  const t0 = Date.now();
  const aborted = await chat({ provider: custom.id, model: 'mock-local', message: '[[script:slow]]' }, (e) => (e.type === 'delta' && ++deltas >= 3 ? 'abort' : undefined));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(Date.now() - t0 < 8000); assert.ok(!aborted.some((e) => e.type === 'done'));
  assert.equal(mock.log.length, n + 1); assert.equal(mock.log.at(-1).aborted, true, 'the server cancelled its request to the provider');
  assert.equal(mock.log.at(-1).auth, 'none');
  pass(`stopped after ${deltas} deltas; the upstream request was cancelled`);

  step('errors');
  for (const [script, re] of [['notools', /does not support tool calling/], ['ratelimit', /rate limit or quota reached \(HTTP 429\)/]]) {
    const ev = await chat({ provider: 'openai', model: 'mock-gpt', message: `[[script:${script}]]` });
    assert.match(ev.at(-1).error, re); pass(`${script}: "${ev.at(-1).error}"`);
  }
  assert.match((await chat({ provider: 'nope', message: 'x' })).at(-1).error, /Unknown provider/);
  await api('/api/providers/save', { id: 'gemini', enabled: false });
  assert.match((await chat({ provider: 'gemini', model: 'mock-gemini', message: 'x' })).at(-1).error, /turned off/);
  pass('unknown and disabled providers are refused with a clear message');

  step('secrets');
  seen.push(JSON.stringify(await api('/api/providers')));
  const everything = seen.join('\n') + serverOut;
  for (const [name, k] of Object.entries(KEYS)) assert.ok(!everything.includes(k), `${name} key leaked into an API response or the server log`);
  pass(`no key in ${seen.length} response chunks (${Math.round(everything.length / 1024)} KB) or in the server log`);
  console.log(`\nserver log:\n${serverOut.trim().split('\n').map((l) => `   | ${l}`).join('\n')}`);
  console.log('\nALL E2E CHECKS PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e);
  console.error(`server log:\n${serverOut}`);
  process.exitCode = 1;
} finally { await stop(); }
