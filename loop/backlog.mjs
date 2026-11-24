// Turning the planner's drafts into a backlog the delivery loop can run. The plugin's decompose skill creates
// epics first, then tasks in dependency order so every `Depends-on: #N` names a real issue, writes
// `Part of epic #E` on each task, lists the tasks in the epic body, and starts tasks as status:blocked (or
// status:ready when nothing blocks them). The chat cannot know issue numbers in advance, so drafts refer to
// each other by `key`; this module resolves the order and writes those lines. Pure functions.
import { lintIssue, STATUS_LABELS } from './lint.mjs';

const low = (s) => String(s || '').toLowerCase();
const hasLabel = (d, n) => (d.labels || []).some((l) => low(l) === n);
export const isEpicDraft = (d) => hasLabel(d, 'epic') || (!hasLabel(d, 'task') && (d.children || []).length > 0);
export const isTaskDraft = (d) => hasLabel(d, 'task');

/**
 * Flatten drafts ({ title, body, labels, key?, depends_on?, children? }) and work out a creation order in
 * which parents come before children and dependencies before dependents.
 * depends_on entries are either another draft's key or an existing issue ("#12" or 12).
 * Throws on a duplicate key, an unknown key, or a cycle, before anything is created.
 */
export function planBacklog(items) {
  const nodes = [];
  const walk = (list, parent) => { for (const { children, ...d } of list || []) { const idx = nodes.length; nodes.push({ ...d, idx, parent, kids: [] }); if (parent !== null) nodes[parent].kids.push(idx); walk(children, idx); } };
  walk(items, null);
  const byKey = new Map();
  for (const n of nodes) {
    if (n.key === undefined || n.key === null || n.key === '') continue;
    const k = low(n.key);
    if (byKey.has(k)) throw new Error(`Two drafts use the key "${n.key}". Keys must be unique.`);
    byKey.set(k, n.idx);
  }
  for (const n of nodes) {
    n.depIdx = []; n.depNums = [];
    for (const raw of n.depends_on || []) {
      const s = String(raw).trim();
      const num = /^#?(\d+)$/.exec(s);
      if (num) { n.depNums.push(Number(num[1])); continue; }
      const idx = byKey.get(low(s));
      if (idx === undefined) throw new Error(`"${n.title}" depends on "${s}", which is neither a key in this batch nor an issue number like #12.`);
      if (idx === n.idx) throw new Error(`"${n.title}" depends on itself.`);
      if (!n.depIdx.includes(idx)) n.depIdx.push(idx);
    }
  }
  const order = []; const mark = new Array(nodes.length).fill(0);
  const visit = (i, trail) => {
    if (mark[i] === 2) return;
    if (mark[i] === 1) throw new Error(`Dependency cycle: ${[...trail, nodes[i].title].join(' -> ')}`);
    mark[i] = 1;
    const n = nodes[i];
    if (n.parent !== null) visit(n.parent, [...trail, n.title]);
    for (const d of n.depIdx) visit(d, [...trail, n.title]);
    mark[i] = 2; order.push(i);
  };
  nodes.forEach((_, i) => visit(i, []));
  return { nodes, order };
}

const stripLines = (body, re) => String(body || '').split(/\r?\n/).filter((l) => !re.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

/** Final body of a draft: its own text plus the machine-read `Depends-on:` and `Part of epic #E` lines. */
export function finalBody(node, numberOf, epicNumber) {
  const deps = [...new Set([...node.depNums, ...node.depIdx.map((i) => numberOf(i)).filter(Boolean)])].sort((a, b) => a - b);
  const explicit = node.depends_on !== undefined;
  let body = explicit ? stripLines(node.body, /^\s*Depends-on:/) : String(node.body || '').trimEnd();
  const tail = [];
  if (explicit && deps.length) tail.push(`Depends-on: ${deps.map((d) => `#${d}`).join(' ')}`);
  if (epicNumber && !new RegExp(`[Ee]pic #${epicNumber}\\b`).test(body)) { body = stripLines(body, /^\s*Part of epic #?\S*\s*$/i); tail.push(`Part of epic #${epicNumber}`); }
  return tail.length ? `${body}\n\n${tail.join('\n')}` : body;
}

/** Final labels: a task with no status label starts blocked when it has dependencies, ready when it has none. */
export function finalLabels(node, hasDeps) {
  const labels = [...new Set(node.labels || [])];
  if (isTaskDraft(node) && !labels.some((l) => STATUS_LABELS.includes(low(l)))) labels.push(hasDeps ? 'status:blocked' : 'status:ready');
  return labels;
}

/** Epic body with its children listed the way task-queue.sh reads them ("- [ ] #N"). */
export function epicBodyWithTasks(body, children) {
  const have = new Set([...String(body || '').matchAll(/^[ \t]*[-*] \[[ xX]\][ \t]*#(\d+)/gm)].map((m) => Number(m[1])));
  const add = children.filter((c) => !have.has(c.number));
  if (!add.length) return String(body || '');
  const lines = add.map((c) => `- [ ] #${c.number} ${c.title}`).join('\n');
  return /^#{1,6}[ \t]*Tasks[ \t]*$/m.test(body || '') ? String(body).replace(/^(#{1,6}[ \t]*Tasks[ \t]*)$/m, `$1\n${lines}`) : `${String(body || '').trimEnd()}\n\n## Tasks\n${lines}`;
}

/** Readiness of drafts as they WILL be created (status label and dependency lines applied), for the preview card. */
export function lintDrafts(items, ctx = {}) {
  let plan;
  try { plan = planBacklog(items); } catch (e) { return { error: String(e.message || e), drafts: [] }; }
  const fake = (i) => 1 + i; // placeholder numbers: only the shape of the body matters here
  return {
    error: '',
    drafts: plan.nodes.map((n) => {
      const parentEpic = n.parent !== null && isEpicDraft(plan.nodes[n.parent]);
      const deps = n.depNums.length + n.depIdx.length;
      const body = finalBody({ ...n, depIdx: [] }, fake, parentEpic ? 999999 : null) + (n.depIdx.length ? `\nDepends-on: ${n.depIdx.map(() => '#0').join(' ')}` : '');
      const r = lintIssue({ title: n.title, body, labels: finalLabels(n, deps > 0) }, { ...ctx, maxKnown: ctx.maxKnown ?? Infinity });
      return { idx: n.idx, parent: n.parent, title: n.title, kind: r.kind, ready: r.ready, problems: r.problems.filter((p) => !(p.code === 'no-epic' && parentEpic) && p.code !== 'epic-no-children') };
    }),
  };
}
