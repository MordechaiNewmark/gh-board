// OpenAI chat-completions adapter. Used for OpenAI itself and for every OpenAI-compatible endpoint
// (OpenRouter, Groq, Mistral, Ollama, LM Studio, ...). Plain fetch + SSE: no SDK, so nothing reads
// keys from the environment behind our back and the wire format is exactly what the tests exercise.
import { ProviderError, providerFetch, sse, scrub } from './http.mjs';

const auth = (p) => (p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {});

/** Normalized history -> chat-completions messages. */
export function toWire(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.images?.length ? [{ type: 'text', text: m.text }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))] : m.text });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || null };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argsText ?? JSON.stringify(c.args ?? {}) } }));
      if (msg.content === null && !msg.tool_calls) msg.content = '';
      out.push(msg);
    } else if (m.role === 'tool') {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    }
  }
  return out;
}

/**
 * One model turn, streamed. Calls onText(delta) as text arrives.
 * Returns { text, toolCalls: [{ id, name, argsText }], finish }.
 */
export async function streamTurn({ provider, model, system, messages, tools, signal, onText }) {
  const body = {
    model, stream: true, messages: toWire(system, messages),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })), tool_choice: 'auto' } : {}),
  };
  const res = await providerFetch(provider, model, `${provider.baseUrl}/chat/completions`, { headers: { Accept: 'text/event-stream', ...auth(provider) }, body, signal });

  let text = ''; let finish = null;
  const calls = []; // by stream index
  const take = (list) => {
    for (const tc of list || []) {
      // Some servers omit `index` and send each call whole: a chunk with a name starts a new call, one without continues the last.
      let idx;
      if (Number.isInteger(tc.index)) idx = tc.index;
      else if (tc.id && calls.some((c) => c?.id === tc.id)) idx = calls.findIndex((c) => c?.id === tc.id);
      else if (tc.function?.name || !calls.length) idx = calls.length;
      else idx = calls.length - 1;
      const c = (calls[idx] ||= { id: '', name: '', argsText: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name = tc.function.name;
      const a = tc.function?.arguments;
      if (typeof a === 'string') c.argsText += a;
      else if (a && typeof a === 'object') c.argsText = JSON.stringify(a);
    }
  };

  if (!/event-stream/i.test(res.headers.get('content-type') || '')) {
    // The server ignored stream:true and answered with one JSON document.
    const j = await res.json().catch(() => null);
    if (j?.error) throw new ProviderError(`${provider.label}: ${scrub(j.error.message || JSON.stringify(j.error)).slice(0, 300)}`, { kind: 'stream' });
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new ProviderError(`${provider.label} sent a response gh-board could not read. Is the base URL an OpenAI-compatible /v1 endpoint?`, { kind: 'protocol' });
    if (typeof msg.content === 'string' && msg.content) { text = msg.content; onText?.(text); }
    take(msg.tool_calls);
    finish = j.choices[0].finish_reason || null;
  } else {
    for await (const data of sse(res, { signal, provider })) {
      if (data === '[DONE]') break;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new ProviderError(`${provider.label}: ${scrub(j.error.message || JSON.stringify(j.error)).slice(0, 300)}`, { kind: 'stream' });
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || ch.message || {};
      if (typeof d.content === 'string' && d.content) { text += d.content; onText?.(d.content); }
      take(d.tool_calls);
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const toolCalls = calls.filter((c) => c && c.name).map((c, i) => ({ id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.name, argsText: c.argsText || '{}' }));
  if (finish === 'content_filter' && !text && !toolCalls.length) throw new ProviderError(`${provider.label} blocked this response with its content filter.`, { kind: 'filtered' });
  return { text, toolCalls, finish };
}

/** Cheap connectivity check: list models (no tokens spent), then for compatible endpoints a 1-token ping, since some list models without auth. */
export async function testConnection(provider, model, signal) {
  let models = []; let listed = false;
  try {
    const res = await providerFetch(provider, model || '', `${provider.baseUrl}/models`, { method: 'GET', headers: auth(provider), signal, retries: 0, timeoutMs: 15000 });
    const j = await res.json().catch(() => ({}));
    const data = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : [];
    models = data.map((m) => String(m.id || m.name || '')).filter(Boolean).sort().slice(0, 400);
    listed = true;
  } catch (e) {
    // No /models route is fine for a compatible server; anything else (401, refused, ...) is the answer.
    if (!(e instanceof ProviderError && e.kind === 'not-found' && provider.kind === 'openai-compatible' && model)) throw e;
  }
  if (provider.kind === 'openai' || !model) {
    return { ok: true, models, message: `Connected to ${provider.label}${listed ? `: ${models.length} model${models.length === 1 ? '' : 's'} available` : ''}.${model && listed && models.length && !models.includes(model) ? ` Note: "${model}" is not in the list.` : ''}` };
  }
  const res = await providerFetch(provider, model, `${provider.baseUrl}/chat/completions`, { headers: auth(provider), body: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }, signal, retries: 0, timeoutMs: 60000 });
  await res.text().catch(() => '');
  return { ok: true, models, message: `Connected to ${provider.label}: "${model}" answered.` };
}
