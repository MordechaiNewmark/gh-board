// The runner, end to end, with nothing real: a stub in place of the Claude Code CLI (test/stub-claude.mjs),
// the local mock GitHub with fake tokens, and throwaway local git repos as the "remotes". No delivery loop is
// started against GitHub and no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccounts } from '../accounts.mjs';
import { createClaudeAuth } from '../claude-auth.mjs';
import { createRunner } from '../runner/index.mjs';
import { buildArgs, buildEnv, permissions, promptFor, tokenKind, resolveClaude, DENIED_TOOLS } from '../runner/command.mjs';
import { checkPlugin } from '../runner/plugin.mjs';
import { makeScrubber, parseStreamObject, effectOf } from '../runner/log.mjs';
import { startMock, TOK, GOOD_KEY } from './mock.mjs';
import { CONF, CHECK, EMPTY_CHECK } from './loop-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'stub-claude.mjs');
const mock = await startMock();
const root = mkdtempSync(join(tmpdir(), 'ghb-run-'));
test.after(async () => { await mock.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(50); } };

/* ---- throwaway git "remotes": <root>/remotes/<owner>/<name>.git ---- */
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' });
function remote(repo, files) {
  const src = mkdtempSync(join(root, 'src-'));
  git(src, 'init', '--quiet');
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(src, p)), { recursive: true }); writeFileSync(join(src, p), text); }
  git(src, 'add', '-A'); git(src, 'commit', '--quiet', '-m', 'init');
  const bare = join(root, 'remotes', `${repo}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(root, 'clone', '--quiet', '--bare', src, bare);
}
remote('acme/timesheet', { 'README.md': '# t\n', '.claude/delivery.conf': CONF, 'scripts/check.sh': CHECK });
remote('team/loop', { 'README.md': '# t\n', '.claude/delivery.conf': CONF, 'scripts/check.sh': CHECK });
remote('acme/nogate', { 'README.md': '# t\n', '.claude/delivery.conf': CONF, 'scripts/check.sh': EMPTY_CHECK });
remote('acme/fresh', { 'README.md': '# t\n' });

/* ---- a fake Claude Code config dir holding the plugin metadata ---- */
function claudeConfig({ repo = 'MordechaiNewmark/delivery-loop', ref = 'cost-aware-defaults', installed = true } = {}) {
  const dir = mkdtempSync(join(root, 'cc-'));
  const install = join(dir, 'plugins', 'cache', 'delivery-loop', 'delivery-loop', '0.1.5');
  mkdirSync(join(install, 'skills', 'delivery-tick'), { recursive: true });
  writeFileSync(join(install, 'skills', 'delivery-tick', 'SKILL.md'), '---\nname: delivery-tick\n---\n');
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed ? { 'delivery-loop@delivery-loop': [{ scope: 'user', installPath: install, version: '0.1.5', gitCommitSha: 'abc123' }] } : {} }));
  writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'delivery-loop': { source: { source: 'github', repo, ref } } }));
  return dir;
}
const GOOD_CC = claudeConfig();

const OTHER = { OPENAI_API_KEY: 'sk-FAKEopenai000000000000000000000001', GEMINI_API_KEY: 'AIzaFAKEgemini0000000000000000000002', ACCESS_KEY: 'FAKEaccesskey-000003', MY_DB_PASSWORD: 'FAKEpassword-000004', GITHUB_TOKEN: TOK.bob, GH_TOKEN: TOK.bob, GIT_ASKPASS: 'evil', CLAUDECODE: '1' };

/** A runner with two connected accounts (alice default, bob), a Claude API key saved in Settings, and the stub CLI. */
async function make({ readOnly = false, env = {}, key = GOOD_KEY } = {}) {
  const dir = mkdtempSync(join(root, 'data-'));
  const accounts = createAccounts({ dir, apiBase: mock.base, readOnly });
  await accounts.addToken(TOK.alice); await accounts.addToken(TOK.bob);
  const claudeAuth = createClaudeAuth({ dir, env: {} });
  if (key) claudeAuth.update({ method: 'apikey', secret: key });
  const dump = join(dir, 'dump.json'); const pids = join(dir, 'pids.txt');
  const runner = createRunner({
    dataDir: dir, workRoot: join(dir, '.workspaces'), runsRoot: join(dir, '.runs'), accounts, claudeAuth, readOnly,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, ...OTHER,
      CLAUDE_BIN: STUB, CLAUDE_CONFIG_DIR: GOOD_CC, RUNNER_GIT_REMOTE_BASE: join(root, 'remotes'), STUB_DUMP: dump, STUB_PIDS: pids, STUB_API: mock.base, STUB_REPO: 'acme/timesheet', RUNNER_INTERVAL_S: '1', ...env },
  });
  const idle = (repo) => until(() => runner.status(repo).status === 'idle' && runner.status(repo));
  return { dir, runner, accounts, dump: () => JSON.parse(readFileSync(dump, 'utf8')), pids, idle };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('argv: the plugin tick, restrictive permissions, no bypass flag, and no secret', () => {
  const conf = { GATE_CMD: 'bash scripts/check.sh', WORKTREE_SETUP_CMD: 'npm ci' };
  const a = buildArgs({ kind: 'tick', autonomy: 'supervised', conf, maxTurns: 150, model: 'sonnet' });
  assert.deepEqual(a.slice(0, 2), ['-p', '/delivery-loop:delivery-tick']);
  const opt = (name) => a[a.indexOf(name) + 1];
  assert.deepEqual([opt('--output-format'), opt('--max-turns'), opt('--permission-mode'), opt('--permission-prompts'), opt('--setting-sources'), opt('--model')], ['stream-json', '150', 'acceptEdits', 'none', 'user', 'sonnet']);
  for (const f of ['--verbose', '--strict-mcp-config', '--no-chrome', '--allowedTools', '--disallowedTools', '--append-system-prompt']) assert.ok(a.includes(f), f);
  assert.ok(!a.some((x) => /dangerously|bypassPermissions/i.test(x)), 'never bypasses permissions');
  assert.match(opt('--append-system-prompt'), /untrusted input/);
  assert.equal(promptFor({ autonomy: 'parallel', parallel: 4 }), '/delivery-loop:delivery-tick --parallel 4');
  assert.equal(promptFor({ autonomy: 'auto', parallel: 99 }), '/delivery-loop:delivery-tick --parallel 16 --auto-merge');
  assert.equal(promptFor({ kind: 'init' }), '/delivery-loop:init');
  assert.throws(() => buildArgs({ autonomy: 'yolo' }), /Unknown autonomy/);
});

test('allowlist: git, gh, jq, the gate, the setup command and the plugin scripts; network tools and merges denied', () => {
  const conf = { GATE_CMD: 'bash scripts/check.sh', WORKTREE_SETUP_CMD: 'npm ci' };
  const sup = permissions({ kind: 'tick', autonomy: 'supervised', conf });
  for (const r of ['Bash(git *)', 'Bash(gh *)', 'Bash(jq *)', 'Bash(bash scripts/check.sh)', 'Bash(bash scripts/check.sh *)', 'Bash(npm ci)', 'Bash(bash *scripts/task-queue.sh *)', 'Bash(bash *scripts/claim-task.sh" *)', 'Bash(bash *scripts/task-worktree.sh *)', 'Skill', 'Task', 'Read', 'Edit', 'Write', 'Glob', 'Grep'])
    assert.ok(sup.allow.includes(r), `allows ${r}`);
  assert.ok(!sup.allow.some((r) => /^Bash\((\*\)|bash \*\)|sh |npm \*|node|curl|python|powershell|cmd)/i.test(r) || r === 'Bash'), 'no blanket shell');
  assert.ok(!sup.allow.some((r) => /delivery-init/.test(r)), 'the init script is not reachable from a tick');
  for (const t of ['WebFetch', 'WebSearch', ...DENIED_TOOLS]) assert.ok(sup.deny.includes(t), `denies ${t}`);
  for (const r of ['Bash(gh pr merge *)', 'Bash(gh pr merge)', 'Bash(gh api *)', 'Bash(gh repo delete *)', 'Bash(gh repo create *)', 'Bash(gh auth *)', 'Bash(gh secret *)', 'Bash(git push --force *)', 'Bash(git config --global *)'])
    assert.ok(sup.deny.includes(r), `denies ${r}`);
  assert.ok(permissions({ autonomy: 'parallel', conf }).deny.includes('Bash(gh pr merge *)'), 'parallel is still human-merge');
  const auto = permissions({ autonomy: 'auto', conf });
  assert.ok(!auto.deny.some((r) => /gh pr merge/.test(r)), 'only auto-merge may merge');
  assert.ok(auto.deny.includes('Bash(gh api *)'));
  const init = permissions({ kind: 'init', autonomy: 'auto', conf: {} });
  assert.ok(init.allow.includes('Bash(bash *scripts/delivery-init.sh *)') && init.deny.includes('Bash(gh pr merge *)') && init.deny.includes('Bash(gh repo create *)'));
});

test('env: exactly one GitHub token, at most one Claude credential, nothing else that looks like a secret', () => {
  const env = buildEnv({ base: { PATH: '/bin', HOME: '/h', ...OTHER, ANTHROPIC_API_KEY: 'sk-ant-ambient', NPM_TOKEN: 'x', SSH_AUTH_SOCK: '/s', RUNNER_MODEL: 'm', READ_ONLY: '', KEEP_ME: 'k' }, token: TOK.alice, claudeEnv: { ANTHROPIC_API_KEY: GOOD_KEY }, pass: ['NPM_TOKEN'] });
  assert.deepEqual([env.GH_TOKEN, env.ANTHROPIC_API_KEY, env.PATH, env.KEEP_ME, env.NPM_TOKEN], [TOK.alice, GOOD_KEY, '/bin', 'k', 'x']);
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ACCESS_KEY', 'MY_DB_PASSWORD', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'CLAUDECODE', 'SSH_AUTH_SOCK', 'RUNNER_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(!(k in env), `${k} is not passed on`);
  const all = JSON.stringify(env);
  assert.ok(!all.includes(TOK.bob) && !all.includes('sk-ant-ambient'));
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from(`x-access-token:${TOK.alice}`).toString('base64')}`);
  assert.deepEqual([env.GIT_TERMINAL_PROMPT, env.GH_PROMPT_DISABLED], ['0', '1']);
  assert.ok(!('ANTHROPIC_API_KEY' in buildEnv({ base: { ANTHROPIC_API_KEY: 'ambient' }, token: TOK.alice })), 'login session: no Claude secret at all');
  assert.deepEqual([tokenKind('github_pat_11ABC').broad, tokenKind('ghp_abc').kind, tokenKind('ghp_abc').broad, tokenKind('gho_x').broad, tokenKind('ghs_x').broad], [false, 'classic', true, true, false]);
});

