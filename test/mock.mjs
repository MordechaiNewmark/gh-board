// A tiny local stand-in for api.github.com and api.anthropic.com. Every token here is fake; nothing leaves this machine.
import http from 'node:http';
import { loopWorld } from './loop-fixture.mjs';

export const TOK = {
  alice: 'ghp_FAKEalice0000000000000000000000000001',
  alice2: 'ghp_FAKEalice0000000000000000000000000002', // a second token for the same login
  bob: 'ghp_FAKEbob000000000000000000000000000003',
  dead: 'ghp_FAKEdead00000000000000000000000000004',
  carol: 'ghp_FAKEcarol000000000000000000000000005', // used by the UI screenshots only
};
export const GOOD_KEY = 'sk-ant-api03-FAKEgood0000000000000000000000abcd';
export const BAD_KEY = 'sk-ant-api03-FAKEbad00000000000000000000000wxyz';

const perms = (role) => ({ admin: role === 'admin', push: role !== 'read', pull: true });
const WORLD = {
  alice: { 'alice/app': 'admin', 'shared/lib': 'read', 'acme/api': 'write', 'ssoorg/secret': 'write' },
  bob: { 'bob/tool': 'admin', 'shared/lib': 'admin', 'acme/api': 'write' },
  'carol-work': { 'acme/web': 'write', 'acme/infra': 'read' },
};
const PUBLIC = ['open/thing'];
// Repos with a delivery-loop fixture (test/loop-fixture.mjs). They are reachable but not in /user/repos unless
// startMock({ listLoopRepos: true }), so the repo lists the older tests assert on stay as they were.
const LOOP_ACCESS = {
  alice: { 'acme/timesheet': 'admin', 'acme/nogate': 'admin', 'acme/fresh': 'admin', 'team/loop': 'read' },
  bob: { 'team/loop': 'admin' },
};

