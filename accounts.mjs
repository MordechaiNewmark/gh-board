// GitHub accounts: several identities connected at once, and the per-repo resolver that picks whose token to use.
// Tokens live only in this process and in .gh-accounts.json (owner-only, git-ignored). Nothing here returns a
// token to a caller outside the server: the public shapes carry login, avatar, source and status only.
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_LABEL = { token: 'token saved in this app', device: 'GitHub sign-in', env: 'GITHUB_TOKEN in .env', cli: 'GitHub CLI' };
const RANK = { admin: 3, write: 2, read: 1 };
const roleOf = (p) => (p?.admin ? 'admin' : p?.push ? 'write' : 'read');
const low = (s) => String(s || '').toLowerCase();
const NOT_CONNECTED = 'Not connected to GitHub. Click Connect GitHub.';

/**
 * @param {object} o
 * @param {string} o.dir        folder that holds .gh-accounts.json (and a legacy .gh-token)
 * @param {string} [o.apiBase]  GitHub REST base URL (override only for GitHub Enterprise or tests)
 * @param {string} [o.envToken] GITHUB_TOKEN from the environment, used as an implicit account
 * @param {() => string} [o.cliToken] returns `gh auth token`, or throws / returns '' when unavailable
 * @param {boolean} [o.readOnly] block every non-GET request
 */
