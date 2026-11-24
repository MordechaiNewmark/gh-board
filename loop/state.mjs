// The live loop, as the delivery-loop plugin sees it: each task's state from its labels (the plugin's own
// taxonomy, see scripts/delivery-init.sh and the task-status skill), the PR that carries it, what it waits on,
// and the inbox of things only a human can move. Pure functions over data fetched elsewhere (loop/github.mjs).
import { lintIssue, parseDeps, parseEpic } from './lint.mjs';

/** Board columns, left to right, in the order work flows. `label` is the plugin label that puts a task there. */
export const LOOP_STATES = [
  { id: 'blocked', title: 'Blocked', label: 'status:blocked', hint: 'Waiting for Depends-on issues to close' },
  { id: 'ready', title: 'Ready', label: 'status:ready', hint: 'Claimable now, best first' },
  { id: 'claimed', title: 'Claimed', label: 'status:claimed', hint: 'An agent or a person is implementing it' },
  { id: 'in-review', title: 'In review', label: 'status:in-review', hint: 'PR open, waiting for the independent reviewer' },
  { id: 'changes-requested', title: 'Changes requested', label: 'status:changes-requested', hint: 'The patcher has up to 3 rounds' },
  { id: 'approved', title: 'Approved', label: 'status:approved', hint: 'Reviewed and green: waiting for your merge' },
  { id: 'needs-human', title: 'Needs human', label: 'needs-human', hint: 'Escalated: the loop will not touch these' },
  { id: 'done', title: 'Done', label: null, hint: 'Merged and closed' },
];
const PRECEDENCE = ['approved', 'changes-requested', 'in-review', 'claimed', 'ready', 'blocked'];
export const STALE_AGENT_H = 4; // task-queue.sh --fix reclaims an agent claim idle this long with no PR
export const STALE_HUMAN_H = 72; // ...and pings (never reclaims) a human claim idle this long
export const MAX_PATCH = 3;

const low = (s) => String(s || '').toLowerCase();
const hasLabel = (i, n) => i.labels.some((l) => low(l) === n);

/**
 * State of one task. Labels are the plugin's cache of the truth, so they win; when a task carries no status
 * label the state is derived the way task-queue.sh derives readiness (deps closed and nobody assigned).
 */
export function loopState(issue, { depsOpen = false } = {}) {
  if (issue.state === 'closed') return { state: 'done', derived: false };
  if (hasLabel(issue, 'needs-human')) return { state: 'needs-human', derived: false };
  for (const id of PRECEDENCE) if (hasLabel(issue, `status:${id}`)) return { state: id, derived: false };
  if (issue.assignees?.length) return { state: 'claimed', derived: true };
  return { state: depsOpen ? 'blocked' : 'ready', derived: true };
}

/** Issue a PR delivers: `Closes #N` in the body, else `(#N)` at the end of the title (the next-task convention). */
export function linkedIssue(pr) {
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(pr.body || '') || /\(#(\d+)\)\s*$/.exec(pr.title || '');
  return m ? Number(m[1]) : null;
}
const mentions = (pr, n) => new RegExp(`#${n}\\b`).test(`${pr.body || ''} ${pr.title || ''}`);

/** Highest "Patch iteration: n/3" posted on a PR, with each round's note. */
export function patchHistory(comments) {
  const rounds = [];
  for (const c of comments || []) {
    const m = /Patch iteration:\s*(\d+)\s*\/\s*(\d+)(\s*\(rebase\))?/i.exec(c.body || '');
    if (m) rounds.push({ n: Number(m[1]), of: Number(m[2]), rebase: !!m[3], reset: /reset/i.test(c.body), by: c.by, at: c.at, note: c.body.replace(m[0], '').trim().slice(0, 1200) });
  }
  const latest = rounds[rounds.length - 1];
  return { iteration: latest ? latest.n : 0, of: latest?.of || MAX_PATCH, rounds };
}

/** Roll GitHub check runs up into one state. */
export function ciState(runs) {
  if (!runs?.length) return 'none';
  if (runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(r.conclusion))) return 'failure';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'success';
}