test('plugin check: installed fork passes; missing or upstream is refused with the commands to run, nothing is installed', () => {
  const ok = checkPlugin({ configDir: GOOD_CC });
  assert.deepEqual([ok.ok, ok.fork, ok.version, ok.source, ok.ref], [true, true, '0.1.5', 'MordechaiNewmark/delivery-loop', 'cost-aware-defaults']);
  const upstream = checkPlugin({ configDir: claudeConfig({ repo: 'blakemartz/delivery-loop', ref: '' }) });
  assert.equal(upstream.ok, false);
  assert.match(upstream.problem, /installed from blakemartz\/delivery-loop, not from MordechaiNewmark\/delivery-loop#cost-aware-defaults/);
  const missing = checkPlugin({ configDir: claudeConfig({ installed: false }) });
  assert.deepEqual([missing.ok, missing.installed], [false, false]);
  assert.deepEqual(missing.help, ['claude plugin marketplace add "MordechaiNewmark/delivery-loop#cost-aware-defaults"', 'claude plugin install delivery-loop@delivery-loop']);
  assert.equal(checkPlugin({ configDir: join(root, 'nope') }).ok, false);
  assert.equal(resolveClaude({ env: { CLAUDE_BIN: STUB } }).command, process.execPath, 'a .mjs CLAUDE_BIN runs under this Node');
  assert.throws(() => resolveClaude({ env: { CLAUDE_BIN: join(root, 'missing.exe') } }), /does not exist/);
});

test('refusals: READ_ONLY, no confirmation, plugin not the fork', async () => {
  const ro = await make({ readOnly: true });
  await assert.rejects(ro.runner.start('acme/timesheet', { mode: 'once', confirm: true }), /READ_ONLY=1: the runner is disabled/);
  await assert.rejects(ro.runner.setup('acme/timesheet', { confirm: true }), /READ_ONLY=1/);
  await assert.rejects(ro.runner.setAutonomy('acme/timesheet', { autonomy: 'parallel', confirm: true }), /READ_ONLY=1/);
  assert.equal((await ro.runner.preflight('acme/timesheet')).blockers[0].code, 'read-only');
  const r = await make();
  await assert.rejects(r.runner.start('acme/timesheet', { mode: 'once' }), /Confirmation required/);
  await assert.rejects(r.runner.start('acme/timesheet', { mode: 'once', confirm: 'yes' }), /Confirmation required/);
  await assert.rejects(r.runner.setup('acme/fresh', {}), /Confirmation required: setup creates the delivery-loop labels/);
  await assert.rejects(r.runner.start('../etc', { confirm: true }), /owner\/name|not a valid/);
  const bad = await make({ env: { CLAUDE_CONFIG_DIR: claudeConfig({ repo: 'blakemartz/delivery-loop', ref: '' }) } });
  await assert.rejects(bad.runner.start('acme/timesheet', { mode: 'once', confirm: true }), /not from MordechaiNewmark\/delivery-loop.*claude plugin marketplace add/s);
  for (const x of [ro, r, bad]) assert.equal(existsSync(join(x.dir, 'dump.json')), false, 'nothing was spawned');
});

test('refusals: a repo with no gate (seeded placeholder, or not set up) does not run; setup is offered instead', async () => {
  const r = await make();
  await assert.rejects(r.runner.start('acme/nogate', { mode: 'once', confirm: true }), /No gate: scripts\/check\.sh is the seeded placeholder/);
  await assert.rejects(r.runner.start('acme/fresh', { mode: 'once', confirm: true }), /not set up for the delivery loop/);
  assert.equal(r.runner.status('acme/nogate').status, 'idle');
  assert.equal(existsSync(join(r.dir, 'dump.json')), false, 'no session was started');
  const pre = await r.runner.preflight('acme/nogate');
  assert.deepEqual(pre.blockers.map((b) => [b.code, b.action]), [['no-gate', 'setup']]);
  await assert.rejects(r.runner.setAutonomy('acme/nogate', { autonomy: 'auto', confirm: true, acknowledge: 'auto-merge' }), /Auto-merge needs a gate/);
});

test('one tick: runs the plugin in the workspace as the repo\'s account, with only that account\'s token', async () => {
  const r = await make();
  const before = mock.log.length;
  const started = await r.runner.start('acme/timesheet', { mode: 'once', confirm: true });
  assert.ok(['starting', 'running', 'idle'].includes(started.status));
  const st = await r.idle('acme/timesheet');
  const d = r.dump();
  assert.deepEqual(d.argv.slice(0, 2), ['-p', '/delivery-loop:delivery-tick']);
  assert.equal(d.cwd.toLowerCase(), join(r.dir, '.workspaces', 'acme', 'timesheet').toLowerCase());
  assert.ok(existsSync(join(d.cwd, '.claude', 'delivery.conf')), 'the workspace is a real clone of the remote');
  assert.equal(readFileSync(join(d.cwd, '.git', 'config'), 'utf8').includes(TOK.alice), false, 'the token is not written into .git/config');
  // Credentials: alice owns the repo. Bob's token, provider keys, the access key and ambient secrets never reach the session.
  assert.equal(d.env.GH_TOKEN, TOK.alice);
  assert.equal(d.env.ANTHROPIC_API_KEY, GOOD_KEY);
  const envText = JSON.stringify(d.env);
  for (const [k, v] of Object.entries({ bob: TOK.bob, ...OTHER })) if (v.length > 4) assert.ok(!envText.includes(v), `${k} leaked into the session environment`);
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'ACCESS_KEY', 'GITHUB_TOKEN', 'MY_DB_PASSWORD']) assert.ok(!(k in d.env), k);
  assert.ok(!d.argv.join(' ').includes(TOK.alice) && !d.argv.join(' ').includes(GOOD_KEY), 'no secret on the command line');
  assert.ok(d.argv.includes('Bash(gh pr merge *)') && d.argv.indexOf('Bash(gh pr merge *)') > d.argv.indexOf('--disallowedTools'), 'supervised: merging is denied');
  // The stub's scripted side effect reached the mock with alice's token only.
  const writes = mock.log.slice(before).filter((e) => e.method === 'POST');
  assert.deepEqual(writes.map((e) => [e.login, e.path]), [['alice', '/repos/acme/timesheet/issues/8/comments']]);
  // Counters and the last tick summary come from the stream.
  assert.deepEqual(st.counters, { ticks: 1, prsOpened: 1, merged: 0, escalations: 1, costUsd: 0.42 });
  assert.deepEqual([st.lastTick.ok, st.lastTick.idle, st.lastTick.turns, st.lastTick.did.dispatched], [true, false, 4, 1]);
  assert.deepEqual(st.lastTick.denials, [{ tool: 'Bash', summary: 'gh pr merge 21 --squash' }], 'denied actions are surfaced, not hidden');
  assert.deepEqual(st.today, { ticks: 1, costUsd: 0.42, cap: 40 });
  const log = await r.runner.log('acme/timesheet', (await r.runner.history('acme/timesheet'))[0]);
  assert.deepEqual([...new Set(log.map((e) => e.type))].sort(), ['init', 'note', 'result', 'text', 'tool', 'tool_result']);
  assert.ok(log.some((e) => e.type === 'tool' && e.sub && /gh pr create/.test(e.summary)), 'subagent tool calls are logged');
});

