// "Ready for the loop" lint. An issue is the build prompt an agent runs from, so it has to carry what the
// delivery-loop plugin needs: the `task` label, executable acceptance criteria, one size, one module, valid
// Depends-on edges and a status label the claim script accepts. This flags gaps; it never blocks creation.
// Parsing mirrors the plugin's own (scripts/task-queue.sh): `Depends-on:` lines and `epic #N` references.
import { BUILTIN_MODULES } from './conf.mjs';

export const STATUS_LABELS = ['status:blocked', 'status:ready', 'status:claimed', 'status:in-review', 'status:changes-requested', 'status:approved'];

/** Issue numbers on every `Depends-on:` line (same reading as task-queue.sh). */
export function parseDeps(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(/Depends-on:([^\n]*)/g)) for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  return [...out].sort((a, b) => a - b);
}
/** The epic a task belongs to: the first `epic #N` in the body (covers "Part of epic #N"). */
export const parseEpic = (body) => { const m = /[Ee]pic #(\d+)/.exec(String(body || '')); return m ? Number(m[1]) : null; };

/** Text of the section under a heading matching `re`, up to the next heading. */
export function section(body, re) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{0,3}(#{1,6}\s+|\*\*)/.test(l) && re.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s{0,3}#{1,6}\s+\S/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

const COMMAND_RE = /`[^`]+`/;
/** The acceptance-criteria checklist: [{ text, checked, command }]. `command` = it names something runnable or checkable. */
export function parseCriteria(body) {
  const sec = section(body, /acceptance[ -]criteria/i);
  if (sec === null) return null;
  const out = [];
  for (const l of sec.split('\n')) {
    const m = /^\s*[-*+]\s+(?:\[([ xX])\]\s*)?(.+)$/.exec(l);
    if (m) out.push({ text: m[2].trim(), checked: /x/i.test(m[1] || ''), command: COMMAND_RE.test(m[2]) });
  }
  return out;
}

const names = (issue) => (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);

/**
 * @param issue  { number?, title, body, labels: string[] | {name}[] }
 * @param ctx    { modules?: string[] (MODULES from delivery.conf), known?: Map<number,'open'|'closed'> | null,
 *                 maxKnown?: number (highest issue/PR number in the repo; a dependency above it cannot exist) }
 * @returns { kind: 'task'|'epic'|'other', ready: boolean|null, problems: [{ code, level: 'error'|'warn', message }] }
 */
export function lintIssue(issue, { modules = [], known = null, maxKnown } = {}) {
  if (maxKnown === undefined) maxKnown = known?.size ? Math.max(...known.keys()) : Infinity;
  const labels = names(issue);
  const has = (n) => labels.some((l) => l.toLowerCase() === n);
  const problems = [];
  const err = (code, message) => problems.push({ code, level: 'error', message });
  const warn = (code, message) => problems.push({ code, level: 'warn', message });
  const body = String(issue.body || '');

  if (has('epic')) {
    const kids = [...body.matchAll(/^[ \t]*[-*] \[[ xX]\][ \t]*#(\d+)/gm)].length;
    if (!kids) warn('epic-no-children', 'The epic body has no "- [ ] #N" task list yet, so it cannot auto-close.');
    return { kind: 'epic', ready: null, problems };
  }
  if (!has('task')) return { kind: 'other', ready: false, problems: [{ code: 'not-task', level: 'warn', message: 'Not labeled `task`: the loop ignores this issue.' }] };

  const criteria = parseCriteria(body);
  if (!criteria || !criteria.length) err('no-criteria', 'No "Acceptance criteria" checklist. Add one criterion per line as "- [ ] `command` passes".');
  else {
    const soft = criteria.filter((c) => !c.command).length;
    if (soft) warn('criteria-not-executable', `${soft} of ${criteria.length} acceptance criteria name no command or file to check (wrap the command in backticks).`);
  }

  const sizes = labels.filter((l) => /^size:/i.test(l));
  if (!sizes.length) err('no-size', 'No size label. Add size:S or size:M.');
  else if (sizes.length > 1) err('multi-size', `More than one size label (${sizes.join(', ')}).`);
  else if (/^size:l$/i.test(sizes[0])) err('size-l', 'size:L is never claimable. Split it into size:S / size:M tasks.');
  else if (!/^size:[sm]$/i.test(sizes[0])) err('bad-size', `Unknown size label ${sizes[0]}. Use size:S or size:M.`);

  const mods = labels.filter((l) => /^module:/i.test(l)).map((l) => l.slice(7));
  const allowed = [...modules, ...BUILTIN_MODULES];
  if (mods.length > 1) err('multi-module', `More than one module label (${mods.join(', ')}). A task has exactly one.`);
  else if (!mods.length) (modules.length ? err : warn)('no-module', modules.length ? `No module label. Use one of: ${allowed.map((m) => `module:${m}`).join(', ')}.` : 'No module label. Add one so parallel runs can tell tasks apart.');
  else if (modules.length && !allowed.includes(mods[0])) err('unknown-module', `module:${mods[0]} is not in MODULES (${allowed.join(', ')}).`);

  const deps = parseDeps(body);
  if (issue.number && deps.includes(issue.number)) err('dep-self', 'Depends-on lists the issue itself.');
  if (known) for (const d of deps) if (d !== issue.number && !known.has(d) && d > maxKnown) err('dep-missing', `Depends-on references #${d}, which does not exist.`);
  if (/depends[- ]on/i.test(body) && !/Depends-on:/.test(body)) warn('dep-format', 'Dependencies must be on a line that starts exactly with "Depends-on:" followed by #numbers.');

  if (!labels.some((l) => STATUS_LABELS.includes(l.toLowerCase())) && !has('needs-human')) err('no-status', 'No status label. Add status:blocked (or status:ready when it has no open dependencies); the claim script only takes status:ready.');
  if (section(body, /context/i) === null) warn('no-context', 'No Context section pointing at the spec or code this task derives from.');
  if (parseEpic(body) === null) warn('no-epic', 'No "Part of epic #N" line, so no epic will track or auto-close with it.');

  return { kind: 'task', ready: !problems.some((p) => p.level === 'error'), problems };
}
