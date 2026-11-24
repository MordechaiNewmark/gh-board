// The loop over HTTP: a real server process (writes enabled, planner chat mode) talking only to the mock GitHub,
// with the stub CLI in place of Claude Code. Covers the human actions (merge / request changes / close), the
// planner tool set, and that the runner cannot be started without a confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, TOK } from './mock.mjs';
import { startMock as startLlm } from './mock-llm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3927;
const mock = await startMock();
const LLM_KEY = 'sk-loop-MOCK-key-0123456789abcdWXYZ';
const llm = await startLlm({ key: LLM_KEY });
const data = mkdtempSync(join(tmpdir(), 'ghb-l-'));
writeFileSync(join(data, '.gh-token'), TOK.alice);

let out = '';
function boot(port, extra = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ACCESS_KEY: '', ALLOWED_HOSTS: '', READ_ONLY: '', CHAT_MODE: '', GH_BOARD_DATA_DIR: data, GITHUB_API_URL: mock.base, ANTHROPIC_BASE_URL: mock.base,
      GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_CLIENT_ID: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '', CLAUDE_MODEL: '', CLAUDE_BIN: join(ROOT, 'test', 'stub-claude.mjs'), CLAUDE_CONFIG_DIR: join(data, 'no-claude-config'), PROVIDERS_FILE: join(data, `providers-${port}.json`), OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (out += c));
  return child;
}
const child = boot(PORT);
const ro = boot(PORT + 1, { READ_ONLY: '1', GH_BOARD_DATA_DIR: mkdtempSync(join(tmpdir(), 'ghb-lr-')) });
const classic = boot(PORT + 2, { CHAT_MODE: 'classic', READ_ONLY: '1', GH_BOARD_DATA_DIR: mkdtempSync(join(tmpdir(), 'ghb-lc-')) });
test.after(async () => { child.kill(); ro.kill(); classic.kill(); await mock.close(); await llm.close(); rmSync(data, { recursive: true, force: true }); });

const bodies = [];
const call = (port) => async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text(); bodies.push(text);
  return { status: r.status, json: JSON.parse(text || '{}') };
};
const api = call(PORT); const apiRo = call(PORT + 1);
for (const p of [PORT, PORT + 1, PORT + 2]) for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${p}/api/auth/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
await api('/api/auth/token', { token: TOK.bob });
await apiRo('/api/auth/token', { token: TOK.alice });
const writes = () => mock.writes().length;
const SHA21 = 'a1'.repeat(20);

test('GET /api/loop: board columns, cards and inbox from the plugin labels', async () => {
  const { status, json } = await api('/api/loop?repo=acme/timesheet');
  assert.equal(status, 200);
  assert.deepEqual(json.columns.map((c) => [c.id, c.cards.length]), [['blocked', 2], ['ready', 3], ['claimed', 2], ['in-review', 1], ['changes-requested', 1], ['approved', 1], ['needs-human', 1], ['done', 3]]);
  assert.deepEqual(json.inbox.map((i) => i.kind), ['needs-human', 'merge', 'ci-failed', 'stale-claim']);
  assert.deepEqual(json.modules, ['api', 'web', 'reports'], 'MODULES is read from the repo\'s delivery.conf');
  assert.equal((await api('/api/auth/status')).json.chatMode, 'planner');
});

test('GET /api/loop/pr: the evidence-first review model', async () => {
  const { json } = await api('/api/loop/pr?repo=acme/timesheet&number=21');
  assert.deepEqual([json.issue.number, json.issue.state, json.verdict.state, json.as], [4, 'approved', 'approved', 'alice']);
  assert.deepEqual(json.criteria.map((c) => c.status), ['pass', 'pass', 'carried']);
  assert.deepEqual([json.gate.ci, json.merge.ok, json.merge.sha, json.files.length, json.media.length], ['success', true, SHA21, 5, 2]);
});

