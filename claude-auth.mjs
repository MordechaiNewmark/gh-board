// Claude credentials chosen in the Settings dialog. Secrets live only in this process and in .claude-auth.json
// (owner-only, git-ignored). The browser only ever sees the method, where it came from and a masked tail.
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const METHODS = ['login', 'oauth', 'apikey'];
const FIELD = { oauth: 'oauthToken', apikey: 'apiKey' };
const ENV_NAME = { oauth: 'CLAUDE_CODE_OAUTH_TOKEN', apikey: 'ANTHROPIC_API_KEY' };
const LABEL = { login: 'claude login session', oauth: 'OAuth token', apikey: 'API key' };
export const MODEL_CHOICES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]\/-]{0,99}$/;

export const mask = (s) => (s && s.length >= 12 ? `••••${s.slice(-4)}` : s ? '••••' : '');

/**
 * @param {object} o
 * @param {string} o.dir  folder holding .claude-auth.json
 * @param {string} [o.envFile] the app's .env (default: <dir>/.env)
 * @param {object} [o.env] process environment (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_MODEL, ANTHROPIC_BASE_URL)
 */
export function createClaudeAuth({ dir, envFile = join(dir, '.env'), env = process.env, fetchImpl = fetch } = {}) {
  const FILE = join(dir, '.claude-auth.json');
  let saved = { method: '', oauthToken: '', apiKey: '', model: null };
  try {
    if (existsSync(FILE)) {
      const j = JSON.parse(readFileSync(FILE, 'utf8'));
      saved = { method: METHODS.includes(j.method) ? j.method : '', oauthToken: String(j.oauthToken || ''), apiKey: String(j.apiKey || ''), model: typeof j.model === 'string' ? j.model : null };
    }
  } catch { /* unreadable settings: fall back to .env */ }

  // An API key counts as a fallback only when it is written in this app's own .env. One that merely happens to be
  // exported in the shell is ignored, so starting the server never moves chat onto API billing by accident.
  let dotenv = {};
  try { dotenv = parseEnv(readFileSync(envFile, 'utf8')); } catch {}
  const envSecret = { oauth: String(env.CLAUDE_CODE_OAUTH_TOKEN || '').trim(), apikey: String(dotenv.ANTHROPIC_API_KEY || '').trim() };
  const ambientApiKey = !!env.ANTHROPIC_API_KEY && !envSecret.apikey;

  const save = () => {
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
    try { chmodSync(FILE, 0o600); } catch {}
  };
  const secretFor = (m) => (m === 'login' ? '' : saved[FIELD[m]] || envSecret[m] || '');

  /** The method in force: the saved choice, else .env (OAuth token first, then an API key), else the login session. */
  function effective() {
    if (saved.method === 'login') return { method: 'login', source: 'saved', secret: '' };
    if (saved.method && secretFor(saved.method)) return { method: saved.method, source: saved[FIELD[saved.method]] ? 'saved' : 'env', secret: secretFor(saved.method) };
    if (envSecret.oauth) return { method: 'oauth', source: 'env', secret: envSecret.oauth };
    if (envSecret.apikey) return { method: 'apikey', source: 'env', secret: envSecret.apikey };
    return { method: 'login', source: 'default', secret: '' };
  }
  const model = () => (saved.model !== null ? saved.model : String(env.CLAUDE_MODEL || '').trim());
  const scrub = (text) => {
    let s = String(text ?? '');
    for (const t of [saved.oauthToken, saved.apiKey, envSecret.oauth, envSecret.apikey, env.ANTHROPIC_API_KEY]) if (t && t.length >= 8) s = s.split(t).join('***');
    return s;
  };

  function status() {
    const e = effective();
    return {
      method: e.method, label: LABEL[e.method], source: e.source, tail: mask(e.secret),
      billing: e.method === 'apikey' ? 'api' : 'subscription',
      saved: { oauth: mask(saved.oauthToken) || null, apikey: mask(saved.apiKey) || null },
      env: { oauth: !!envSecret.oauth, apikey: !!envSecret.apikey },
      ambientApiKeyIgnored: ambientApiKey,
      model: model(), modelSource: saved.model !== null ? 'saved' : env.CLAUDE_MODEL ? 'env' : 'default', models: MODEL_CHOICES,
    };
  }

  /** Choose a method, optionally storing a new secret for it and/or a model. */
  function update({ method, secret, model: m } = {}) {
    const next = { ...saved };
    if (m !== undefined) {
      const v = m === null ? null : String(m).trim();
      if (v && !MODEL_RE.test(v)) throw new Error('That does not look like a model name.');
      next.model = v;
    }
    if (method !== undefined) {
      if (!METHODS.includes(method)) throw new Error('Unknown Claude auth method.');
      const s = String(secret || '').trim();
      if (method === 'login') { if (s) throw new Error('The login session takes no secret.'); }
      else if (s) {
        if (/\s/.test(s) || s.length < 20 || s.length > 600) throw new Error(`That does not look like ${method === 'apikey' ? 'an Anthropic API key' : 'a Claude OAuth token'}.`);
        if (method === 'apikey' && s.startsWith('sk-ant-oat')) throw new Error('That looks like an OAuth token from `claude setup-token`. Choose "OAuth token" for it.');
        if (method === 'oauth' && s.startsWith('sk-ant-api')) throw new Error('That looks like an Anthropic API key. Choose "API key" for it.');
        next[FIELD[method]] = s;
      } else if (!next[FIELD[method]] && !envSecret[method]) {
        throw new Error(method === 'apikey' ? 'Paste an Anthropic API key first.' : 'Paste the token from `claude setup-token` first.');
      }
      next.method = method;
    } else if (secret) throw new Error('Choose a method for that secret.');
    saved = next; save();
    return status();
  }
  /** Forget the saved secret of a method. If it was the active method, fall back to .env or the login session. */
  function remove(method) {
    if (!FIELD[method]) throw new Error('Nothing to remove for that method.');
    saved[FIELD[method]] = '';
    if (saved.method === method && !envSecret[method]) saved.method = '';
    save();
    return status();
  }

  /** Environment for the agent subprocess: exactly one Claude credential (or none for the login session), no GitHub or app secrets. */
  function agentEnv(base = env) {
    const out = { ...base };
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'ACCESS_KEY']) delete out[k];
    const e = effective();
    if (e.method !== 'login' && e.secret) out[ENV_NAME[e.method]] = e.secret;
    return out;
  }

  /**
   * Check the active credential. An API key is validated with a free GET /v1/models; the OAuth token and the login
   * session have no such endpoint, so `runAgent(env, model)` sends one tiny prompt through the Agent SDK.
   */
  async function test({ runAgent } = {}) {
    const e = effective();
    const base = { method: e.method, label: LABEL[e.method], tail: mask(e.secret) };
    try {
      if (e.method === 'apikey') {
        const url = `${String(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/models?limit=1`;
        const res = await fetchImpl(url, { headers: { 'x-api-key': e.secret, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) });
        if (res.ok) return { ...base, ok: true, detail: 'Anthropic accepted the API key. Chat usage is billed to that API account.' };
        const j = await res.json().catch(() => ({}));
        const why = scrub(j?.error?.message || res.statusText || '');
        return { ...base, ok: false, error: res.status === 401 ? `Anthropic rejected the API key (401${why ? `: ${why}` : ''}).` : `Anthropic answered ${res.status}${why ? `: ${why}` : ''}.` };
      }
      if (!runAgent) throw new Error('No test runner available.');
      const detail = await runAgent(agentEnv(), model() || undefined);
      return { ...base, ok: true, detail: detail || 'Claude answered.' };
    } catch (err) {
      const msg = scrub(err?.name === 'TimeoutError' ? 'Timed out waiting for Anthropic.' : err?.message || err);
      return { ...base, ok: false, error: msg.slice(0, 400) };
    }
  }

  return { status, update, remove, agentEnv, model, test, effective: () => { const { method, source } = effective(); return { method, source }; }, scrub, FILE };
}