export function createAccounts({ dir, apiBase = 'https://api.github.com', envToken = '', cliToken = () => '', readOnly = false, fetchImpl = fetch } = {}) {
  const FILE = join(dir, '.gh-accounts.json');
  const LEGACY = join(dir, '.gh-token');
  apiBase = apiBase.replace(/\/+$/, '');

  let store = { version: 1, default: '', accounts: [], overrides: {}, ignored: [] };
  let implicit = []; // [{ login, avatar, token, source: 'env' | 'cli' }], never written to disk
  let notices = [];
  const health = new Map(); // login -> { status: 'attention', error }
  let index = new Map(); // repo key -> [{ login, role }]
  let indexAt = 0, indexing = null;
  const choice = new Map(); // repo key -> login (remembered pick)
  let ready = null, complete = false, lastTry = 0;

  /* ------------------------------ persistence ----------------------------- */
  function load() {
    if (!existsSync(FILE)) return;
    try {
      store = parseStore(JSON.parse(readFileSync(FILE, 'utf8')));
    } catch {
      // Keep the unreadable file for the owner to inspect; start empty rather than crash.
      try { renameSync(FILE, `${FILE}.bad`); } catch {}
      notices.push('.gh-accounts.json could not be read and was set aside as .gh-accounts.json.bad. Reconnect your accounts.');
    }
  }
  function parseStore(j) {
    return {
      version: 1,
      default: typeof j?.default === 'string' ? j.default : '',
      accounts: (Array.isArray(j?.accounts) ? j.accounts : []).filter((a) => a && typeof a.login === 'string' && typeof a.token === 'string' && a.token)
        .map((a) => ({ login: a.login, avatar: a.avatar || '', token: a.token, source: a.source === 'device' ? 'device' : 'token', addedAt: a.addedAt || new Date().toISOString() })),
      overrides: j?.overrides && typeof j.overrides === 'object' ? { ...j.overrides } : {},
      ignored: Array.isArray(j?.ignored) ? j.ignored.map(low) : [],
    };
  }
  /** The saved accounts, tokens included: server-side only (the hosted board encrypts this into its database). */
  const snapshot = () => structuredClone(store);
  /** Replace the saved accounts in memory (null = none). */
  async function restore(saved) {
    await init();
    store = parseStore(saved);
    health.clear(); index = new Map(); invalidate();
  }
  function save() {
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
    try { chmodSync(FILE, 0o600); } catch {}
  }

  /* -------------------------------- GitHub -------------------------------- */
  const tokens = () => [...store.accounts, ...implicit].map((a) => a.token).filter(Boolean);
  /** Remove every known token from a string before it can reach a response or a log. */
  function scrub(text) {
    let s = String(text ?? '');
    for (const t of tokens()) if (t.length >= 8) s = s.split(t).join('***');
    return s;
  }
  function raw(token, path, { method = 'GET', body } = {}) {
    return fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gh-board',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async function whoami(token) {
    let res;
    try { res = await raw(token, '/user'); } catch (e) { throw Object.assign(new Error(`Could not reach GitHub: ${scrub(e.message || e)}`), { network: true }); }
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
    const u = await res.json();
    if (!u?.login) throw new Error('GitHub did not return a login for that token.');
    return { login: u.login, avatar: u.avatar_url || '' };
  }
  function mark(login, error) {
    health.set(low(login), { status: 'attention', error });
    for (const [k, v] of choice) if (low(v) === low(login)) choice.delete(k); // re-pick repos this account was serving
  }
  /** One GitHub request as a given account. 401 flags that account only; the others keep working. */
  async function ghAs(acct, path, { method = 'GET', body } = {}) {
    if (readOnly && method !== 'GET') throw new Error('Read-only mode (READ_ONLY=1): writes to GitHub are disabled.');
    let res;
    try { res = await raw(acct.token, path, { method, body }); } catch (e) { throw new Error(`Could not reach GitHub as @${acct.login}: ${scrub(e.message || e)}`); }
    if (res.status === 401) {
      mark(acct.login, 'Token expired or revoked.');
      throw new Error(`GitHub rejected the token for @${acct.login} (expired or revoked). Reconnect that account from the account menu.`);
    }
    if (!res.ok) {
      const sso = res.headers.get('x-github-sso') || '';
      const text = scrub((await res.text()).slice(0, 300));
      if (res.status === 403 && (sso || /SAML|SSO/i.test(text))) {
        const url = /url=(https:\/\/\S+)/.exec(sso)?.[1];
        throw new Error(`@${acct.login}'s token is not authorized for this organization's single sign-on (SSO). ${url ? `Authorize it here: ${url}` : `Open github.com/settings/tokens as @${acct.login}, choose "Configure SSO" on the token and authorize the organization`}, or pick another account for this repository.`);
      }
      throw new Error(`GitHub ${res.status} on ${method} ${path} (as @${acct.login}): ${text}`);
    }
    if (health.has(low(acct.login))) health.delete(low(acct.login));
    return res.status === 204 ? null : res.json();
  }
  async function pagedAs(acct, path, maxPages = 3) {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const page = await ghAs(acct, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
      out.push(...page);
      if (page.length < 100) break;
    }
    return out;
  }

  /* --------------------------------- init --------------------------------- */
  async function resolveImplicit() {
    const found = []; let ok = true;
    const tryOne = async (source, token) => {
      if (!token) return;
      try { found.push({ ...(await whoami(token)), token, source }); }
      catch (e) {
        if (e.network) ok = false;
        else if (e.status === 401) notices.push(`${SOURCE_LABEL[source]}: GitHub rejected that token.`);
      }
    };
    await tryOne('env', String(envToken || '').trim());
    let cli = ''; try { cli = String(cliToken() || '').trim(); } catch {}
    if (cli && cli !== String(envToken || '').trim()) await tryOne('cli', cli);
    // An offline start keeps whatever was resolved before.
    if (ok || found.length) implicit = found.filter((a, i) => found.findIndex((b) => low(b.login) === low(a.login)) === i);
    return ok;
  }
  /** Move a pre-multi-account .gh-token into the accounts file. The legacy file is deleted only after a successful save. */
  async function migrateLegacy() {
    let t = ''; try { t = readFileSync(LEGACY, 'utf8').trim(); } catch { return true; }
    if (!t) { try { unlinkSync(LEGACY); } catch {} return true; }
    try {
      const me = await whoami(t);
      upsert({ ...me, token: t, source: 'token' });
      save();
      try { unlinkSync(LEGACY); } catch {}
      return true;
    } catch (e) {
      if (e.network) return false;
      notices.push('The token saved in .gh-token was rejected by GitHub and was not migrated. Reconnect that account.');
      return true;
    }
  }
  function init() {
    if (complete) return ready;
    if (ready && Date.now() - lastTry < 5000) return ready;
    lastTry = Date.now();
    const first = !ready;
    ready = (async () => {
      if (first) load();
      notices = notices.filter((n) => n.startsWith('.gh-accounts.json'));
      const a = await migrateLegacy();
      const b = await resolveImplicit();
      complete = a && b;
    })();
    return ready;
  }

  /* ------------------------------- accounts ------------------------------- */
  const hiddenImplicit = () => implicit.filter((i) => store.ignored.includes(low(i.login)) && !store.accounts.some((a) => low(a.login) === low(i.login)));
  function all() {
    const saved = store.accounts;
    const extra = implicit.filter((i) => !saved.some((a) => low(a.login) === low(i.login)) && !store.ignored.includes(low(i.login)));
    return [...saved, ...extra];
  }
  const find = (login) => all().find((a) => low(a.login) === low(login));
  const isOk = (a) => !health.has(low(a.login));
  function defaultAccount() {
    const list = all();
    return list.find((a) => low(a.login) === low(store.default)) || list[0] || null;
  }
  function pub(a) {
    const h = health.get(low(a.login));
    return {
      login: a.login, avatar: a.avatar || '', source: a.source, sourceLabel: SOURCE_LABEL[a.source] || a.source,
      addedAt: a.addedAt || null, status: h ? h.status : 'ok', error: h?.error || '', default: low(defaultAccount()?.login) === low(a.login),
    };
  }
  function upsert({ login, avatar, token, source }) {
    const now = new Date().toISOString();
    const have = store.accounts.find((a) => low(a.login) === low(login));
    if (have) Object.assign(have, { login, avatar, token, source, updatedAt: now });
    else store.accounts.push({ login, avatar, token, source, addedAt: now });
    store.ignored = store.ignored.filter((l) => l !== low(login));
    if (!store.default || !find(store.default)) store.default = defaultAccount()?.login || login;
    health.delete(low(login));
    invalidate();
    return { login, updated: !!have };
  }
  function invalidate() { indexAt = 0; choice.clear(); }

  async function list() {
    await init();
    return { accounts: all().map(pub), default: defaultAccount()?.login || '', hidden: hiddenImplicit().map((a) => ({ login: a.login, avatar: a.avatar, source: a.source, sourceLabel: SOURCE_LABEL[a.source] })), notices: [...notices] };
  }
  /** Add an account from a token, or refresh the token of one that is already connected (same login). */
  async function addToken(token, source = 'token') {
    await init();
    token = String(token || '').trim();
    if (!token) throw new Error('Paste a token first.');
    if (/\s/.test(token) || token.length > 512) throw new Error('That does not look like a GitHub token.');
    let me;
    try { me = await whoami(token); } catch (e) { throw new Error(e.network ? e.message : 'GitHub rejected that token.'); }
    const r = upsert({ ...me, token, source });
    save();
    return r;
  }
  /** Disconnect one account. Returns the repos only it could reach, so the caller can clear their cached checkouts. */
  async function remove(login) {
    await init();
    const target = login ? find(login) : defaultAccount();
    if (!target) throw new Error(login ? `@${login} is not connected.` : NOT_CONNECTED);
    const key = low(target.login);
    const orphaned = [...index.entries()].filter(([, c]) => c.length && c.every((x) => low(x.login) === key)).map(([k]) => k);
    store.accounts = store.accounts.filter((a) => low(a.login) !== key);
    // An env/CLI token for the same login must not silently bring the account back.
    if (implicit.some((i) => low(i.login) === key) && !store.ignored.includes(key)) store.ignored.push(key);
    for (const [k, v] of Object.entries(store.overrides)) if (low(v) === key) delete store.overrides[k];
    for (const [k, c] of index) { const rest = c.filter((x) => low(x.login) !== key); if (rest.length) index.set(k, rest); else index.delete(k); }
    for (const [k, v] of choice) if (low(v) === key) choice.delete(k);
    health.delete(key);
    if (low(store.default) === key) store.default = all()[0]?.login || '';
    save();
    return { removed: target.login, orphaned };
  }
  /** Bring back an env/CLI account that was disconnected earlier. */
  async function reconnect(login) {
    await init();
    if (!store.ignored.includes(low(login))) throw new Error(`@${login} is not a disconnected environment or CLI account.`);
    store.ignored = store.ignored.filter((l) => l !== low(login));
    if (!store.default) store.default = defaultAccount()?.login || '';
    invalidate(); save();
    return { login };
  }
  async function setDefault(login) {
    await init();
    const a = find(login);
    if (!a) throw new Error(`@${login} is not connected.`);
    store.default = a.login;
    invalidate(); save();
    return { default: a.login };
  }
  /** Re-validate every token (and re-read the env/CLI ones). Marks revoked accounts; never throws for one bad account. */
  async function check() {
    await init();
    notices = notices.filter((n) => !/rejected that token/.test(n));
    await resolveImplicit();
    await Promise.all(all().map(async (a) => {
      try { const me = await whoami(a.token); a.avatar = me.avatar || a.avatar; health.delete(low(a.login)); }
      catch (e) { if (e.status === 401) mark(a.login, 'Token expired or revoked.'); }
    }));
    return list();
  }

  /* ------------------------------ repo routing ---------------------------- */
  function pick(cands) {
    const def = low(defaultAccount()?.login);
    const order = all().map((a) => low(a.login));
    return cands.map((c) => ({ ...c, acct: find(c.login) })).filter((c) => c.acct).sort((a, b) =>
      Number(isOk(b.acct)) - Number(isOk(a.acct))
      || (RANK[b.role] || 0) - (RANK[a.role] || 0)
      || Number(low(b.login) === def) - Number(low(a.login) === def)
      || order.indexOf(low(a.login)) - order.indexOf(low(b.login)))[0] || null;
  }
  function chosen(key) {
    const cands = index.get(key) || [];
    const ov = store.overrides[key];
    const forced = ov && find(ov) ? { login: find(ov).login, role: cands.find((c) => low(c.login) === low(ov))?.role || 'read', acct: find(ov) } : null;
    return { cands, best: forced || pick(cands), overridden: !!forced };
  }
  /** Merged repo list across every connected account, each repo tagged with the account that will be used for it. */
  async function listRepos() {
    await init();
    const accts = all();
    if (!accts.length) throw new Error(NOT_CONNECTED);
    const run = (async () => {
      const results = await Promise.all(accts.map((a) => pagedAs(a, '/user/repos?sort=pushed&affiliation=owner,collaborator,organization_member', 5).then((rs) => ({ a, rs }), (error) => ({ a, error }))));
      if (results.every((r) => r.error)) throw results[0].error;
      const merged = new Map(); const next = new Map();
      for (const { a, rs } of results) for (const r of rs || []) {
        const key = low(r.full_name);
        const role = roleOf(r.permissions);
        if (!merged.has(key)) merged.set(key, { name: r.full_name, private: r.private, issues: r.has_issues, pushed: r.pushed_at || '' });
        next.set(key, [...(next.get(key) || []), { login: a.login, role }]);
      }
      // Keep what a failed account could reach last time, so one bad request does not hide its repos from the resolver.
      for (const { a, error } of results) if (error) for (const [k, c] of index) { const mine = c.find((x) => low(x.login) === low(a.login)); if (mine && !next.get(k)?.some((x) => low(x.login) === low(a.login))) next.set(k, [...(next.get(k) || []), mine]); }
      index = next; indexAt = Date.now(); choice.clear();
      return [...merged.entries()].sort((x, y) => (y[1].pushed > x[1].pushed ? 1 : y[1].pushed < x[1].pushed ? -1 : 0)).map(([key, r]) => {
        const { cands, best } = chosen(key);
        return { name: r.name, private: r.private, issues: r.issues, role: best?.role || 'read', account: best?.login || '', accounts: cands };
      });
    })();
    indexing = run.catch(() => {}).finally(() => { indexing = null; });
    return run;
  }
  async function ensureIndex() {
    if (indexing) return indexing;
    if (indexAt && Date.now() - indexAt < 5 * 60000) return;
    await listRepos().catch(() => {});
  }
  /** A repo that is in nobody's list (typed by hand, or public): ask each account what it can do there. */
  async function probe(repo, key) {
    const found = (await Promise.all(all().filter(isOk).map((a) => ghAs(a, `/repos/${repo}`).then((r) => ({ login: a.login, role: roleOf(r.permissions) }), () => null)))).filter(Boolean);
    if (found.length) index.set(key, found);
    return found;
  }
  /** The account whose token serves this repo: explicit override, else highest permission (ties: default account). */
  async function accountFor(repo) {
    await init();
    const list = all();
    if (!list.length) throw new Error(NOT_CONNECTED);
    const key = low(repo);
    const ov = store.overrides[key] && find(store.overrides[key]);
    if (ov) return ov;
    if (list.length === 1) return list[0];
    const remembered = choice.get(key) && find(choice.get(key));
    if (remembered && isOk(remembered)) return remembered;
    await ensureIndex();
    let best = pick(index.get(key) || []);
    if (!best) best = pick(await probe(repo, key));
    // Nobody can see it: use the default (or first healthy) account so the real GitHub error names an account.
    const acct = best?.acct || [defaultAccount(), ...list].find(isOk) || defaultAccount();
    if (best) choice.set(key, acct.login);
    return acct;
  }
  /** GitHub client bound to the account that owns `repo`. `token` is for server-side git only. */
  async function forRepo(repo) {
    const acct = await accountFor(repo);
    return { login: acct.login, token: acct.token, gh: (path, opts) => ghAs(acct, path, opts), paged: (path, max) => pagedAs(acct, path, max) };
  }
  async function repoAccount(repo) {
    const acct = await accountFor(repo);
    const key = low(repo);
    const { cands, overridden } = chosen(key);
    return { repo, login: acct.login, avatar: acct.avatar || '', role: cands.find((c) => low(c.login) === low(acct.login))?.role || '', overridden, candidates: cands.length ? cands : [{ login: acct.login, role: '' }] };
  }
  /** Remember which account to use for a repo (login null/'' clears the choice). */
  async function setRepoAccount(repo, login) {
    await init();
    const key = low(repo);
    if (!login) delete store.overrides[key];
    else {
      const a = find(login);
      if (!a) throw new Error(`@${login} is not connected.`);
      store.overrides[key] = a.login;
    }
    choice.delete(key); save();
    return repoAccount(repo);
  }

  return {
    init, snapshot, restore, list, addToken, remove, reconnect, setDefault, check, listRepos, accountFor, forRepo, repoAccount, setRepoAccount, scrub,
    /** Compatibility shape of the old single-account status: the default account. */
    async status() {
      const l = await list();
      const d = l.accounts.find((a) => a.default);
      return d ? { connected: true, login: d.login, avatar: d.avatar, source: d.sourceLabel, ...l } : { connected: false, error: l.notices[0] || NOT_CONNECTED, ...l };
    },
    FILE,
  };
}
