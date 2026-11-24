// The runner: starts, paces and stops delivery-loop sessions for a repo. It does not implement the loop. Each
// tick is one non-interactive Claude Code session running the plugin's own /delivery-loop:delivery-tick in the
// repo's workspace; this module decides WHETHER a tick may start (read-only mode, confirmation, plugin, gate,
// caps, one run per repo), builds its sandbox-ish launch (runner/command.mjs), watches its output, and can kill
// its whole process tree. State that matters (issues, labels, PRs) stays in GitHub.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepo } from '../repo-cache.mjs';
import { parseConf, gateStatus, readiness, modulesOf as confModules, CONF_PATH } from '../loop/conf.mjs';
import { checkPlugin } from './plugin.mjs';
import { AUTONOMY, buildArgs, buildEnv, permissions, promptFor, resolveClaude, tokenKind, splitList } from './command.mjs';
import { makeScrubber, parseStreamObject, effectOf, lineSplitter } from './log.mjs';
import { createWorkspaces, apiReader } from './workspace.mjs';

const num = (v, d, min = 0) => (Number.isFinite(Number(v)) && Number(v) > min ? Number(v) : d);
const today = () => new Date().toISOString().slice(0, 10);
const TAIL = 300;

/** Limits, all overridable from .env. */
export function limits(env = process.env) {
  return {
    tickTimeoutMs: num(env.RUNNER_TICK_TIMEOUT_S, 3600) * 1000, // kill a tick after this long
    maxTurns: num(env.RUNNER_MAX_TURNS, 200), // --max-turns for the orchestrator session
    dailyTicks: num(env.RUNNER_DAILY_TICKS, 40), // ticks per repo per UTC day
    intervalMs: num(env.RUNNER_INTERVAL_S, 120) * 1000, // pause between ticks in continuous mode
    idleMaxMs: num(env.RUNNER_IDLE_MAX_S, 1800) * 1000, // back off to this when ticks find nothing to do
    maxRepos: num(env.RUNNER_MAX_REPOS, 2), // repos running at the same time
    budgetUsd: num(env.RUNNER_TICK_BUDGET_USD, 0), // --max-budget-usd per tick (API billing); 0 = not passed
    parallelMax: 16,
  };
}

/** Kill a process and everything it started. */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

/**
 * @param o.dataDir     where .runner.json lives (next to the other app state)
 * @param o.workRoot    workspaces root (.workspaces)
 * @param o.runsRoot    tick logs root (.runs)
 * @param o.accounts    accounts.mjs instance (forRepo -> the token of the account that owns the repo)
 * @param o.claudeAuth  claude-auth.mjs instance (agentEnv -> the one Claude credential)
 * @param o.readOnly    READ_ONLY=1: the runner refuses to start anything
 */