test('the account that owns the repo is used, not the default one', async () => {
  const r = await make({ env: { STUB_REPO: 'team/loop' } });
  const before = mock.log.length;
  await r.runner.start('team/loop', { mode: 'once', confirm: true });
  await r.idle('team/loop');
  assert.equal(r.dump().env.GH_TOKEN, TOK.bob, 'bob is admin on team/loop; alice only reads it');
  assert.ok(!JSON.stringify(r.dump().env).includes(TOK.alice));
  assert.deepEqual(mock.log.slice(before).filter((e) => e.method === 'POST').map((e) => e.login), ['bob']);
});

test('concurrency: one run per repo, and the daily tick cap', async () => {
  const r = await make({ env: { STUB_MODE: 'hang', RUNNER_DAILY_TICKS: '1', RUNNER_MAX_REPOS: '1' } });
  await r.runner.start('acme/timesheet', { mode: 'once', confirm: true });
  await until(() => r.runner.status('acme/timesheet').status === 'running');
  await assert.rejects(r.runner.start('acme/timesheet', { mode: 'once', confirm: true }), /already active for this repository/);
  await assert.rejects(r.runner.setup('acme/timesheet', { confirm: true }), /already active/);
  await assert.rejects(r.runner.start('team/loop', { mode: 'once', confirm: true }), /RUNNER_MAX_REPOS=1/);
  await assert.rejects(r.runner.setAutonomy('acme/timesheet', { autonomy: 'supervised' }), /Stop the run/);
  r.runner.stop('acme/timesheet');
  await r.idle('acme/timesheet');
  await assert.rejects(r.runner.start('acme/timesheet', { mode: 'once', confirm: true }), /Daily cap reached: 1 ticks today/);
});

