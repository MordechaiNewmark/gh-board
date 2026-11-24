// Shared HTTP plumbing for the provider adapters: one fetch wrapper with timeouts, retries and readable,
// secret-free errors, plus a small server-sent-events reader.
import { allSecrets } from './store.mjs';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const FIRST_BYTE_MS = () => num(process.env.PROVIDER_FIRST_BYTE_TIMEOUT_S, 180) * 1000; // local models can take a while to load
export const IDLE_MS = () => num(process.env.PROVIDER_IDLE_TIMEOUT_S, 120) * 1000;

/** Remove every known key from a string. Used on all error text before it is shown or sent anywhere. */
export function scrub(text, extra = []) {
  let s = String(text ?? '');
  for (const k of [...allSecrets(), ...extra]) if (k && k.length >= 4) s = s.split(k).join('***');
  return s.replace(/(bearer\s+|x-goog-api-key:\s*|[?&]key=)[A-Za-z0-9._~+\/=-]{6,}/gi, '$1***');
}

export class ProviderError extends Error {
  constructor(message, { status, kind } = {}) { super(message); this.name = 'ProviderError'; this.status = status; this.kind = kind; }
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason || new Error('aborted')); }, { once: true });
});

function detail(bodyText) {
  let msg = '';
  try {
    const j = JSON.parse(bodyText);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    msg = typeof e === 'string' ? e : e?.message || j.message || j.detail || '';
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch { msg = /^\s*</.test(bodyText) ? '' : bodyText; }
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Turn an HTTP failure into one sentence that names the provider and says what to do. */
export function httpError(provider, model, status, bodyText) {
  const d = scrub(detail(bodyText), [provider.apiKey]);
  const tail = d ? ` (${d})` : '';
  const where = 'Settings > Providers';
  if (/tool|function.?call/i.test(d) && /not support|unsupported|no endpoints|does not|doesn't|cannot|invalid.*tools?\b/i.test(d) && [400, 404, 422, 501].includes(status)) {
    return new ProviderError(`${provider.label}: the model "${model}" does not support tool calling, which gh-board needs to read the board and the repo. Pick a tool-capable model${tail}.`, { status, kind: 'no-tools' });
  }
  if (status === 401 || status === 403) return new ProviderError(`${provider.label} rejected the API key (HTTP ${status}). Check or replace it in ${where}${tail}.`, { status, kind: 'auth' });
  if (status === 429) return new ProviderError(`${provider.label} rate limit or quota reached (HTTP 429). Wait a moment and retry, or check your plan and billing${tail}.`, { status, kind: 'rate-limit' });
  if (status === 404) return new ProviderError(`${provider.label} did not find the model "${model}" or the endpoint (HTTP 404). Check the model id and base URL in ${where}${tail}.`, { status, kind: 'not-found' });
  if (status === 400 || status === 422) return new ProviderError(`${provider.label} refused the request (HTTP ${status})${tail || ''}.`, { status, kind: 'bad-request' });
  if (status === 413) return new ProviderError(`${provider.label}: the conversation is too large for "${model}" (HTTP 413). Start a new chat or pick a model with a larger context${tail}.`, { status, kind: 'too-large' });
  if (status >= 500) return new ProviderError(`${provider.label} is having trouble (HTTP ${status}). Try again shortly${tail}.`, { status, kind: 'server' });
  return new ProviderError(`${provider.label} returned HTTP ${status}${tail}.`, { status, kind: 'http' });
}

export function networkError(provider, e, signal) {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : new Error('aborted');
  const code = e?.cause?.code || e?.code || '';
  let host = provider.baseUrl; try { host = new URL(provider.baseUrl).host; } catch {}
  if (e?.name === 'TimeoutError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return new ProviderError(`${provider.label} did not answer in time (${host}).`, { kind: 'timeout' });
  if (code === 'ECONNREFUSED') return new ProviderError(`Could not connect to ${provider.label} at ${host}: connection refused. Is it running, and is the base URL right?`, { kind: 'network' });
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ProviderError(`Could not find ${provider.label}'s host ${host}. Check the base URL and your network.`, { kind: 'network' });
  if (/redirect/i.test(String(e?.cause?.message || e?.message))) return new ProviderError(`${provider.label} answered with a redirect. Use the final https:// base URL.`, { kind: 'network' });
  return new ProviderError(`Could not reach ${provider.label} at ${host}${code ? ` (${code})` : ''}.`, { kind: 'network' });
}

/**
 * fetch() against a provider. Never follows redirects (so the auth header cannot be replayed elsewhere),
 * retries 429 / 5xx a couple of times, and throws ProviderError with scrubbed text.
 */
export async function providerFetch(provider, model, url, { method = 'POST', headers = {}, body, signal, retries = 2, timeoutMs } = {}) {
  for (let attempt = 0; ; attempt++) {
    // The timer only covers the wait for response headers; streaming has its own idle timeout in sse().
    const first = new AbortController();
    const timer = setTimeout(() => first.abort(), timeoutMs || FIRST_BYTE_MS());
    let res;
    try {
      res = await fetch(url, {
        method, redirect: 'error',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'gh-board', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, first.signal]) : first.signal,
      });
    } catch (e) {
      if (!signal?.aborted && first.signal.aborted) throw new ProviderError(`${provider.label} did not answer in time.`, { kind: 'timeout' });
      // A pooled keep-alive socket the other side already closed: try once more on a fresh connection.
      if (!signal?.aborted && attempt === 0 && ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'].includes(e?.cause?.code || e?.code)) continue;
      throw networkError(provider, e, signal);
    } finally { clearTimeout(timer); }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 529;
    const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt, 8000);
    if (retryable && attempt < retries && !/quota|billing|insufficient/i.test(text)) { await sleep(wait, signal); continue; }
    throw httpError(provider, model, res.status, text);
  }
}

/** Async iterator over the `data:` payloads of an SSE response. Enforces an idle timeout between chunks. */
export async function* sse(res, { signal, provider } = {}) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const idle = IDLE_MS();
  try {
    for (;;) {
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new ProviderError(`${provider?.label || 'The provider'} stopped sending data for ${Math.round(idle / 1000)}s.`, { kind: 'timeout' })), idle); });
      let chunk;
      try { chunk = await Promise.race([reader.read(), timeout]); }
      catch (e) { if (e instanceof ProviderError) throw e; throw networkError(provider || { label: 'The provider', baseUrl: '' }, e, signal); }
      finally { clearTimeout(timer); }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
    }
    const data = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (data) yield data;
  } finally { reader.cancel().catch(() => {}); }
}