export async function startMock({ listLoopRepos = false } = {}) {
  const worlds = { 'acme/timesheet': loopWorld(), 'team/loop': loopWorld(), 'acme/nogate': loopWorld({ gate: false }), 'acme/fresh': loopWorld({ conf: false }) };
  const who = new Map([[TOK.alice, 'alice'], [TOK.alice2, 'alice'], [TOK.bob, 'bob'], [TOK.carol, 'carol-work']]);
  const revoked = new Set();
  const log = []; // { login, token, method, path }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json = {}; try { json = body ? JSON.parse(body) : {}; } catch {}
      if (url.pathname.startsWith('/avatar/')) { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="hsl(' + (url.pathname.length * 47) % 360 + ' 55% 50%)"/><circle cx="4" cy="3" r="1.6" fill="#fff"/><rect x="1.5" y="5.2" width="5" height="3" rx="1.5" fill="#fff"/></svg>'); }
      // --- Anthropic
      if (url.pathname === '/v1/models') {
        log.push({ anthropic: true, key: req.headers['x-api-key'], path: url.pathname });
        if (req.headers['x-api-key'] === GOOD_KEY) return send(200, { data: [{ id: 'claude-opus-5-5' }], has_more: false });
        return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      // --- GitHub
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const login = who.get(token);
      log.push({ login, token, method: req.method, path: url.pathname, body: json });
      if (!login || revoked.has(token)) return send(401, { message: 'Bad credentials' });
      if (url.pathname === '/user') return send(200, { login, avatar_url: `http://${req.headers.host}/avatar/${login}.svg` });
      if (url.pathname === '/user/repos') {
        return send(200, Object.entries({ ...WORLD[login], ...(listLoopRepos ? LOOP_ACCESS[login] : {}) }).map(([full_name, role], i) => ({ full_name, private: full_name !== 'acme/api', has_issues: true, permissions: perms(role), pushed_at: `2026-01-0${i + 1}T00:00:00Z` })));
      }
      const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
      if (m) {
        const [, repo, rest = ''] = m;
        const role = WORLD[login][repo] || LOOP_ACCESS[login]?.[repo] || (PUBLIC.includes(repo) ? 'read' : null);
        if (!role) return send(404, { message: 'Not Found' });
        if (worlds[repo]) { const out = loopRoutes(worlds[repo], { repo, rest, method: req.method, json, login, role, url }); if (out) return send(out[0], out[1]); }
        if (repo === 'ssoorg/secret' && rest) return send(403, { message: 'Resource protected by organization SAML enforcement.' }, { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/ssoorg/sso?authorization_request=FAKE' });
        if (rest === '/leak') return send(500, { message: `server echoed ${token}` }); // a hostile/buggy upstream that echoes the credential
        if (req.method !== 'GET') return send(201, { number: 1, html_url: 'https://example/1', labels: [], state: 'open' });
        if (!rest) return send(200, { full_name: repo, permissions: perms(role), size: 1, default_branch: 'main' });
        if (/^\/issues\/\d+$/.test(rest)) return send(200, { number: Number(rest.split('/').pop()), id: 7, node_id: 'I_1', title: 't', state: 'open', labels: [], assignees: [], html_url: 'https://example/1', comments: 0, body: '' });
        return send(200, []);
      }
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, log, worlds, revoke: (t) => revoked.add(t), restore: (t) => revoked.delete(t),
    writes: () => log.filter((e) => e.method && e.method !== 'GET'),
    last: (path) => [...log].reverse().find((e) => e.path === path),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** GitHub endpoints the loop views and actions use, over a mutable loopWorld. Returns [status, body] or null (fall through). */
function loopRoutes(w, { repo, rest, method, json, login, role, url }) {
  const GET = method === 'GET';
  const issue = (n) => w.issues.find((i) => i.number === n);
  const pull = (n) => w.pulls.find((p) => p.number === n);
  const label = (name) => ({ name, color: 'ededed' });
  let m;
  if (!rest && GET) return [200, { full_name: repo, permissions: { admin: role === 'admin', push: role !== 'read', pull: true }, size: 1, default_branch: 'main' }];
  if ((m = /^\/contents\/?(.*)$/.exec(rest)) && GET) {
    const p = decodeURIComponent(m[1]);
    if (typeof w.contents[p] === 'string') return [200, { type: 'file', name: p.split('/').pop(), path: p, content: Buffer.from(w.contents[p]).toString('base64') }];
    const dir = w.contents[`${p.replace(/\/$/, '')}/`];
    if (dir) return [200, dir.map((name) => ({ type: 'file', name, path: `${p}/${name}` }))];
    return [404, { message: 'Not Found' }];
  }
  if (rest === '/issues' && GET) {
    const state = url.searchParams.get('state') || 'open';
    const page = Number(url.searchParams.get('page') || 1);
    const prs = w.pulls.filter((p) => p.state === 'open').map((p) => ({ number: p.number, title: p.title, state: 'open', labels: p.labels, assignees: [], html_url: p.html_url, body: p.body, pull_request: {}, comments: 0, updated_at: p.updated_at }));
    const list = [...w.issues, ...prs].filter((i) => state === 'all' || i.state === state);
    return [200, page > 1 ? [] : list];
  }
  if (rest === '/issues' && method === 'POST') {
    const n = w.next++;
    const made = { number: n, id: 1000 + n, node_id: `I_${n}`, title: json.title, body: json.body || '', state: 'open', labels: (json.labels || []).map(label), assignees: [], html_url: `https://github.com/${repo}/issues/${n}`, comments: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), milestone: null };
    w.issues.push(made);
    return [201, made];
  }
  if (rest === '/pulls' && GET) return [200, w.pulls.filter((p) => p.state === 'open')];
  if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
    const p = pull(Number(m[1])); if (!p) return [404, { message: 'Not Found' }];
    if (method === 'PATCH') Object.assign(p, json);
    return [200, p];
  }
  if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
    const p = pull(Number(m[1])); if (!p) return [404, { message: 'Not Found' }];
    if (json.sha && json.sha !== p.head.sha) return [409, { message: 'Head branch was modified. Review and try the merge again.' }];
    if (role === 'read') return [403, { message: 'Resource not accessible by personal access token' }];
    p.state = 'closed'; p.merged = true;
    const closes = /Closes #(\d+)/.exec(p.body); if (closes && issue(Number(closes[1]))) issue(Number(closes[1])).state = 'closed';
    return [200, { merged: true, sha: 'f'.repeat(40), message: 'Pull Request successfully merged' }];
  }
  if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) {
    const n = Number(m[1]); const p = pull(n); if (!p) return [404, { message: 'Not Found' }];
    if (GET) return [200, w.reviews[n] || []];
    // GitHub refuses approve / request-changes on your own pull request.
    if (json.event !== 'COMMENT' && p.user.login === login) return [422, { message: 'Unprocessable Entity', errors: ['Can not request changes on your own pull request'] }];
    const rv = { id: 100 + (w.reviews[n] || []).length, user: { login }, state: json.event === 'COMMENT' ? 'COMMENTED' : json.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', body: json.body || '', submitted_at: new Date().toISOString(), commit_id: p.head.sha };
    (w.reviews[n] ||= []).push(rv);
    return [200, rv];
  }
  if ((m = /^\/pulls\/(\d+)\/files$/.exec(rest)) && GET) return [200, w.files[Number(m[1])] || []];
  if ((m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest)) && GET) return [200, { total_count: (w.checks[m[1]] || []).length, check_runs: w.checks[m[1]] || [] }];
  if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
    const n = Number(m[1]);
    if (GET) return [200, w.comments[n] || []];
    const cm = { user: { login }, body: json.body || '', created_at: new Date().toISOString(), html_url: `https://github.com/${repo}/issues/${n}#c` };
    (w.comments[n] ||= []).push(cm);
    return [201, cm];
  }
  if ((m = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(rest))) {
    const target = issue(Number(m[1])) || pull(Number(m[1])); if (!target) return [404, { message: 'Not Found' }];
    if (method === 'POST') { for (const l of json.labels || []) if (!target.labels.some((x) => x.name === l)) target.labels.push(label(l)); return [200, target.labels]; }
    if (method === 'DELETE') { const name = decodeURIComponent(m[2] || ''); if (!target.labels.some((x) => x.name === name)) return [404, { message: 'Label does not exist' }]; target.labels = target.labels.filter((x) => x.name !== name); return [200, target.labels]; }
    return [200, target.labels];
  }
  if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
    const i = issue(Number(m[1])); if (!i) return [404, { message: 'Not Found' }];
    if (method === 'PATCH') { const { labels, ...restBody } = json; Object.assign(i, restBody); if (labels) i.labels = labels.map(label); }
    return [200, i];
  }
  if (rest === '/labels' && GET) return [200, [...new Map(w.issues.flatMap((i) => i.labels).map((l) => [l.name, l])).values()]];
  return null;
}