test('kill switch: Stop takes down the whole process tree', async () => {
  const r = await make({ env: { STUB_MODE: 'hang' } });
  await r.runner.start('acme/timesheet', { mode: 'continuous', confirm: true });
  const pids = await until(() => existsSync(r.pids) && readFileSync(r.pids, 'utf8').trim().split('\n').map(Number).length === 2 && readFileSync(r.pids, 'utf8').trim().split('\n').map(Number));
  assert.ok(pids.every(alive), 'the session and its grandchild are running');
  assert.match(r.runner.status('acme/timesheet').tick.activity, /\$ bash scripts\/check\.sh/);
  r.runner.stopAll();
  const st = await r.idle('acme/timesheet');
  await until(() => pids.every((p) => !alive(p)), 10000);
  assert.deepEqual([st.lastTick.stopped, st.lastTick.ok, st.mode], [true, false, ''], 'a stopped continuous run does not schedule another tick');
});

test('timeout: a tick that never finishes is killed', async () => {
  const r = await make({ env: { STUB_MODE: 'hang', RUNNER_TICK_TIMEOUT_S: '1' } });
  await r.runner.start('acme/timesheet', { mode: 'continuous', confirm: true });
  const st = await r.idle('acme/timesheet');
  assert.match(st.lastTick.error, /Timed out/);
  assert.match(st.lastError, /Stopped after a failed tick/, 'continuous mode never loops on a failing tick');
});

