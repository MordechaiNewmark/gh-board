// Provider settings: non-secret config and API keys, persisted server-side in one owner-only, git-ignored file.
// Rules this module enforces:
//   - a key never leaves the process except as the auth header of a request to its own provider;
//   - the browser only ever gets publicView(): a masked tail and where the key came from;
//   - keys found in the environment are moved out of process.env at startup, so no child process
//     (git, gh, the Claude Code CLI) can inherit them.
import { readFileSync, writeFileSync, renameSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN, CLAUDE_ID, PRESETS, builtin, checkApiKey, checkBaseUrl, checkKeyEnv, checkLabel, checkModels, isKeyEnvName } from './registry.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let FILE = join(ROOT, '.providers.json');
const envKeys = new Map(); // env var name -> key, captured once at startup
const envUrls = new Map(); // provider id -> base URL override from the environment

/**
 * Call once, after .env is loaded. Captures provider keys from the environment and deletes them from
 * process.env. Returns the names (never the values) that were captured.
 */
export function initProviders({ env = process.env, file } = {}) {
  if (file || env.PROVIDERS_FILE) FILE = file || env.PROVIDERS_FILE;
  envKeys.clear(); envUrls.clear();
  for (const name of Object.keys(env)) {
    if (!isKeyEnvName(name)) continue;
    const v = String(env[name] || '').trim();
    if (v) envKeys.set(name, v);
    delete env[name];
  }
  for (const p of BUILTIN) {
    const v = p.baseUrlEnv && String(env[p.baseUrlEnv] || '').trim();
    if (v) { try { envUrls.set(p.id, checkBaseUrl(v).url); } catch { /* ignored: shown as a warning in the UI */ } }
  }
  return [...envKeys.keys()];
}

export const providersFile = () => FILE;

/** A short-lived key the platform hands over per request. A key set by the user wins. */
const offered = new Set();
export function offerKey(name, key) {
  if (envKeys.has(name) && !offered.has(name)) return;
  offered.add(name); envKeys.set(name, key);
}

/* ------------------------------ persistence ----------------------------- */

const blank = () => ({ version: 1, providers: {}, custom: [] });

function load() {
  let text;
  try { text = readFileSync(FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return blank(); throw new Error(`Cannot read the provider settings file: ${e.code || 'error'}`); }
  try {
    const j = JSON.parse(text);
    return { version: 1, providers: j.providers && typeof j.providers === 'object' ? j.providers : {}, custom: Array.isArray(j.custom) ? j.custom.filter((c) => c && typeof c.id === 'string') : [] };
  } catch { throw new Error('The provider settings file is not valid JSON. Fix or delete .providers.json.'); }
}

function persist(state) {
  // Write to a temp file that is owner-only from the first byte, then swap it in.
  const tmp = `${FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, FILE);
  } catch (e) { try { unlinkSync(tmp); } catch {} throw new Error(`Cannot save provider settings: ${e.code || 'error'}`); }
  try { chmodSync(FILE, 0o600); } catch {}
}

/** POSIX only: true when group or others can read the settings file. */
export function fileTooOpen() {
  if (process.platform === 'win32') return false;
  try { return (statSync(FILE).mode & 0o077) !== 0; } catch { return false; }
}

/** The saved settings, keys included: server-side only (the hosted board encrypts this into its database). */
export const snapshotProviders = () => load();
export const restoreProviders = (state) => persist(state);

/* -------------------------------- views --------------------------------- */

/** Masked form of a key for display: at most the last 4 characters, and only of keys long enough that 4 reveal little. */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  return k.length >= 16 ? `••••${k.slice(-4)}` : '••••';
}

function merged(state) {
  const out = [];
  for (const b of BUILTIN) {
    const s = state.providers[b.id] || {};
    if (b.kind === 'claude-agent-sdk') { out.push({ ...b, builtin: true, enabled: true }); continue; }
    out.push({
      id: b.id, label: b.label, kind: b.kind, builtin: true, needsKey: b.needsKey, keyUrl: b.keyUrl,
      baseUrlDefault: b.baseUrl, baseUrl: s.baseUrl || envUrls.get(b.id) || b.baseUrl, baseUrlSource: s.baseUrl ? 'saved' : envUrls.has(b.id) ? `env:${b.baseUrlEnv}` : 'default',
      models: Array.isArray(s.models) && s.models.length ? s.models : b.models,
      enabled: s.enabled !== false, savedKey: s.apiKey || '', keyEnv: b.keyEnv,
    });
  }
  for (const c of state.custom) {
    out.push({
      id: c.id, label: c.label, kind: 'openai-compatible', builtin: false, needsKey: !!c.needsKey,
      baseUrl: c.baseUrl, baseUrlSource: 'saved', models: Array.isArray(c.models) ? c.models : [],
      enabled: c.enabled !== false, savedKey: c.apiKey || '', keyEnv: c.keyEnv ? [c.keyEnv] : [],
    });
  }
  return out;
}

function keyOf(p) {
  if (p.savedKey) return { key: p.savedKey, source: 'saved' };
  for (const name of p.keyEnv || []) if (envKeys.has(name)) return { key: envKeys.get(name), source: `env:${name}` };
  return { key: '', source: null };
}

function status(p, key) {
  if (p.kind === 'claude-agent-sdk') return 'ready';
  if (!p.enabled) return 'off';
  if (p.needsKey && !key) return 'needs-key';
  if (!p.models.length) return 'needs-model';
  return 'ready';
}

function publicOne(p) {
  if (p.kind === 'claude-agent-sdk') return { id: p.id, label: p.label, kind: p.kind, builtin: true, needsKey: false, models: [], enabled: true, status: 'ready', hasKey: false, keySource: null, keyTail: '', warnings: [], note: p.note };
  const { key, source } = keyOf(p);
  let warnings = [];
  try { warnings = checkBaseUrl(p.baseUrl).warnings; } catch (e) { warnings = [String(e.message || e)]; }
  return {
    id: p.id, label: p.label, kind: p.kind, builtin: p.builtin, needsKey: p.needsKey, keyUrl: p.keyUrl,
    baseUrl: p.baseUrl, baseUrlDefault: p.baseUrlDefault, baseUrlSource: p.baseUrlSource,
    models: p.models, enabled: p.enabled, status: status(p, key),
    hasKey: !!key, keySource: source, keyTail: maskKey(key), keyEnv: p.keyEnv, warnings,
  };
}

/** Everything the browser may know. Contains no secret. */
export function publicView() {
  return { providers: merged(load()).map(publicOne), presets: PRESETS, defaultProvider: CLAUDE_ID, fileTooOpen: fileTooOpen() };
}

/**
 * Server-side only: the full config for one provider, including its key. Throws a readable error
 * when the provider cannot be used. Never serialize the return value.
 */
export function resolveProvider(id, { requireReady = true } = {}) {
  const p = merged(load()).find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider "${String(id).slice(0, 60)}". Pick one in the chat header.`);
  if (p.kind === 'claude-agent-sdk') return { ...p };
  const { key, source } = keyOf(p);
  if (requireReady) {
    if (!p.enabled) throw new Error(`${p.label} is turned off. Enable it in Settings > Providers.`);
    if (p.needsKey && !key) throw new Error(`${p.label} has no API key. Add one in Settings > Providers${p.keyEnv?.length ? ` or set ${p.keyEnv[0]} in .env` : ''}.`);
  }
  const { url } = checkBaseUrl(p.baseUrl);
  return { id: p.id, label: p.label, kind: p.kind, baseUrl: url, models: p.models, enabled: p.enabled, apiKey: key, keySource: source };
}

