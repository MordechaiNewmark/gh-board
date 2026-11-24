// A tiny local stand-in for api.github.com and api.anthropic.com. Every token here is fake; nothing leaves this machine.
import http from 'node:http';

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

export async function startMock() {
  const who = new Map([[TOK.alice, 'alice'], [TOK.alice2, 'alice'], [TOK.bob, 'bob'], [TOK.carol, 'carol-work']]);
  const revoked = new Set();
  const log = []; // { login, token, method, path }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
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
      log.push({ login, token, method: req.method, path: url.pathname });
      if (!login || revoked.has(token)) return send(401, { message: 'Bad credentials' });
      if (url.pathname === '/user') return send(200, { login, avatar_url: `http://${req.headers.host}/avatar/${login}.svg` });
      if (url.pathname === '/user/repos') {
        return send(200, Object.entries(WORLD[login]).map(([full_name, role], i) => ({ full_name, private: full_name !== 'acme/api', has_issues: true, permissions: perms(role), pushed_at: `2026-01-0${i + 1}T00:00:00Z` })));
      }
      const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
      if (m) {
        const [, repo, rest = ''] = m;
        const role = WORLD[login][repo] || (PUBLIC.includes(repo) ? 'read' : null);
        if (!role) return send(404, { message: 'Not Found' });
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
    base, log, revoke: (t) => revoked.add(t), restore: (t) => revoked.delete(t),
    writes: () => log.filter((e) => e.method && e.method !== 'GET'),
    last: (path) => [...log].reverse().find((e) => e.path === path),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