test('a session where the plugin did not load is stopped; a failing tick is reported', async () => {
  const np = await make({ env: { STUB_MODE: 'noplugin' } });
  await np.runner.start('acme/timesheet', { mode: 'once', confirm: true });
  assert.match((await np.idle('acme/timesheet')).lastTick.error, /plugin did not load/);
  const f = await make({ env: { STUB_MODE: 'fail' } });
  await f.runner.start('acme/timesheet', { mode: 'once', confirm: true });
  const st = await f.idle('acme/timesheet');
  assert.deepEqual([st.lastTick.ok, st.lastTick.error], [false, 'Reached the turn limit.']);
});

test('continuous mode: idle ticks back off, pause holds the next tick, resume and stop work', async () => {
  const r = await make({ env: { STUB_MODE: 'idle' } });
  await r.runner.start('acme/timesheet', { mode: 'continuous', confirm: true });
  const waiting = await until(() => r.runner.status('acme/timesheet').status === 'waiting' && r.runner.status('acme/timesheet'));
  assert.equal(waiting.lastTick.idle, true);
  assert.ok(Date.parse(waiting.nextAt) - Date.now() > 1000, 'an idle tick doubles the wait');
  assert.equal(r.runner.pause('acme/timesheet').status, 'paused');
  await sleep(300);
  assert.equal(r.runner.status('acme/timesheet').counters.ticks, 1, 'no tick starts while paused');
  r.runner.resume('acme/timesheet');
  await until(() => r.runner.status('acme/timesheet').counters.ticks === 2);
  r.runner.stop('acme/timesheet');
  assert.equal((await r.idle('acme/timesheet')).status, 'idle');
  await assert.rejects(async () => r.runner.pause('acme/timesheet'), /Only a continuous run can be paused/);
});