test('human merge: refused without confirmation or the reviewed SHA; nothing reaches GitHub', async () => {
  const before = writes();
  for (const body of [{ repo: 'acme/timesheet', number: 21, sha: SHA21 }, { repo: 'acme/timesheet', number: 21, sha: SHA21, confirm: 'true' }, { repo: 'acme/timesheet', number: 21, sha: SHA21, confirm: false }]) {
    const r = await api('/api/loop/pr/merge', body);
    assert.equal(r.status, 500);
    assert.match(r.json.error, /Confirmation required: merging a pull request/);
  }
  assert.match((await api('/api/loop/pr/merge', { repo: 'acme/timesheet', number: 21, confirm: true })).json.error, /needs the head commit SHA/);
  assert.match((await api('/api/loop/pr/merge', { repo: 'acme/timesheet', number: 21, confirm: true, sha: 'b2'.repeat(20) })).json.error, /changed since you reviewed it/);
  assert.match((await api('/api/loop/pr/request-changes', { repo: 'acme/timesheet', number: 23, body: 'fix it' })).json.error, /Confirmation required/);
  assert.match((await api('/api/loop/pr/close', { repo: 'acme/timesheet', number: 23 })).json.error, /Confirmation required/);
  assert.equal(writes(), before, 'no write reached GitHub');
});

test('human merge: squash, with the reviewed SHA, as the account that owns the repo', async () => {
  const r = await api('/api/loop/pr/merge', { repo: 'acme/timesheet', number: 21, sha: SHA21, confirm: true });
  assert.deepEqual([r.status, r.json.merged, r.json.as, r.json.issue], [200, true, 'alice', 4]);
  const put = mock.last('/repos/acme/timesheet/pulls/21/merge');
  assert.deepEqual([put.method, put.token, put.body], ['PUT', TOK.alice, { merge_method: 'squash', sha: SHA21 }]);
  // team/loop: bob is admin, alice (the default account) can only read. The merge must go out as bob.
  const t = await api('/api/loop/pr/merge', { repo: 'team/loop', number: 21, sha: SHA21, confirm: true });
  assert.deepEqual([t.status, t.json.as], [200, 'bob']);
  assert.equal(mock.last('/repos/team/loop/pulls/21/merge').token, TOK.bob);
  assert.match((await api('/api/loop/pr/merge', { repo: 'acme/timesheet', number: 21, sha: SHA21, confirm: true })).json.error, /not open/);
  const after = (await api('/api/loop?repo=acme/timesheet&fresh=1')).json;
  assert.ok(after.columns.find((c) => c.id === 'done').cards.includes(4), 'the merged task moved to Done');
});

