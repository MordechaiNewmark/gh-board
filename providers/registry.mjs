// The provider registry: which LLM backends the chat can run on, and the validation rules for their config.
// Nothing in this file holds a secret. Keys live in store.mjs.

/** @typedef {'claude-agent-sdk' | 'openai' | 'gemini' | 'openai-compatible'} ProviderKind */

export const CLAUDE_ID = 'claude';

/** Built-in providers. `models` are editable defaults; ids change often, so the UI can also load them from the provider. */
export const BUILTIN = [
  {
    id: CLAUDE_ID, label: 'Claude', kind: 'claude-agent-sdk', needsKey: false, models: [],
    note: 'Runs through the Claude Agent SDK with your Claude sign-in. Best at long multi-step analysis.',
  },
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', needsKey: true,
    baseUrl: 'https://api.openai.com/v1', baseUrlEnv: 'OPENAI_BASE_URL', keyEnv: ['OPENAI_API_KEY'],
    models: ['gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'gemini', needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', baseUrlEnv: 'GEMINI_BASE_URL', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
];

/** Starting points for "Add custom provider". All speak the OpenAI chat-completions protocol. */
export const PRESETS = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', needsKey: true, example: 'openai/gpt-5-mini' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', needsKey: true, example: 'llama-3.3-70b-versatile' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', needsKey: true, example: 'mistral-large-latest' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyEnv: '', needsKey: false, example: 'qwen2.5-coder:14b' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', keyEnv: '', needsKey: false, example: '' },
];

export const builtin = (id) => BUILTIN.find((p) => p.id === id);

/* ------------------------------ validation ------------------------------ */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);
export const isLocalHost = (hostname) => LOCAL_HOSTS.has(String(hostname).toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(hostname) || String(hostname).toLowerCase().endsWith('.localhost');

/**
 * Validate a provider base URL. http and https only, no credentials in the URL, no query or fragment.
 * Returns { url, warnings }. Throws a readable Error on anything else.
 */
export function checkBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Base URL is required.');
  if (raw.length > 500) throw new Error('Base URL is too long.');
  let u;
  try { u = new URL(raw); } catch { throw new Error('Base URL is not a valid URL (expected something like https://api.example.com/v1).'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Base URL must start with http:// or https://.');
  if (u.username || u.password) throw new Error('Do not put credentials in the base URL; use the API key field.');
  if (u.search || u.hash) throw new Error('Base URL must not contain a query string or fragment.');
  if (!u.hostname) throw new Error('Base URL has no host.');
  if (/\/\/|:/.test(u.pathname)) throw new Error('Base URL looks like two addresses pasted together. Enter one URL, like https://api.example.com/v1.');
  const warnings = [];
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) warnings.push(`${u.host} is plain http and not this computer: the API key and everything the model reads would travel unencrypted.`);
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, warnings };
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,149}$/;
export function checkModel(m) {
  const s = String(m ?? '').trim();
  if (!MODEL_RE.test(s) || s.includes('..') || s.includes('//')) throw new Error(`"${s.slice(0, 60)}" is not a valid model id.`);
  return s;
}
export function checkModels(list) {
  if (!Array.isArray(list)) throw new Error('models must be a list.');
  const out = [...new Set(list.map((m) => String(m ?? '').trim()).filter(Boolean).map(checkModel))];
  if (out.length > 60) throw new Error('At most 60 models per provider.');
  return out;
}

export function checkLabel(label) {
  const s = String(label ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  if (!s) throw new Error('Give the provider a name.');
  if (s.length > 40) throw new Error('Provider names are limited to 40 characters.');
  return s;
}

/** Env var names that may hold a provider key. Deliberately narrow, so config can never point at GITHUB_TOKEN and friends. */
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]{1,60}_API_KEY$/;
export const isKeyEnvName = (name) => KEY_ENV_RE.test(String(name)) && name !== 'ANTHROPIC_API_KEY';
export function checkKeyEnv(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  if (!isKeyEnvName(s)) throw new Error('The key environment variable must be upper-case and end with _API_KEY (for example GROQ_API_KEY).');
  return s;
}

export function checkApiKey(key) {
  const s = String(key ?? '').trim();
  if (!s) throw new Error('The API key is empty.');
  if (s.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(s)) throw new Error('That does not look like an API key (no spaces or line breaks).');
  return s;
}