test('logs are scrubbed: tokens never reach the tick log, the status or the summary', async () => {
  const r = await make({ env: { STUB_MODE: 'leak' } });
  await r.runner.start('acme/timesheet', { mode: 'once', confirm: true });
  const st = await r.idle('acme/timesheet');
  const dir = join(r.dir, '.runs', 'acme__timesheet');
  const file = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8');
  const basic = Buffer.from(`x-access-token:${TOK.alice}`).toString('base64');
  for (const [where, text] of [['log file', file], ['status', JSON.stringify(st)], ['preflight', JSON.stringify(await r.runner.preflight('acme/timesheet'))]]) {
    for (const [k, v] of Object.entries({ alice: TOK.alice, basic, key: GOOD_KEY, unrelated: 'ghp_FAKEunrelated00000000000000000000000099' })) assert.ok(!text.includes(v), `${k} leaked into the ${where}`);
  }
  assert.match(file, /my token is \*\*\* and git has Authorization: \*\*\*/);
  assert.match(file, /"type":"stderr","text":"fatal: could not read \*\*\*"/);
  assert.ok(file.split('\n').filter(Boolean).every((l) => JSON.parse(l).t), 'one JSON event per line');
  const scrub = makeScrubber([TOK.alice]);
  assert.equal(scrub(`a ${TOK.alice} b github_pat_11AAAAAAAAAAAAAAAAAAAAAA_zz c sk-ant-oat01-abcdefghijklmnop d`), 'a *** b *** c *** d');
  assert.equal(scrub('git -c http.extraheader="Authorization: Basic QUJDREVGRw==" fetch'), 'git -c http.extraheader="Authorization: ***" fetch');
});

