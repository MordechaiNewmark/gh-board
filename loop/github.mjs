// GitHub side of the loop views: fetch issues and PRs for the board/inbox, assemble the evidence-first review
// of one PR, and the three human actions (merge, request changes, close). Every call goes through the same
// per-repo account client as the rest of the app (accounts.forRepo), so READ_ONLY and token routing apply.
import { buildLoop, linkedIssue, loopState } from './state.mjs';
import { buildReview } from './evidence.mjs';
import { parseDeps } from './lint.mjs';

export const HUMAN_MARK = '<!-- gh-board:human-review -->'; // lets later phases find human "request changes" reasons

const normIssue = (i) => ({
  number: i.number, title: i.title, state: i.state, body: i.body || '', url: i.html_url, comments: i.comments || 0,
  labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)), labelObjs: (i.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: '888888' } : { name: l.name, color: l.color })),
  assignees: (i.assignees || []).map((a) => a.login), updated_at: i.updated_at, created_at: i.created_at,
});
const normComment = (c) => ({ by: c.user?.login || '', at: c.created_at, body: c.body || '' });
const normRun = (r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url || r.details_url || '' });
const normPr = (p) => ({
  number: p.number, title: p.title, body: p.body || '', url: p.html_url, draft: !!p.draft, state: p.state, merged: !!p.merged,
  mergeable: p.mergeable ?? null, mergeable_state: p.mergeable_state || '', head: { ref: p.head?.ref || '', sha: p.head?.sha || '' }, base: p.base?.ref || '',
  user: p.user?.login || '', labels: (p.labels || []).map((l) => l.name), additions: p.additions, deletions: p.deletions, changed_files: p.changed_files, updated_at: p.updated_at,
});

/**
 * @param forRepo   (repo) => { gh, paged, login }   (accounts.forRepo with the repo already validated)
 * @param getModules (repo) => Promise<string[]>     MODULES from the repo's delivery.conf
 */
