// Google Gemini adapter (generativelanguage API, streamGenerateContent over SSE). Plain fetch, no SDK.
// The key goes in the x-goog-api-key header, never in the URL, so it cannot end up in logs or error text.
import { ProviderError, providerFetch, sse, scrub } from './http.mjs';

const auth = (p) => (p.apiKey ? { 'x-goog-api-key': p.apiKey } : {});
const modelPath = (m) => `models/${encodeURIComponent(String(m).replace(/^models\//, ''))}`;

/** JSON Schema -> the subset Gemini accepts for function parameters. */
export function geminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(geminiSchema);
  const out = {};
  let nullable = false;
  let src = s;
  const alts = s.anyOf || s.oneOf;
  if (Array.isArray(alts)) {
    const rest = alts.filter((a) => a?.type !== 'null');
    if (rest.length !== alts.length) nullable = true;
    if (rest.length === 1) src = { ...s, ...rest[0] };
    else if (rest.length > 1) out.anyOf = rest.map(geminiSchema);
  }
  for (const [k, v] of Object.entries(src)) {
    if (['$schema', '$id', '$defs', 'additionalProperties', 'default', 'anyOf', 'oneOf', 'propertyNames', 'unevaluatedProperties', 'const', 'examples', 'title'].includes(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const t = v.filter((x) => x !== 'null');
      if (t.length !== v.length) nullable = true;
      out.type = t[0] || 'string';
    } else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, geminiSchema(p)]));
    else if (k === 'items') out.items = geminiSchema(v);
    else out[k] = v;
  }
  if (src.const !== undefined && !out.enum) out.enum = [src.const];
  if (nullable) out.nullable = true;
  return out;
}

function toolDecl(t) {
  const params = geminiSchema(t.schema);
  const has = params?.properties && Object.keys(params.properties).length > 0;
  return { name: t.name, description: t.description, ...(has ? { parameters: params } : {}) };
}

const asObject = (content, isError) => {
  let v; try { v = JSON.parse(content); } catch { v = content; }
  return isError ? { error: typeof v === 'string' ? v : JSON.stringify(v) } : { result: v };
};

/** Normalized history -> Gemini `contents`. Model turns replay their original parts, which carry thought signatures. */
export function toWire(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.text }, ...(m.images || []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.data } }))] });
    } else if (m.role === 'assistant') {
      const parts = m.raw?.gemini || [
        ...(m.text ? [{ text: m.text }] : []),
        ...(m.toolCalls || []).map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } })),
      ];
      if (parts.length) out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: asObject(r.content, r.isError), ...(r.providerId ? { id: r.providerId } : {}) } })) });
    }
  }
  return out;
}

/** One model turn, streamed. Same contract as openai.streamTurn; `raw` keeps the parts to replay next turn. */
export async function streamTurn({ provider, model, system, messages, tools, signal, onText }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toWire(messages),
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map(toolDecl) }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
  };
  const res = await providerFetch(provider, model, `${provider.baseUrl}/${modelPath(model)}:streamGenerateContent?alt=sse`, { headers: { Accept: 'text/event-stream', ...auth(provider) }, body, signal });

  let text = ''; let finish = null; let blocked = '';
  const parts = []; const toolCalls = [];
  const take = (j) => {
    if (j.error) throw new ProviderError(`${provider.label}: ${scrub(j.error.message || JSON.stringify(j.error)).slice(0, 300)}`, { kind: 'stream' });
    if (j.promptFeedback?.blockReason) blocked = j.promptFeedback.blockReason;
    const c = j.candidates?.[0];
    if (!c) return;
    for (const p of c.content?.parts || []) {
      if (p.functionCall) {
        parts.push(p);
        toolCalls.push({ id: `gem_${Date.now().toString(36)}_${toolCalls.length}`, providerId: p.functionCall.id, name: p.functionCall.name, argsText: JSON.stringify(p.functionCall.args ?? {}) });
      } else if (typeof p.text === 'string') {
        if (p.thought) continue; // thought summaries are not shown or replayed
        const tail = parts[parts.length - 1];
        if (tail && typeof tail.text === 'string' && !tail.thoughtSignature && !p.thoughtSignature) tail.text += p.text; else parts.push({ ...p });
        if (p.text) { text += p.text; onText?.(p.text); }
      } else parts.push(p);
    }
    if (c.finishReason) finish = c.finishReason;
  };

  if (!/event-stream/i.test(res.headers.get('content-type') || '')) {
    const j = await res.json().catch(() => null);
    if (!j) throw new ProviderError(`${provider.label} sent a response gh-board could not read. Check the base URL.`, { kind: 'protocol' });
    for (const one of Array.isArray(j) ? j : [j]) take(one);
  } else {
    for await (const data of sse(res, { signal, provider })) {
      let j; try { j = JSON.parse(data); } catch { continue; }
      take(j);
    }
  }
  if (blocked) throw new ProviderError(`${provider.label} blocked the request (${blocked}).`, { kind: 'filtered' });
  if (!text && !toolCalls.length && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(finish)) throw new ProviderError(`${provider.label} stopped without an answer (${finish}).`, { kind: 'filtered' });
  return { text, toolCalls, finish, malformed: finish === 'MALFORMED_FUNCTION_CALL' || finish === 'UNEXPECTED_TOOL_CALL', raw: { gemini: parts } };
}

/** Cheap connectivity check: list models. Needs a valid key and spends no tokens. */
export async function testConnection(provider, model, signal) {
  const res = await providerFetch(provider, model || '', `${provider.baseUrl}/models?pageSize=200`, { method: 'GET', headers: auth(provider), signal, retries: 0, timeoutMs: 15000 });
  const j = await res.json().catch(() => ({}));
  const models = (Array.isArray(j.models) ? j.models : [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
  const want = String(model || '').replace(/^models\//, '');
  return { ok: true, models, message: `Connected to ${provider.label}: ${models.length} model${models.length === 1 ? '' : 's'} available.${want && models.length && !models.includes(want) ? ` Note: "${want}" is not in the list.` : ''}` };
}