test('stream parsing: tool calls, subagents, results and what they did', () => {
  const init = parseStreamObject({ type: 'system', subtype: 'init', model: 'm', slash_commands: ['delivery-loop:delivery-tick'], mcp_servers: [] })[0];
  assert.deepEqual([init.type, init.plugin, init.mcp], ['init', true, 0]);
  assert.equal(parseStreamObject({ type: 'system', subtype: 'init', slash_commands: ['help'] })[0].plugin, false);
  const t = parseStreamObject({ type: 'assistant', parent_tool_use_id: 'p', message: { content: [{ type: 'text', text: ' hi ' }, { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'gh pr create --title t' } }] } });
  assert.deepEqual(t, [{ type: 'text', sub: true, text: 'hi' }, { type: 'tool', sub: true, id: 'x', name: 'Bash', summary: 'gh pr create --title t' }]);
  assert.deepEqual(parseStreamObject({ type: 'system', subtype: 'hook_started' }), []);
  assert.deepEqual(['gh pr create -t x', 'gh pr merge 3 --squash', 'gh issue edit 4 --add-label needs-human --remove-label status:claimed', 'gh pr edit 9 --add-label "needs-human"', 'gh issue edit 4 --add-label status:in-review', 'git push'].map((c) => effectOf('Bash', c, false)), ['prOpened', 'merged', 'escalation', 'escalation', null, null]);
  assert.equal(effectOf('Bash', 'gh pr create', true), null, 'a failed command did nothing');
});

test('autonomy dial: supervised by default; raising it needs confirmation, auto-merge needs a gate and an acknowledgement', async () => {
  const r = await make();
  assert.deepEqual([r.runner.status('acme/timesheet').autonomy, r.runner.status('acme/timesheet').parallel], ['supervised', 3]);
  await assert.rejects(r.runner.setAutonomy('acme/timesheet', { autonomy: 'parallel' }), /Confirmation required to raise autonomy/);
  await assert.rejects(r.runner.setAutonomy('acme/timesheet', { autonomy: 'auto', confirm: true }), /Type "auto-merge" to acknowledge/);
  assert.equal((await r.runner.setAutonomy('acme/timesheet', { autonomy: 'auto', parallel: 40, confirm: true, acknowledge: 'auto-merge' })).parallel, 16);
  await r.runner.start('acme/timesheet', { mode: 'once', confirm: true });
  await r.idle('acme/timesheet');
  const d = r.dump();
  assert.equal(d.argv[1], '/delivery-loop:delivery-tick --parallel 16 --auto-merge');
  assert.ok(!d.argv.some((a) => /gh pr merge/.test(a)), 'auto-merge is the only mode that does not deny merging');
  assert.equal((await r.runner.setAutonomy('acme/timesheet', { autonomy: 'supervised' })).autonomy, 'supervised', 'lowering it needs nothing');
  assert.equal(JSON.parse(readFileSync(join(r.dir, '.runner.json'), 'utf8')).repos['acme/timesheet'].autonomy, 'supervised');
});

test('setup: runs /delivery-loop:init through the same runner, only after confirmation', async () => {
  const r = await make({ env: { STUB_REPO: '' } });
  await r.runner.setup('acme/fresh', { confirm: true });
  const st = await r.idle('acme/fresh');
  const d = r.dump();
  assert.equal(d.argv[1], '/delivery-loop:init');
  assert.ok(d.argv.includes('Bash(bash *scripts/delivery-init.sh *)') && d.argv.includes('Bash(gh pr merge *)') && d.argv.includes('Bash(gh repo create *)'));
  assert.match(d.argv[d.argv.indexOf('--append-system-prompt') + 1], /open a pull request titled "Set up the delivery loop".*never merge/s);
  assert.deepEqual([st.lastTick.kind, st.lastTick.ok, st.mode], ['init', true, '']);
});