export function createRunner({ dataDir, workRoot, runsRoot, accounts, claudeAuth, readOnly = false, env = process.env, apiHost = '', onChange = () => {} }) {
  const lim = limits(env);
  const FILE = join(dataDir, '.runner.json');
  const workspaces = createWorkspaces({ root: workRoot, remoteBase: env.RUNNER_GIT_REMOTE_BASE || 'https://github.com' });
  const pluginOpts = { configDir: env.CLAUDE_CONFIG_DIR || undefined, repo: env.RUNNER_PLUGIN_REPO || undefined, ref: env.RUNNER_PLUGIN_REF ?? undefined };
  const extraAllow = splitList(env.RUNNER_EXTRA_ALLOWED_TOOLS);
  const envPass = splitList(env.RUNNER_ENV_PASS);
  const live = new Map(); // repo key -> run state (in memory)
  let store = { version: 1, repos: {} };
  try { if (existsSync(FILE)) { const j = JSON.parse(readFileSync(FILE, 'utf8')); if (j?.repos && typeof j.repos === 'object') store = { version: 1, repos: j.repos }; } } catch { /* start clean */ }
  const save = () => { try { const tmp = `${FILE}.tmp`; writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 }); renameSync(tmp, FILE); } catch { /* state is advisory */ } };

  const cfg = (key) => (store.repos[key] ||= { autonomy: 'supervised', parallel: 3, counters: { ticks: 0, prsOpened: 0, merged: 0, escalations: 0, costUsd: 0 }, days: {} });
  const day = (key) => { const c = cfg(key); const d = today(); const old = Object.keys(c.days).sort().slice(0, -30); for (const k of old) if (k !== d) delete c.days[k]; return (c.days[d] ||= { ticks: 0, costUsd: 0 }); };
  const state = (key) => { if (!live.has(key)) live.set(key, { status: 'idle', mode: '', tick: null, child: null, timer: null, nextAt: 0, idleStreak: 0, lastTick: null, lastError: '', stopping: false, paused: false }); return live.get(key); };
  const active = (s) => ['starting', 'running', 'waiting', 'paused'].includes(s.status);
  const runsDir = (repo) => join(runsRoot, parseRepo(repo).key.replace('/', '__'));

  /** Files of the repo as the loop will see them: the workspace when it exists, else the default branch through the API. */
  async function readerFor(repo) {
    if (workspaces.exists(repo)) return { reader: workspaces.reader(repo), from: 'workspace' };
    const { gh } = await accounts.forRepo(repo);
    return { reader: apiReader(gh, repo), from: 'github' };
  }
  async function repoReadiness(repo) {
    const { full } = parseRepo(repo);
    const { reader, from } = await readerFor(full);
    return { repo: full, from, ...(await readiness(reader)) };
  }
  async function modulesOf(repo) {
    const { reader } = await readerFor(parseRepo(repo).full);
    return confModules(parseConf(await reader.read(CONF_PATH)).values);
  }

  function pub(key, repo) {
    const s = state(key); const c = cfg(key); const d = day(key);
    const t = s.tick;
    return {
      repo, status: s.status, mode: s.mode, pausing: s.paused && s.status === 'running', autonomy: c.autonomy, parallel: c.parallel, readOnly,
      tick: t ? { id: t.id, kind: t.kind, startedAt: t.startedAt, activity: t.activity, model: t.model, turns: t.turns, events: t.events.slice(-60), prompt: t.prompt } : null,
      lastTick: s.lastTick, lastError: s.lastError, nextAt: s.nextAt ? new Date(s.nextAt).toISOString() : null,
      counters: c.counters, today: { ticks: d.ticks, costUsd: Math.round(d.costUsd * 100) / 100, cap: lim.dailyTicks },
      limits: { tickTimeoutS: lim.tickTimeoutMs / 1000, maxTurns: lim.maxTurns, intervalS: lim.intervalMs / 1000, dailyTicks: lim.dailyTicks, budgetUsd: lim.budgetUsd },
    };
  }

  /** Everything the Run panel needs before the user presses Start: plugin, gate, token, and what a session may do. */
  async function preflight(repo) {
    const { full, key } = parseRepo(repo);
    const plugin = checkPlugin(pluginOpts);
    let ready = null, token = null, account = '', error = '';
    try { const a = await accounts.forRepo(full); account = a.login; token = tokenKind(a.token); } catch (e) { error = String(e.message || e); }
    try { ready = await repoReadiness(full); } catch (e) { error ||= String(e.message || e); }
    let claude = { ok: true, path: '', error: '' };
    try { claude.path = resolveClaude({ env }).display; } catch (e) { claude = { ok: false, path: '', error: String(e.message || e) }; }
    const c = cfg(key);
    const conf = ready?.conf || {};
    const blockers = [];
    if (readOnly) blockers.push({ code: 'read-only', text: 'READ_ONLY=1: the runner is disabled on this server.' });
    if (!claude.ok) blockers.push({ code: 'no-claude', text: claude.error });
    if (!plugin.ok) blockers.push({ code: 'plugin', text: plugin.problem });
    if (error) blockers.push({ code: 'github', text: error });
    if (ready && !ready.gate.ok) blockers.push({ code: 'no-gate', text: ready.gate.reason, action: 'setup' });
    return {
      ...pub(key, full), account, token, plugin: { ok: plugin.ok, installed: plugin.installed, version: plugin.version, source: plugin.source, ref: plugin.ref, expected: plugin.expected, problem: plugin.problem, help: plugin.ok ? [] : plugin.help },
      claude: { ok: claude.ok, error: claude.error, auth: claudeAuth.status().label, billing: claudeAuth.status().billing },
      gate: ready?.gate || null, initialized: ready?.initialized ?? false, workspace: workspaces.exists(full), blockers,
      permissions: { mode: 'acceptEdits', prompts: 'none', ...permissions({ kind: 'tick', autonomy: c.autonomy, conf, extra: extraAllow }), command: `claude -p "${promptFor({ kind: 'tick', autonomy: c.autonomy, parallel: c.parallel })}"` },
    };
  }

  function guardStart(key, { confirm }, what = 'starting the loop lets agents push branches and open pull requests on this repository.') {
    if (readOnly) throw new Error('READ_ONLY=1: the runner is disabled. Nothing was started.');
    if (confirm !== true) throw new Error(`Confirmation required: ${what}`);
    if (active(state(key))) throw new Error('A run is already active for this repository. Stop it first.');
    const running = [...live.entries()].filter(([k, s]) => k !== key && active(s)).length;
    if (running >= lim.maxRepos) throw new Error(`${running} repositories are already running (RUNNER_MAX_REPOS=${lim.maxRepos}). Stop one first.`);
    const plugin = checkPlugin(pluginOpts);
    if (!plugin.ok) throw new Error(`${plugin.problem} Install it yourself: ${plugin.help.join(' && ')}`);
    return plugin;
  }
  const capCheck = (key) => { if (day(key).ticks >= lim.dailyTicks) throw new Error(`Daily cap reached: ${lim.dailyTicks} ticks today for this repository (RUNNER_DAILY_TICKS).`); };

  /** Prepare the workspace and (for ticks) prove there is a gate. Returns what the session needs. */
  async function prepare(repo, kind) {
    const { full } = parseRepo(repo);
    const acct = await accounts.forRepo(full);
    const info = await acct.gh(`/repos/${full}`);
    const ws = await workspaces.ensure(full, { token: acct.token, branch: info.default_branch || 'main' });
    const reader = workspaces.reader(full);
    const parsed = parseConf(await reader.read(CONF_PATH));
    if (kind === 'tick') {
      if ((await reader.read(CONF_PATH)) === null) throw new Error('This repository is not set up for the delivery loop (no .claude/delivery.conf on the base branch). Run "Set up this repo" first.');
      const gate = await gateStatus(reader, parsed);
      if (!gate.ok) throw new Error(`No gate: ${gate.reason} The loop will not run without one. Use "Set up this repo", then review scripts/check.sh.`);
    }
    return { acct, ws, conf: parsed.values };
  }

  /** Scrub every string of an event. Applied before an event is used for anything, so no later copy can leak. */
  const clean = (scrub, ev) => {
    const e = { ...ev };
    for (const k of ['text', 'summary']) if (typeof e[k] === 'string') e[k] = scrub(e[k]);
    if (e.denials) e.denials = e.denials.map((d) => ({ ...d, summary: scrub(d.summary) }));
    return e;
  };
  function record(t, scrub, ev) {
    const e = { t: new Date().toISOString(), ...clean(scrub, ev) };
    t.events.push(e);
    if (t.events.length > TAIL) t.events.splice(0, t.events.length - TAIL);
    t.write = t.write.then(() => appendFile(t.file, `${JSON.stringify(e)}\n`)).catch(() => {});
    return e;
  }

  /** Run one session to completion. Resolves with a summary; never rejects for a failed tick. */
  async function runSession(repo, key, kind) {
    const s = state(key); const c = cfg(key);
    const { acct, ws, conf } = await prepare(repo, kind);
    const bin = resolveClaude({ env });
    const autonomy = kind === 'tick' ? c.autonomy : 'supervised';
    const args = buildArgs({ kind, autonomy, parallel: c.parallel, conf, maxTurns: lim.maxTurns, model: env.RUNNER_MODEL || claudeAuth.model() || '', budgetUsd: lim.budgetUsd, extraAllow });
    const childEnv = buildEnv({ base: env, token: acct.token, claudeEnv: claudeAuth.agentEnv({}), pass: envPass, apiHost });
    const scrub = makeScrubber([acct.token, childEnv.ANTHROPIC_API_KEY, childEnv.CLAUDE_CODE_OAUTH_TOKEN], (x) => claudeAuth.scrub(accounts.scrub(x)));

    const id = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(runsDir(repo), { recursive: true });
    const t = { id, kind, startedAt: new Date().toISOString(), activity: 'Starting Claude Code…', model: '', turns: 0, events: [], file: join(runsDir(repo), `${id}.jsonl`), write: Promise.resolve(), prompt: args[1], tools: new Map(), did: { dispatched: 0, prOpened: 0, merged: 0, escalation: 0 } };
    s.tick = t; s.status = 'running'; s.lastError = '';
    day(key).ticks += 1; c.counters.ticks += 1; save();
    record(t, scrub, { type: 'note', text: `${kind === 'init' ? 'Setup' : 'Tick'} started as @${acct.login} in ${autonomy} mode: ${args[1]}${ws.warning ? ` · ${ws.warning}` : ''}` });
    onChange(repo);

    return new Promise((done) => {
      let result = null; let timedOut = false; let pluginMissing = false;
      const child = spawn(bin.command, [...bin.prefix, ...args], { cwd: ws.dir, env: childEnv, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      s.child = child;
      const timer = setTimeout(() => { timedOut = true; record(t, scrub, { type: 'note', text: `Timed out after ${Math.round(lim.tickTimeoutMs / 60000)} minutes; killing the session.` }); killTree(child); }, lim.tickTimeoutMs);
      const out = lineSplitter((line) => {
        let o; try { o = JSON.parse(line); } catch { record(t, scrub, { type: 'note', text: line.slice(0, 500) }); return; }
        for (const raw of parseStreamObject(o)) {
          const ev = clean(scrub, raw);
          if (ev.type === 'init') {
            t.model = ev.model;
            if (!ev.plugin) { pluginMissing = true; record(t, scrub, { type: 'note', text: 'The delivery-loop plugin did not load in this session; stopping.' }); killTree(child); }
          } else if (ev.type === 'tool') {
            t.tools.set(ev.id, ev);
            t.activity = `${ev.sub ? 'Agent: ' : ''}${ev.name === 'Bash' ? '$ ' : `${ev.name} `}${scrub(ev.summary)}`.slice(0, 240);
            if (ev.name === 'Task' || ev.name === 'Agent') t.did.dispatched += 1;
          } else if (ev.type === 'tool_result') {
            const call = t.tools.get(ev.id);
            const eff = call && effectOf(call.name, call.summary, ev.isError);
            if (eff === 'prOpened') { t.did.prOpened += 1; c.counters.prsOpened += 1; }
            else if (eff === 'merged') { t.did.merged += 1; c.counters.merged += 1; }
            else if (eff === 'escalation') { t.did.escalation += 1; c.counters.escalations += 1; }
          } else if (ev.type === 'text') { if (!ev.sub) t.activity = scrub(ev.text).split('\n')[0].slice(0, 240); }
          else if (ev.type === 'result') { result = ev; t.turns = ev.turns; }
          record(t, scrub, ev);
        }
        onChange(repo);
      });
      const err = lineSplitter((line) => record(t, scrub, { type: 'stderr', text: line.slice(0, 800) }));
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      let finished = false;
      const finish = async (code, spawnError) => {
        if (finished) return; finished = true;
        clearTimeout(timer); out.end(); err.end();
        const cost = result?.costUsd || 0;
        day(key).costUsd += cost; c.counters.costUsd = Math.round((c.counters.costUsd + cost) * 10000) / 10000;
        const stopped = s.stopping;
        const error = spawnError ? scrub(spawnError.message) : stopped ? 'Stopped.' : timedOut ? 'Timed out.' : pluginMissing ? 'The delivery-loop plugin did not load.' : result?.isError ? (result.text || result.subtype || 'The session ended with an error.') : !result ? `Claude Code exited with code ${code} before finishing.` : '';
        const summary = { id, kind, startedAt: t.startedAt, endedAt: new Date().toISOString(), ok: !error, error: String(error).slice(0, 600), stopped, turns: result?.turns || 0, costUsd: cost, did: t.did, idle: !error && t.did.dispatched === 0 && t.did.merged === 0, denials: result?.denials || [], text: scrub(result?.text || '').slice(0, 3000) };
        record(t, scrub, { type: 'note', text: `${kind === 'init' ? 'Setup' : 'Tick'} ${error ? `ended: ${summary.error}` : summary.idle ? 'finished: nothing to dispatch.' : 'finished.'}` });
        await t.write;
        s.child = null; s.tick = null; s.lastTick = { ...summary, events: t.events.slice(-80) };
        save(); onChange(repo);
        done(summary);
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code) => finish(code, null));
    });
  }

  async function loop(repo, key, kind) {
    const s = state(key);
    for (;;) {
      if (s.stopping) break;
      let summary;
      try { capCheck(key); summary = await runSession(repo, key, kind); }
      catch (e) { s.lastError = claudeAuth.scrub(accounts.scrub(String(e.message || e))); break; }
      if (s.stopping || s.mode !== 'continuous' || kind !== 'tick') break;
      if (!summary.ok) { s.lastError = `Stopped after a failed tick: ${summary.error}`; break; } // never loop on errors
      s.idleStreak = summary.idle ? s.idleStreak + 1 : 0;
      if (!s.paused) {
        // Nothing to do last time: wait longer before spending another session on it.
        const wait = Math.min(lim.idleMaxMs, lim.intervalMs * 2 ** Math.min(s.idleStreak, 6));
        s.status = 'waiting'; s.nextAt = Date.now() + wait; onChange(repo);
        await new Promise((r) => { s.wake = r; s.timer = setTimeout(r, wait); });
        clearTimeout(s.timer); s.timer = null; s.wake = null; s.nextAt = 0;
        if (s.stopping) break;
      }
      if (s.paused) {
        s.status = 'paused'; onChange(repo);
        await new Promise((r) => { s.resume = r; });
        s.resume = null;
        if (s.stopping) break;
      }
    }
    s.status = 'idle'; s.mode = ''; s.stopping = false; s.paused = false; s.nextAt = 0; onChange(repo);
  }

  /** Start ticking. mode: 'once' | 'continuous'. Refuses without confirm: true, in read-only mode, without the plugin or a gate, over the caps, or while a run is active. */
  async function start(repo, { mode = 'once', confirm } = {}) {
    const { full, key } = parseRepo(repo);
    if (!['once', 'continuous'].includes(mode)) throw new Error('mode must be "once" or "continuous".');
    guardStart(key, { confirm });
    capCheck(key);
    const s = state(key);
    s.status = 'starting'; s.mode = mode; s.stopping = false; s.paused = false; s.idleStreak = 0; s.lastError = '';
    try { await prepare(full, 'tick'); resolveClaude({ env }); } // surface "no gate" / clone / binary errors to the caller, not later
    catch (e) { s.status = 'idle'; s.mode = ''; throw e; }
    void loop(full, key, 'tick');
    await new Promise((r) => setTimeout(r, 30));
    return pub(key, full);
  }

  /** Run /delivery-loop:init once. It creates labels on GitHub and scaffolds files, so it needs its own confirmation. */
  async function setup(repo, { confirm } = {}) {
    const { full, key } = parseRepo(repo);
    guardStart(key, { confirm }, 'setup creates the delivery-loop labels on GitHub and opens a pull request with the scaffolding.');
    capCheck(key);
    const s = state(key);
    s.status = 'starting'; s.mode = 'setup'; s.stopping = false; s.paused = false; s.lastError = '';
    try { await prepare(full, 'init'); resolveClaude({ env }); } catch (e) { s.status = 'idle'; s.mode = ''; throw e; }
    void loop(full, key, 'init');
    await new Promise((r) => setTimeout(r, 30));
    return pub(key, full);
  }

  /** Stop now: kill the session's whole process tree and cancel anything scheduled. */
  function stop(repo) {
    const { full, key } = parseRepo(repo);
    const s = state(key);
    if (!active(s)) return pub(key, full);
    s.stopping = true;
    if (s.timer) clearTimeout(s.timer);
    killTree(s.child);
    s.wake?.(); s.resume?.();
    onChange(full);
    return pub(key, full);
  }
  /** Global kill switch. */
  function stopAll() { const out = []; for (const [key, s] of live) if (active(s)) { stop(key); out.push(key); } return { stopped: out }; }
  /** Pause: let the current tick finish, then do not start another until resumed. */
  function pause(repo) {
    const { full, key } = parseRepo(repo); const s = state(key);
    if (s.mode !== 'continuous' || !active(s)) throw new Error('Only a continuous run can be paused.');
    s.paused = true;
    if (s.status === 'waiting') { clearTimeout(s.timer); s.status = 'paused'; s.nextAt = 0; s.wake?.(); }
    onChange(full); return pub(key, full);
  }
  function resume(repo) {
    const { full, key } = parseRepo(repo); const s = state(key);
    if (readOnly) throw new Error('READ_ONLY=1: the runner is disabled.');
    s.paused = false; s.resume?.();
    onChange(full); return pub(key, full);
  }

  /**
   * The autonomy dial. Raising it needs confirm: true; auto-merge additionally needs the repo's gate to exist
   * and check something, and the literal acknowledgement "auto-merge".
   */
  async function setAutonomy(repo, { autonomy, parallel, confirm, acknowledge } = {}) {
    const { full, key } = parseRepo(repo);
    if (!AUTONOMY.includes(autonomy)) throw new Error(`autonomy must be one of: ${AUTONOMY.join(', ')}.`);
    const c = cfg(key);
    if (active(state(key))) throw new Error('Stop the run before changing autonomy.');
    if (autonomy !== 'supervised') {
      if (readOnly) throw new Error('READ_ONLY=1: autonomy cannot be raised.');
      if (confirm !== true) throw new Error('Confirmation required to raise autonomy above Supervised.');
      if (autonomy === 'auto') {
        if (acknowledge !== 'auto-merge') throw new Error('Auto-merge lets agents merge their own pull requests. Type "auto-merge" to acknowledge.');
        const r = await repoReadiness(full);
        if (!r.gate.ok) throw new Error(`Auto-merge needs a gate: ${r.gate.reason}`);
      }
    }
    c.autonomy = autonomy;
    if (parallel !== undefined) c.parallel = Math.min(lim.parallelMax, Math.max(2, Math.floor(Number(parallel) || 3)));
    save(); onChange(full);
    return pub(key, full);
  }

  /** Past ticks of a repo, newest first, and the events of one. */
  async function history(repo, limit = 20) {
    try { return (await readdir(runsDir(repo))).filter((f) => f.endsWith('.jsonl')).sort().reverse().slice(0, limit).map((f) => f.replace(/\.jsonl$/, '')); } catch { return []; }
  }
  async function log(repo, id) {
    if (!/^[\w.-]{10,40}$/.test(String(id || ''))) throw new Error('Bad tick id.');
    const text = await readFile(join(runsDir(repo), `${id}.jsonl`), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).slice(-2000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  const status = (repo) => { const { full, key } = parseRepo(repo); return pub(key, full); };
  const anyActive = () => [...live.values()].some(active);
  process.once('exit', () => { for (const s of live.values()) killTree(s.child); });

  return { start, stop, stopAll, pause, resume, setup, setAutonomy, status, preflight, readiness: repoReadiness, modulesOf, history, log, anyActive, workspaces, limits: lim };
}