export function createLoopApi({ forRepo, getModules = async () => [], cacheMs = 4000, maxPrs = 30 }) {
  const cache = new Map(); // repo -> { at, data }
  const drop = (repo) => cache.delete(repo.toLowerCase());

  async function fetchAll(repo) {
    const { gh, paged } = await forRepo(repo);
    const [open, closed, pulls, modules] = await Promise.all([
      paged(`/repos/${repo}/issues?state=open&sort=updated`, 4),
      gh(`/repos/${repo}/issues?state=closed&sort=updated&per_page=100`),
      gh(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${maxPrs}`),
      getModules(repo).catch(() => []),
    ]);
    const prs = await Promise.all(pulls.map(async (p) => {
      const [comments, checks] = await Promise.all([
        gh(`/repos/${repo}/issues/${p.number}/comments?per_page=100`).catch(() => []),
        p.head?.sha ? gh(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=50`).catch(() => ({ check_runs: [] })) : { check_runs: [] },
      ]);
      return { ...normPr(p), comments: comments.map(normComment), runs: (checks.check_runs || []).map(normRun) };
    }));
    const all = [...open, ...closed];
    const maxNumber = Math.max(0, ...all.map((i) => i.number));
    return { issues: all.filter((i) => !i.pull_request).map(normIssue), prs, modules, maxNumber };
  }

  /** Board + inbox model for a repo (briefly cached: the UI polls while a run is active). */
  async function snapshot(repo, { fresh = false } = {}) {
    const key = repo.toLowerCase();
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < cacheMs) return hit.data;
    const raw = await fetchAll(repo);
    const data = { repo, at: new Date().toISOString(), modules: raw.modules, ...buildLoop(raw) };
    cache.set(key, { at: Date.now(), data, raw });
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return data;
  }

  /** Lint drafts (from the chat preview) or existing issues against the repo's MODULES and known issue numbers. */
  async function known(repo) {
    await snapshot(repo);
    const raw = cache.get(repo.toLowerCase())?.raw;
    return { modules: raw?.modules || [], known: new Map((raw?.issues || []).map((i) => [i.number, i.state])), maxKnown: raw?.maxNumber };
  }

  /** Everything the evidence-first review screen shows for one PR. */
  async function review(repo, number) {
    const { gh, login } = await forRepo(repo);
    const p = normPr(await gh(`/repos/${repo}/pulls/${number}`));
    const n = linkedIssue(p);
    const [reviews, comments, checks, files, issue] = await Promise.all([
      gh(`/repos/${repo}/pulls/${number}/reviews?per_page=100`).catch(() => []),
      gh(`/repos/${repo}/issues/${number}/comments?per_page=100`).catch(() => []),
      p.head.sha ? gh(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=50`).catch(() => ({ check_runs: [] })) : { check_runs: [] },
      gh(`/repos/${repo}/pulls/${number}/files?per_page=100`).catch(() => []),
      n ? gh(`/repos/${repo}/issues/${n}`).then(normIssue).catch(() => null) : null,
    ]);
    const state = issue ? loopState(issue, { depsOpen: false }).state : '';
    return {
      repo, as: login,
      ...buildReview({
        issue, pr: p, loopState: p.labels.some((l) => l.toLowerCase() === 'needs-human') ? 'needs-human' : state,
        reviews: reviews.map((r) => ({ id: r.id, by: r.user?.login || '', state: r.state, body: r.body || '', at: r.submitted_at, commit: r.commit_id || '' })),
        comments: comments.map(normComment), runs: (checks.check_runs || []).map(normRun),
        files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      }),
      deps: issue ? parseDeps(issue.body) : [],
    };
  }

  const must = (confirm, what) => { if (confirm !== true) throw new Error(`Confirmation required: ${what} changes GitHub. Send confirm: true after showing the user what will happen.`); };
  const relabel = async (gh, repo, n, add, remove) => {
    for (const l of remove) await gh(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(l)}`, { method: 'DELETE' }).catch(() => {});
    if (add.length) await gh(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels: add } });
  };

  /**
   * Human merge: squash, as the account that owns the repo, only with an explicit confirmation and only the
   * exact commit the user was shown (GitHub rejects the merge if the head moved).
   */
  async function merge(repo, { number, sha, confirm }) {
    must(confirm, 'merging a pull request');
    if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) throw new Error('Merge needs the head commit SHA that was reviewed.');
    const { gh, login } = await forRepo(repo);
    const p = normPr(await gh(`/repos/${repo}/pulls/${number}`));
    if (p.state !== 'open') throw new Error(`PR #${number} is not open.`);
    if (p.draft) throw new Error(`PR #${number} is a draft.`);
    if (p.head.sha !== sha) throw new Error(`PR #${number} changed since you reviewed it (head is now ${p.head.sha.slice(0, 7)}). Reload the review first.`);
    const r = await gh(`/repos/${repo}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha } });
    drop(repo);
    return { merged: r?.merged !== false, number, sha: r?.sha || '', as: login, issue: linkedIssue(p) };
  }

  /**
   * Human "request changes": post the reasons on the PR and relabel the task so the loop's patcher picks it up.
   * resetBudget also clears needs-human and restarts the 3-round patch budget (the patcher reads the latest
   * "Patch iteration: n/3" comment).
   */
  async function requestChanges(repo, { number, body, confirm, resetBudget = false }) {
    must(confirm, 'requesting changes');
    const text = String(body || '').trim();
    if (text.length < 3) throw new Error('Say what has to change: the patcher works from this comment.');
    const { gh, login } = await forRepo(repo);
    const p = normPr(await gh(`/repos/${repo}/pulls/${number}`));
    if (p.state !== 'open') throw new Error(`PR #${number} is not open.`);
    const reviewBody = `${text}\n\n${HUMAN_MARK}`;
    // GitHub refuses REQUEST_CHANGES on your own PR (agents and human often share one account): fall back to a
    // comment-form review, exactly as the reviewer skill does. The status label carries the verdict.
    let form = 'review';
    try { await gh(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: { event: 'REQUEST_CHANGES', body: reviewBody } }); }
    catch (e) {
      if (/Read-only mode/.test(String(e.message))) throw e;
      form = 'comment';
      await gh(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: { event: 'COMMENT', body: reviewBody } });
    }
    const n = linkedIssue(p);
    if (resetBudget) {
      await gh(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: `Patch iteration: 0/3 (budget reset by @${login} from gh-board)` } });
      await relabel(gh, repo, number, [], ['needs-human']);
    }
    if (n) await relabel(gh, repo, n, ['status:changes-requested'], ['status:approved', 'status:in-review', ...(resetBudget ? ['needs-human'] : [])]);
    drop(repo);
    return { number, issue: n, form, as: login, reset: !!resetBudget };
  }

  /** Close a PR without merging. The task is parked as needs-human so no agent re-claims it before you decide. */
  async function close(repo, { number, confirm, reason = '' }) {
    must(confirm, 'closing a pull request');
    const { gh, login } = await forRepo(repo);
    const p = normPr(await gh(`/repos/${repo}/pulls/${number}`));
    if (p.state !== 'open') throw new Error(`PR #${number} is not open.`);
    await gh(`/repos/${repo}/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
    const n = linkedIssue(p);
    if (n) {
      await gh(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: { body: `PR #${number} was closed without merging by @${login} from gh-board.${reason ? `\n\n${String(reason).slice(0, 2000)}` : ''}\n\nThis task is parked as \`needs-human\`: remove that label (and set \`status:ready\`) to hand it back to the loop.` } });
      await relabel(gh, repo, n, ['needs-human'], ['status:approved', 'status:in-review', 'status:changes-requested']);
    }
    drop(repo);
    return { number, issue: n, closed: true, as: login };
  }

  return { snapshot, known, review, merge, requestChanges, close, drop };
}
