// Evidence-first review: turn what the loop's reviewer posted on a PR into something a human can judge
// without reading the diff. The reviewer skill posts "one line per criterion (pass/fail, the command, its
// result) plus actionable findings"; this reads that back against the task's acceptance criteria, and
// collects any screenshots, video or artifacts attached to the PR. Everything here is untrusted text from
// GitHub: it is only parsed and displayed, never acted on.
import { parseCriteria, section } from './lint.mjs';
import { patchHistory, ciState, MAX_PATCH } from './state.mjs';

const FIRST_STATUS = /(✅|✔️?|☑️?|\[x\]|\bpass(?:ed|es|ing)?\b|\bok\b|\bgreen\b|\bsuccess\b)|(❌|✗|✘|⛔|🔴|\[ \]|\bfail(?:ed|s|ure|ing)?\b|\bunmet\b|\bnot met\b|\bred\b|\bmissing\b)/i;
/** pass | fail | carried | null for one line of a review body. The first status word on the line decides. */
export function lineStatus(line) {
  const s = String(line || '');
  const m = FIRST_STATUS.exec(s);
  if (!m) return null;
  if (m[2]) return 'fail';
  return /carried forward/i.test(s) ? 'carried' : 'pass';
}

const codeSpans = (s) => [...String(s).matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter((c) => c.length > 2);
const words = (s) => new Set(String(s).toLowerCase().replace(/`/g, ' ').split(/[^a-z0-9_./-]+/).filter((w) => w.length > 2 && !/^(pass(ed|es)?|fail(ed|s)?|the|and|with|exit|exits|code)$/.test(w)));
const overlap = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.min(A.size, B.size); };
const itemText = (l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim();

/**
 * Match a review body to the task's acceptance criteria.
 * @returns { results: [{ criterion, status: 'pass'|'fail'|'carried'|'unknown', evidence }], extra: [{status, text}], findings: string[] }
 */
export function parseReview(body, criteria = []) {
  const lines = String(body || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const judged = lines.map((l) => ({ raw: l, text: itemText(l), status: lineStatus(l), used: false, item: /^\s*(?:[-*+]|\d+[.)]|\|)\s*/.test(l) })).filter((l) => l.status && !/^\s*#{1,6}\s/.test(l.raw));
  const results = criteria.map((c) => ({ criterion: c.text, status: 'unknown', evidence: '' }));
  const take = (r, j) => { r.status = j.status; r.evidence = j.text; j.used = true; };

  // 1) the reviewer quoted the criterion's command; 2) the wording overlaps; 3) what is left over, when the counts agree, in order.
  results.forEach((r) => {
    const cmds = codeSpans(r.criterion);
    const j = cmds.length ? judged.find((x) => !x.used && cmds.some((c) => x.raw.replace(/\s+/g, ' ').includes(c))) : null;
    if (j) take(r, j);
  });
  results.forEach((r) => {
    if (r.status !== 'unknown') return;
    const best = judged.filter((x) => !x.used).map((x) => ({ x, s: overlap(r.criterion, x.text) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.6) take(r, best.x);
  });
  const left = judged.filter((x) => !x.used && x.item);
  const open = results.filter((r) => r.status === 'unknown');
  if (open.length && open.length === left.length) open.forEach((r, i) => take(r, left[i]));

  const extra = judged.filter((x) => !x.used).map((x) => ({ status: x.status, text: x.text }));
  const sec = section(body, /finding|required change|must fix|action(?:able)?|issue/i);
  const findings = (sec ?? '').split('\n').map((l) => l.trim()).filter((l) => /^(?:[-*+]|\d+[.)])\s+/.test(l)).map(itemText).filter(Boolean);
  if (!findings.length) for (const x of extra) if (x.status === 'fail') findings.push(x.text);
  return { results, extra, findings: findings.slice(0, 30) };
}

const SAFE_URL = /^https:\/\/[^\s<>"')\]]+$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^\s]*)?$/i;
const VID_EXT = /\.(mp4|webm|mov|m4v)(\?[^\s]*)?$/i;
const ARTIFACT = /\/(actions\/runs\/\d+\/artifacts\/\d+|suites\/\d+\/artifacts\/\d+)|\.(zip|html|json|log|txt|trace)(\?[^\s]*)?$/i;

/** Screenshots, videos and artifact links in a markdown/HTML blob. Only https URLs are returned. */
export function extractMedia(text, source = '') {
  const out = []; const seen = new Set();
  const add = (type, url, alt = '') => { url = String(url || '').trim(); if (!SAFE_URL.test(url) || seen.has(url)) return; seen.add(url); out.push({ type, url, alt: alt.trim().slice(0, 120), source }); };
  const s = String(text || '');
  for (const m of s.matchAll(/!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g)) add(VID_EXT.test(m[2]) ? 'video' : 'image', m[2], m[1]);
  for (const m of s.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) add('image', m[1], /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] || '');
  for (const m of s.matchAll(/<(?:video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) add('video', m[1]);
  for (const m of s.matchAll(/(?<![("'=])\bhttps:\/\/[^\s<>"')\]]+/g)) {
    const u = m[0].replace(/[.,;:]+$/, '');
    if (IMG_EXT.test(u)) add('image', u); else if (VID_EXT.test(u)) add('video', u);
    else if (/github\.com\/user-attachments\/assets\//.test(u)) add('video', u); // a bare attachment URL on its own line is how GitHub embeds video
    else if (ARTIFACT.test(u)) add('artifact', u);
  }
  for (const m of s.matchAll(/\[([^\]]+)\]\(\s*(https:\/\/[^)\s]+)\s*\)/g)) if (ARTIFACT.test(m[2]) && !IMG_EXT.test(m[2])) add('artifact', m[2], m[1]);
  return out;
}

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

/**
 * The model behind the review screen, evidence first.
 * @param issue    the linked task ({ number,title,body,labels[],state,url }) or null
 * @param pr       { number,title,body,url,draft,state,merged,mergeable,mergeable_state,head:{ref,sha},base,user,labels[],additions,deletions,changed_files }
 * @param reviews  [{ id, by, state, body, at, commit }] oldest first
 * @param comments [{ by, at, body }] oldest first (issue comments on the PR)
 * @param runs     check runs of the head commit
 * @param files    [{ filename, status, additions, deletions }]
 */
export function buildReview({ issue, pr, reviews = [], comments = [], runs = [], files = [], loopState = '' }) {
  const criteria = (issue && parseCriteria(issue.body)) || [];
  const withBody = reviews.filter((r) => (r.body || '').trim());
  const latest = withBody[withBody.length - 1] || null;
  const parsed = parseReview(latest?.body || '', criteria);
  const claims = parseReview(section(pr.body, /acceptance[ -]criteria|evidence/i) ?? pr.body, criteria);
  const history = patchHistory(comments);
  const ci = ciState(runs);
  const gateLine = (latest?.body || '').split(/\r?\n/).find((l) => /\bgate\b|GATE_CMD|check\.sh/i.test(l) && lineStatus(l));

  const media = [
    ...extractMedia(pr.body, 'PR description'),
    ...withBody.flatMap((r) => extractMedia(r.body, `review by @${r.by}`)),
    ...comments.flatMap((c) => extractMedia(c.body, `comment by @${c.by}`)),
  ].filter((m, i, a) => a.findIndex((x) => x.url === m.url) === i).slice(0, 40);

  const fails = parsed.results.filter((r) => r.status === 'fail').length;
  const unknown = parsed.results.filter((r) => r.status === 'unknown').length;
  const verdict = loopState === 'approved' || latest?.state === 'APPROVED' ? 'approved'
    : loopState === 'changes-requested' || latest?.state === 'CHANGES_REQUESTED' ? 'changes-requested'
      : loopState === 'needs-human' ? 'needs-human' : latest ? 'reviewed' : 'unreviewed';

  // What must be true before the merge button is offered without a warning.
  const blockers = [];
  if (pr.state !== 'open') blockers.push(pr.merged ? 'Already merged.' : 'The pull request is closed.');
  if (pr.draft) blockers.push('It is still a draft.');
  if (pr.mergeable === false) blockers.push('It conflicts with the base branch (the loop rebases approved PRs on the next tick).');
  if (ci === 'failure') blockers.push('A check is failing.');
  const cautions = [];
  if (verdict !== 'approved') cautions.push(verdict === 'unreviewed' ? 'No reviewer verdict has been posted yet.' : `The loop state is "${verdict}", not approved.`);
  if (ci === 'pending') cautions.push('Checks are still running.');
  if (ci === 'none') cautions.push('No CI checks reported on this commit: the reviewer\'s run of the gate is the only evidence.');
  if (fails) cautions.push(`${fails} acceptance criteri${fails === 1 ? 'on is' : 'a are'} marked failing in the latest review.`);
  if (criteria.length && unknown === criteria.length && latest) cautions.push('The review could not be matched to the acceptance criteria: read it below.');
  if (!criteria.length) cautions.push('The linked task has no acceptance-criteria checklist.');

  return {
    pr: { number: pr.number, title: pr.title, url: pr.url, state: pr.state, merged: !!pr.merged, draft: !!pr.draft, mergeable: pr.mergeable ?? null, mergeable_state: pr.mergeable_state || '', head: pr.head, base: pr.base, by: pr.user, labels: pr.labels, additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, changed_files: pr.changed_files ?? files.length, body: clip(pr.body, 6000) },
    issue: issue ? { number: issue.number, title: issue.title, url: issue.url, state: loopState, open: issue.state === 'open' } : null,
    verdict: { state: verdict, by: latest?.by || '', at: latest?.at || '', form: latest ? (latest.state === 'COMMENTED' ? 'comment' : 'review') : '', commit: latest?.commit || '', stale: !!(latest?.commit && pr.head?.sha && latest.commit !== pr.head.sha) },
    criteria: parsed.results.map((r, i) => ({ ...r, claim: claims.results[i]?.status || 'unknown' })),
    extra: parsed.extra.slice(0, 20),
    gate: { review: gateLine ? { status: lineStatus(gateLine), text: clip(itemText(gateLine), 400) } : null, ci, runs: runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.url })) },
    findings: parsed.findings,
    reviews: withBody.map((r) => ({ id: r.id, by: r.by, state: r.state, at: r.at, body: clip(r.body, 8000) })).reverse(),
    patches: { iteration: history.iteration, of: history.of || MAX_PATCH, rounds: history.rounds },
    media, files: files.slice(0, 300), diffUrl: `${pr.url}/files`,
    merge: { ok: blockers.length === 0, blockers, cautions, sha: pr.head?.sha || '', method: 'squash' },
  };
}