test('request changes: posts the reasons (comment-form on your own PR) and relabels so the loop patches', async () => {
  const r = await api('/api/loop/pr/request-changes', { repo: 'acme/timesheet', number: 22, body: 'The button is not reachable by keyboard.', confirm: true });
  assert.deepEqual([r.status, r.json.issue, r.json.form, r.json.as], [200, 5, 'comment', 'alice']);
  const posts = mock.log.filter((e) => e.path === '/repos/acme/timesheet/pulls/22/reviews' && e.method === 'POST');
  assert.deepEqual(posts.map((e) => e.body.event), ['REQUEST_CHANGES', 'COMMENT'], 'falls back like the reviewer skill does on a single account');
  assert.match(posts[1].body.body, /not reachable by keyboard\.\n\n<!-- gh-board:human-review -->/);
  const issue5 = mock.worlds['acme/timesheet'].issues.find((i) => i.number === 5).labels.map((l) => l.name);
  assert.ok(issue5.includes('status:changes-requested') && !issue5.includes('status:in-review'));
  // Hand an escalated PR back: the patch budget restarts and needs-human comes off both the PR and the task.
  const h = await api('/api/loop/pr/request-changes', { repo: 'acme/timesheet', number: 24, body: 'A week belongs to the timezone of its Monday.', confirm: true, resetBudget: true });
  assert.equal(h.json.reset, true);
  assert.match(mock.worlds['acme/timesheet'].comments[24].at(-1).body, /^Patch iteration: 0\/3 \(budget reset by @alice/);
  const names = (x) => x.labels.map((l) => l.name);
  assert.ok(!names(mock.worlds['acme/timesheet'].pulls.find((p) => p.number === 24)).includes('needs-human'));
  assert.ok(!names(mock.worlds['acme/timesheet'].issues.find((i) => i.number === 12)).includes('needs-human'));
  assert.match((await api('/api/loop/pr/request-changes', { repo: 'acme/timesheet', number: 23, body: ' ', confirm: true })).json.error, /Say what has to change/);
});

test('close: closes the PR and parks the task as needs-human', async () => {
  const r = await api('/api/loop/pr/close', { repo: 'acme/timesheet', number: 23, confirm: true, reason: 'Wrong approach.' });
  assert.deepEqual([r.status, r.json.closed, r.json.issue], [200, true, 6]);
  const w = mock.worlds['acme/timesheet'];
  assert.equal(w.pulls.find((p) => p.number === 23).state, 'closed');
  const labels = w.issues.find((i) => i.number === 6).labels.map((l) => l.name);
  assert.ok(labels.includes('needs-human') && !labels.includes('status:changes-requested'));
  assert.match(w.comments[6].at(-1).body, /closed without merging by @alice.*Wrong approach\./s);
});

test('READ_ONLY=1 blocks every human action and the runner', async () => {
  const before = writes();
  for (const [path, body] of [
    ['/api/loop/pr/merge', { repo: 'acme/timesheet', number: 22, sha: 'b2'.repeat(20), confirm: true }],
    ['/api/loop/pr/request-changes', { repo: 'acme/timesheet', number: 22, body: 'Not good enough.', confirm: true }],
    ['/api/loop/pr/close', { repo: 'acme/timesheet', number: 22, confirm: true }],
  ]) {
    const r = await apiRo(path, body);
    assert.equal(r.status, 500, path);
    assert.match(r.json.error, /Read-only mode/, path);
  }
  for (const [path, body] of [['/api/runner/start', { repo: 'acme/timesheet', mode: 'once', confirm: true }], ['/api/runner/setup', { repo: 'acme/timesheet', confirm: true }], ['/api/runner/autonomy', { repo: 'acme/timesheet', autonomy: 'auto', confirm: true, acknowledge: 'auto-merge' }]]) {
    const r = await apiRo(path, body);
    assert.equal(r.status, 500, path);
    assert.match(r.json.error, /READ_ONLY=1/, path);
  }
  assert.equal(writes(), before, 'no write reached GitHub from the read-only server');
  assert.equal((await apiRo('/api/loop?repo=acme/timesheet')).status, 200, 'reading the loop still works');
});

test('runner over HTTP: refuses without confirmation, reports the missing plugin, never installs it', async () => {
  const noConfirm = await api('/api/runner/start', { repo: 'acme/timesheet', mode: 'once' });
  assert.equal(noConfirm.status, 500);
  assert.match(noConfirm.json.error, /Confirmation required: starting the loop/);
  const noPlugin = await api('/api/runner/start', { repo: 'acme/timesheet', mode: 'once', confirm: true });
  assert.match(noPlugin.json.error, /plugin is not installed.*claude plugin marketplace add "MordechaiNewmark\/delivery-loop#cost-aware-defaults" && claude plugin install delivery-loop@delivery-loop/s);
  const pre = (await api('/api/runner?repo=acme/timesheet')).json;
  assert.deepEqual([pre.status, pre.autonomy, pre.plugin.ok, pre.gate.ok, pre.token.kind, pre.token.broad, pre.account], ['idle', 'supervised', false, true, 'classic', true, 'alice']);
  assert.deepEqual(pre.blockers.map((b) => b.code), ['plugin']);
  assert.ok(pre.permissions.allow.includes('Bash(bash scripts/check.sh)') && pre.permissions.deny.includes('Bash(gh pr merge *)') && pre.permissions.mode === 'acceptEdits');
  assert.equal((await api('/api/runner?repo=acme/nogate')).json.blockers.some((b) => b.code === 'no-gate' && b.action === 'setup'), true);
  assert.equal((await api('/api/runner/status?repo=acme/timesheet')).json.status, 'idle');
  assert.deepEqual((await api('/api/runner/stop-all', {})).json, { stopped: [] });
  const ready = (await api('/api/readiness?repo=acme/fresh')).json;
  assert.deepEqual([ready.initialized, ready.from, ready.gate.ok], [false, 'github', false]);
});

test('planner lint endpoint: drafts are checked as they would be created', async () => {
  const { json } = await api('/api/loop/lint', { repo: 'acme/timesheet', drafts: [{ title: 'Epic: X', labels: ['epic'], children: [
    { title: 'Good', key: 'a', labels: ['task', 'module:api', 'size:S'], body: '## Context\nc\n\n## Acceptance criteria\n- [ ] `bash scripts/check.sh` passes' },
    { title: 'Bad', key: 'b', depends_on: ['a', '#4000'], labels: ['task', 'module:billing'], body: 'do it' },
  ] }] });
  assert.deepEqual(json.drafts.map((d) => [d.title, d.ready]), [['Epic: X', null], ['Good', true], ['Bad', false]]);
  assert.deepEqual(json.drafts[2].problems.filter((p) => p.level === 'error').map((p) => p.code).sort(), ['dep-missing', 'no-criteria', 'no-size', 'unknown-module']);
});

test('planner chat: issues only. No commit tool, and create_issues builds a backlog the loop can run', async () => {
  const tools = (await api('/api/chat/tools')).json;
  assert.equal(tools.mode, 'planner');
  assert.ok(!tools.tools.includes('commit_file'), 'the planner is not offered commit_file');
  for (const t of ['create_issues', 'create_issue', 'update_issue', 'check_issues', 'generate_file', 'attach_to_issue', 'create_label', 'create_milestone', 'sync_repo']) assert.ok(tools.tools.includes(t), t);
  const old = (await call(PORT + 2)('/api/chat/tools')).json;
  assert.deepEqual([old.mode, old.tools.includes('commit_file'), old.tools.includes('check_issues')], ['classic', true, true]);

  await api('/api/providers/save', { id: 'openai', apiKey: LLM_KEY, baseUrl: `${llm.origin}/v1`, models: ['mock-gpt'] });
  const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'acme/timesheet', chatId: 't', provider: 'openai', model: 'mock-gpt', autoApprove: true, message: '[[script:planner]] Plan a PDF export.' }) });
  const text = await res.text(); bodies.push(text);
  const events = text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
  const toolEvents = events.filter((e) => e.type === 'tool').map((e) => [e.name, events.find((r) => r.type === 'tool_result' && r.id === e.id)?.isError]);
  assert.deepEqual(toolEvents, [['create_issues', false], ['commit_file', true]], 'the model asked for commit_file and was told there is no such tool');
  assert.equal(events.at(-1).type, 'done');

  // What the model was told: the planner prompt, with the gate and modules of this repo.
  const sys = llm.log.find((e) => e.script === 'planner').body.messages[0].content;
  assert.match(sys, /ONLY thing you produce is GitHub issues/);
  assert.match(sys, /Modules \(MODULES\): module:api, module:web, module:reports/);
  assert.ok(!llm.log.some((e) => (e.body?.tools || []).some((t) => (t.function?.name || t.name) === 'commit_file')), 'commit_file is not in the tool list sent to the model');

  // What landed on GitHub: epic first, the dependency before its dependent, real numbers in the machine-read lines.
  const w = mock.worlds['acme/timesheet'];
  const made = w.issues.filter((i) => i.number >= 30).map((i) => ({ n: i.number, title: i.title, labels: i.labels.map((l) => l.name), body: i.body }));
  assert.deepEqual(made.map((i) => [i.n, i.title]), [[30, 'Epic: PDF export'], [31, 'Scaffold the PDF module'], [32, 'Render the PDF'], [33, 'Vague follow-up']]);
  assert.match(made[2].body, /Depends-on: #3 #31\nPart of epic #30$/);
  assert.match(made[1].body, /Part of epic #30$/);
  assert.ok(!/Depends-on/.test(made[1].body));
  assert.deepEqual([made[1].labels.at(-1), made[2].labels.at(-1), made[3].labels.at(-1)], ['status:ready', 'status:blocked', 'status:blocked']);
  assert.match(made[0].body, /## Tasks\n- \[ \] #32 Render the PDF\n- \[ \] #31 Scaffold the PDF module\n- \[ \] #33 Vague follow-up/);
  // The tool result told the model which issue is not ready, and why.
  const fed = llm.log.filter((e) => e.script === 'planner').at(-1).body.messages.find((m) => m.role === 'tool' && /readiness/.test(m.content)).content;
  assert.match(fed, /"number":33,"kind":"task","ready":false/);
  assert.match(fed, /Acceptance criteria.{0,6} checklist/);
  assert.match(fed, /1 task\(s\) are not ready for the loop yet/);
  const board = (await api('/api/loop?repo=acme/timesheet&fresh=1')).json;
  assert.deepEqual([board.cards.find((c) => c.number === 31).state, board.cards.find((c) => c.number === 32).state, board.cards.find((c) => c.number === 33).lint.ready], ['ready', 'blocked', false]);
});

test('model policy over HTTP: defaults, per-repo preset and tiers, risk listing; saving it writes nothing to GitHub', async () => {
  const before = writes();
  let p = (await api('/api/models/policy?repo=acme/nogate')).json;
  assert.deepEqual([p.preset, p.tiers, p.planner.model, p.risk.covered], ['balanced', { cheap: 'sonnet', strong: 'opus', top: 'fable' }, 'fable', true]);
  assert.equal((await api('/api/auth/status')).json.plannerModel, 'fable', 'the planner defaults to the top tier');
  assert.deepEqual(p.rows.map((r) => [r.key.replace('MODEL_', ''), r.recommended, r.tier]).slice(0, 6), [['IMPLEMENT_S', 'sonnet', 'cheap'], ['IMPLEMENT_M', 'sonnet', 'cheap'], ['IMPLEMENT_L', 'opus', 'strong'], ['REVIEW', 'fable', 'top'], ['REREVIEW', 'opus', 'strong'], ['PATCH', 'opus', 'strong']]);
  p = (await api('/api/models/policy', { repo: 'acme/nogate', preset: 'frugal', tiers: { cheap: 'haiku' }, sensitive: ['api'] })).json;
  assert.deepEqual([p.preset, p.tiers.cheap, p.risk.sensitive, p.risk.covered, p.risk.reviewTier, p.planner.recommended], ['frugal', 'haiku', ['api'], false, 'strong', 'opus']);
  assert.deepEqual(p.risk.tasks.map((t) => [t.number, t.why]), [[4, 'module:api is marked sensitive'], [10, 'module:api is marked sensitive'], [11, 'module:api is marked sensitive']]);
  assert.match(p.diff, /\+MODEL_IMPLEMENT_S="haiku"/);
  assert.equal((await api('/api/models/policy?repo=team/loop')).json.preset, 'balanced', 'the choice is per repo');
  assert.match((await api('/api/models/policy', { repo: 'acme/nogate', preset: 'nope' })).json.error, /Unknown preset/);
  assert.match((await api('/api/models/test', { repo: 'acme/nogate' })).json.error, /Confirmation required/);
  const t = (await api('/api/models/test', { repo: 'acme/nogate', confirm: true })).json;
  assert.deepEqual(t.results.map((x) => [x.model, x.ok]), [['haiku', true], ['opus', true], ['fable', true]]);
  assert.equal(writes(), before, 'no write reached GitHub');
});

test('no token appears in any response or in the server log', async () => {
  await new Promise((r) => setTimeout(r, 200));
  const all = bodies.join('\n') + out;
  for (const [k, t] of Object.entries({ ...TOK, LLM_KEY })) assert.ok(!all.includes(t), `leaked ${k}`);
  assert.match(out, /Chat mode: planner/);
  assert.match(out, /READ_ONLY=1: all writes to GitHub are blocked, and the delivery-loop runner is disabled/);
  assert.ok(!readFileSync(join(ROOT, 'server.mjs'), 'utf8').includes('dangerously-skip-permissions'));
});
