// Turning a Claude Code `--output-format stream-json` stream into a small, scrubbed event log.
// Every string that reaches the log file, the UI or the server console goes through the scrubber first.

const PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /(authorization:\s*)(?:basic|bearer|token)\s+[^\s"'\\]+/gi, /(x-access-token:)[^@\s"'\\]+/gi,
  /((?:GH_TOKEN|GITHUB_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GIT_CONFIG_VALUE_\d+)\s*[=:]\s*)[^\s"'\\]+/g,
];

/** Build a scrubber for a set of known secrets (exact values and their git Basic-auth form) plus token-shaped strings. */
export function makeScrubber(secrets = [], also = (s) => s) {
  const exact = new Set();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 8) continue;
    exact.add(s);
    exact.add(Buffer.from(`x-access-token:${s}`).toString('base64'));
    exact.add(Buffer.from(s).toString('base64'));
  }
  const list = [...exact].sort((a, b) => b.length - a.length);
  return (v) => {
    let s = String(v ?? '');
    for (const t of list) if (s.includes(t)) s = s.split(t).join('***');
    for (const re of PATTERNS) s = s.replace(re, (m, p1) => (typeof p1 === 'string' ? `${p1}***` : '***'));
    return also(s);
  };
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}… (+${s.length - n})` : s; };
const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : b?.type ? `[${b.type}]` : '')).join(' ') : c == null ? '' : JSON.stringify(c));

/** One line describing a tool call, for the "what is it doing" display. */
export function toolSummary(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash') return clip(i.command, 400);
  if (name === 'Skill') return `${i.skill || i.command || ''}${i.args ? ` ${i.args}` : ''}`.trim();
  if (name === 'Task' || name === 'Agent') return clip(i.description || i.prompt || '', 300);
  if (i.file_path) return String(i.file_path);
  if (i.pattern) return clip(`${i.pattern}${i.path ? ` in ${i.path}` : ''}`, 200);
  return clip(JSON.stringify(i), 200);
}

/**
 * Parse one stream-json object into zero or more log events:
 *   init | text | tool | tool_result | result | note
 * `sub` is true for events from a dispatched subagent (implementer, reviewer, patcher).
 */
export function parseStreamObject(o) {
  if (!o || typeof o !== 'object') return [];
  const sub = !!o.parent_tool_use_id;
  if (o.type === 'system' && o.subtype === 'init') {
    return [{ type: 'init', model: o.model || '', permissionMode: o.permissionMode || '', session: o.session_id || '', version: o.claude_code_version || '',
      plugin: [...(o.slash_commands || []), ...(o.skills || [])].some((s) => /^\/?delivery-loop:/.test(String(s))), mcp: (o.mcp_servers || []).length }];
  }
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    return o.message.content.flatMap((b) => {
      if (b.type === 'text' && b.text?.trim()) return [{ type: 'text', sub, text: clip(b.text.trim(), 4000) }];
      if (b.type === 'tool_use') return [{ type: 'tool', sub, id: b.id, name: b.name, summary: toolSummary(b.name, b.input) }];
      return [];
    });
  }
  if (o.type === 'user' && Array.isArray(o.message?.content)) {
    return o.message.content.filter((b) => b.type === 'tool_result').map((b) => ({ type: 'tool_result', sub, id: b.tool_use_id, isError: !!b.is_error, text: clip(flat(b.content), 600) }));
  }
  if (o.type === 'result') {
    return [{ type: 'result', isError: !!o.is_error, subtype: o.subtype || '', text: clip(o.result ?? '', 6000), turns: o.num_turns ?? 0, costUsd: Number(o.total_cost_usd) || 0, durationMs: o.duration_ms ?? 0,
      denials: (o.permission_denials || []).slice(0, 30).map((d) => ({ tool: d.tool_name || d.tool || '', summary: toolSummary(d.tool_name || d.tool || '', d.tool_input || d.input) })) }];
  }
  return [];
}

/** What a finished tool call did to the loop, read from the command that ran (used for the run counters). */
export function effectOf(name, summary, isError) {
  if (isError || name !== 'Bash') return null;
  const c = String(summary || '');
  if (/\bgh\s+pr\s+create\b/.test(c)) return 'prOpened';
  if (/\bgh\s+pr\s+merge\b/.test(c)) return 'merged';
  if (/\bgh\s+(?:issue|pr)\s+edit\b[^|;&]*--add-label[= ]+["']?[^"'\s]*needs-human/.test(c)) return 'escalation';
  if (/\bgh\s+pr\s+review\b/.test(c)) return 'review';
  return null;
}

/** Splits a byte stream into complete lines. */
export function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l) onLine(l); } },
    end() { if (buf.trim()) onLine(buf.trim()); buf = ''; },
  };
}