const hours = (now, at) => (at ? Math.max(0, (now - Date.parse(at)) / 3600e3) : 0);

/**
 * @param issues  normalized issues (open + recently closed): { number,title,state,labels[],labelObjs[],assignees[],body,url,updated_at,comments }
 * @param prs     open PRs: { number,title,body,url,labels[],draft,head:{ref,sha},runs:[{name,status,conclusion,url}],comments:[{by,at,body}],updated_at }
 * @param conf    parsed delivery.conf values (MODULES)
 */
export function buildLoop({ issues, prs = [], modules = [], now = Date.now(), maxNumber } = {}) {
  const byNum = new Map(issues.map((i) => [i.number, i]));
  const known = new Map(issues.map((i) => [i.number, i.state]));
  const maxKnown = maxNumber ?? Math.max(0, ...issues.map((i) => i.number), ...prs.map((p) => p.number));
  const prInfo = prs.map((p) => ({ ...p, issue: linkedIssue(p), ci: ciState(p.runs), ...patchHistory(p.comments), needsHuman: p.labels.some((l) => low(l) === 'needs-human'), agent: p.labels.some((l) => low(l) === 'agent-authored') }));
  const prFor = (n) => prInfo.find((p) => p.issue === n) || prInfo.find((p) => mentions(p, n)) || null;

  const cards = []; const epics = []; const unqueued = [];
  for (const i of issues) {
    const isTask = hasLabel(i, 'task'); const isEpic = hasLabel(i, 'epic');
    if (isEpic) { epics.push(i); continue; }
    if (!isTask) { if (i.state === 'open') unqueued.push(i); continue; }
    const deps = parseDeps(i.body).map((d) => ({ number: d, state: known.get(d) || 'unknown', title: byNum.get(d)?.title || '' }));
    const blockedBy = deps.filter((d) => d.state === 'open');
    const { state, derived } = loopState(i, { depsOpen: blockedBy.length > 0 });
    const pr = i.state === 'open' ? prFor(i.number) : null;
    const agentClaim = hasLabel(i, 'claim:agent');
    const idle = hours(now, i.updated_at);
    const claim = i.state === 'open' && (i.assignees.length || agentClaim)
      ? { by: i.assignees[0] || '', kind: agentClaim ? 'agent' : 'human', idleHours: Math.round(idle * 10) / 10, stale: !pr && (agentClaim ? idle > STALE_AGENT_H : idle > STALE_HUMAN_H) }
      : null;
    const size = i.labels.find((l) => /^size:/i.test(l))?.slice(5) || '';
    const module = i.labels.find((l) => /^module:/i.test(l))?.slice(7) || '';
    cards.push({
      number: i.number, title: i.title, url: i.url, open: i.state === 'open', state, derived, size, module, epic: parseEpic(i.body),
      labels: i.labelObjs.filter((l) => !/^(task|size:|module:|status:|claim:|needs-human$|agent-authored$|human-authored$)/i.test(l.name)),
      assignees: i.assignees, claim, deps, blockedBy,
      pr: pr ? { number: pr.number, url: pr.url, title: pr.title, ci: pr.ci, iteration: pr.iteration, of: pr.of, draft: !!pr.draft, needsHuman: pr.needsHuman, agent: pr.agent } : null,
      lint: i.state === 'open' ? lintIssue(i, { modules, known, maxKnown }) : null,
      comments: i.comments || 0, updated_at: i.updated_at,
    });
  }
  // A PR escalated on its own (needs-human on the PR) pulls its task into the needs-human lane too.
  for (const c of cards) if (c.open && c.pr?.needsHuman && c.state !== 'needs-human') { c.state = 'needs-human'; c.derived = true; }

  const epicCards = epics.map((e) => {
    const listed = [...String(e.body || '').matchAll(/^[ \t]*[-*] \[[ xX]\][ \t]*#(\d+)/gm)].map((m) => Number(m[1]));
    const kids = [...new Set([...listed, ...cards.filter((c) => c.epic === e.number).map((c) => c.number)])];
    const closed = kids.filter((k) => known.get(k) === 'closed').length;
    return { number: e.number, title: e.title, url: e.url, open: e.state === 'open', total: kids.length, closed };
  }).filter((e) => e.open || e.total);

  const order = { done: (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) };
  const columns = LOOP_STATES.map((s) => ({ ...s, cards: cards.filter((c) => c.state === s.id).sort(order[s.id] || ((a, b) => a.number - b.number)).slice(0, s.id === 'done' ? 30 : 500).map((c) => c.number) }));

  return {
    columns, cards, epics: epicCards,
    unqueued: unqueued.map((i) => ({ number: i.number, title: i.title, url: i.url, lint: lintIssue(i, { modules, known, maxKnown }) })),
    inbox: buildInbox({ cards, prs: prInfo, now }),
    counts: Object.fromEntries(columns.map((c) => [c.id, c.cards.length])),
  };
}

/**
 * Everything that waits on the human, most urgent first:
 * escalations, approved PRs to merge, red CI on agent PRs, and claims that went quiet.
 */
export function buildInbox({ cards, prs, now = Date.now() }) {
  const items = [];
  const seenPr = new Set();
  const push = (kind, rank, o) => { items.push({ id: `${kind}-${o.issue ?? ''}-${o.pr ?? ''}`, kind, rank, ...o }); if (o.pr) seenPr.add(o.pr); };

  for (const c of cards) {
    if (!c.open) continue;
    if (c.state === 'needs-human') {
      push('needs-human', 0, { issue: c.number, pr: c.pr?.number ?? null, title: c.title, at: c.updated_at,
        detail: c.pr ? (c.pr.iteration >= c.pr.of ? `Escalated after ${c.pr.iteration}/${c.pr.of} patch rounds on PR #${c.pr.number}` : `Escalated with PR #${c.pr.number} open`) : 'Escalated before a PR was opened: read the last comment on the issue' });
    } else if (c.state === 'approved' && c.pr) {
      push('merge', 1, { issue: c.number, pr: c.pr.number, title: c.title, at: c.updated_at, ci: c.pr.ci,
        detail: c.pr.ci === 'failure' ? 'Approved, but a check is failing' : c.pr.ci === 'pending' ? 'Approved; checks are still running' : 'Approved by the reviewer and waiting for your merge' });
    }
  }
  for (const p of prs) {
    if (seenPr.has(p.number)) continue;
    if (p.needsHuman) push('needs-human', 0, { issue: p.issue, pr: p.number, title: p.title, at: p.updated_at, detail: `PR #${p.number} is labeled needs-human` });
    else if (p.agent && p.ci === 'failure') {
      const bad = (p.runs || []).filter((r) => r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped' && r.conclusion !== 'neutral').map((r) => r.name);
      push('ci-failed', 2, { issue: p.issue, pr: p.number, title: p.title, at: p.updated_at, ci: 'failure', detail: `Failing: ${bad.slice(0, 3).join(', ') || 'a check'}${p.iteration ? ` · patch ${p.iteration}/${p.of}` : ''}` });
    }
  }
  for (const c of cards) {
    if (c.open && c.claim?.stale && c.state !== 'needs-human') {
      push('stale-claim', 3, { issue: c.number, pr: null, title: c.title, at: c.updated_at,
        detail: c.claim.kind === 'agent' ? `Agent claim idle ${Math.round(c.claim.idleHours)}h with no PR. The next tick releases it.` : `@${c.claim.by} has held this for ${Math.round(c.claim.idleHours / 24)} days with no PR. Human claims are never auto-released.` });
    }
  }
  return items.sort((a, b) => a.rank - b.rank || Date.parse(a.at || 0) - Date.parse(b.at || 0));
}