/* ------------------------------- mutations ------------------------------ */

/** Update a provider. patch: { apiKey?, clearKey?, baseUrl?, models?, enabled?, label?, keyEnv?, needsKey? }. */
export function saveProvider(id, patch = {}) {
  if (id === CLAUDE_ID) throw new Error('Claude is configured through its own sign-in, not here.');
  const state = load();
  const b = builtin(id);
  const target = b ? (state.providers[id] ||= {}) : state.custom.find((c) => c.id === id);
  if (!target) throw new Error('Unknown provider.');

  if (patch.clearKey) delete target.apiKey;
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) target.apiKey = checkApiKey(patch.apiKey);
  if (patch.enabled !== undefined) target.enabled = !!patch.enabled;
  if (patch.models !== undefined) {
    const models = checkModels(patch.models);
    if (b && !models.length) delete target.models; else target.models = models;
  }
  if (patch.baseUrl !== undefined) {
    const raw = String(patch.baseUrl ?? '').trim();
    // A saved key belongs to the server it was entered for: pointing the provider elsewhere forgets it.
    const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
    const before = target.baseUrl || (b ? envUrls.get(id) || b.baseUrl : '');
    const after = raw ? origin(checkBaseUrl(raw).url) : origin(b ? envUrls.get(id) || b.baseUrl : '');
    if (origin(before) !== after && !String(patch.apiKey ?? '').trim()) delete target.apiKey;
    if (b && (!raw || checkBaseUrl(raw).url === b.baseUrl)) delete target.baseUrl;
    else target.baseUrl = checkBaseUrl(raw).url;
  }
  if (!b) {
    if (patch.label !== undefined) target.label = checkLabel(patch.label);
    if (patch.keyEnv !== undefined) target.keyEnv = checkKeyEnv(patch.keyEnv);
    if (patch.needsKey !== undefined) target.needsKey = !!patch.needsKey;
  }
  persist(state);
  return publicView();
}

export function addCustom(input = {}) {
  const state = load();
  if (state.custom.length >= 20) throw new Error('At most 20 custom providers.');
  const label = checkLabel(input.label);
  if (merged(state).some((p) => p.label.toLowerCase() === label.toLowerCase())) throw new Error(`A provider named "${label}" already exists.`);
  const entry = {
    id: `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'provider'}-${randomBytes(3).toString('hex')}`,
    label, baseUrl: checkBaseUrl(input.baseUrl).url, models: checkModels(input.models ?? []),
    keyEnv: checkKeyEnv(input.keyEnv), needsKey: input.needsKey !== undefined ? !!input.needsKey : !!(input.apiKey || input.keyEnv), enabled: true,
  };
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) entry.apiKey = checkApiKey(input.apiKey);
  state.custom.push(entry);
  persist(state);
  return { id: entry.id, ...publicView() };
}

/** Remove a custom provider, or forget everything saved for a built-in one (its key included). */
export function removeProvider(id) {
  if (id === CLAUDE_ID) throw new Error('Claude cannot be removed.');
  const state = load();
  if (builtin(id)) delete state.providers[id];
  else {
    const n = state.custom.length;
    state.custom = state.custom.filter((c) => c.id !== id);
    if (state.custom.length === n) throw new Error('Unknown provider.');
  }
  persist(state);
  return publicView();
}

/** Every secret this module knows, for scrubbing error text. Server-side only. */
export function allSecrets() {
  const out = new Set(envKeys.values());
  try { const s = load(); for (const p of [...Object.values(s.providers), ...s.custom]) if (p?.apiKey) out.add(p.apiKey); } catch {}
  return [...out];
}
