// Multi-account logic against a local mock of the GitHub API. All tokens are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccounts } from '../accounts.mjs';
import { startMock, TOK } from './mock.mjs';

const mock = await startMock();
test.after(() => mock.close());
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ghb-')); dirs.push(d); return d; };
const make = (dir, o = {}) => createAccounts({ dir, apiBase: mock.base, ...o });
const noTokens = (v, label) => { const s = typeof v === 'string' ? v : JSON.stringify(v); for (const [k, t] of Object.entries(TOK)) assert.ok(!s.includes(t), `${label} leaks the ${k} token`); };

test('migrates a legacy .gh-token with no user action', async () => {
  const dir = tmp();
  writeFileSync(join(dir, '.gh-token'), `${TOK.alice}\n`);
  const acc = make(dir);
  const s = await acc.status();
  assert.equal(s.connected, true);
  assert.equal(s.login, 'alice');
  assert.equal(s.source, 'token saved in this app');
  assert.equal(existsSync(join(dir, '.gh-token')), false, 'legacy file removed after a successful save');
  const saved = JSON.parse(readFileSync(join(dir, '.gh-accounts.json'), 'utf8'));
  assert.equal(saved.accounts[0].login, 'alice');
  assert.equal(saved.accounts[0].token, TOK.alice);
  assert.equal(saved.default, 'alice');
  // A second start reads the accounts file and still works.
  assert.equal((await make(dir).status()).login, 'alice');
  noTokens(s, 'status');
});

test('a rejected legacy token is left in place and reported, not migrated', async () => {
  const dir = tmp();
  writeFileSync(join(dir, '.gh-token'), TOK.dead);
  const s = await make(dir).status();
  assert.equal(s.connected, false);
  assert.match(s.notices.join(' '), /\.gh-token was rejected/);
  assert.equal(existsSync(join(dir, '.gh-token')), true);
  noTokens(s, 'status');
});

test('env and CLI tokens are implicit accounts, deduped by login; a saved account wins', async () => {
  const dir = tmp();
  const acc = make(dir, { envToken: TOK.alice, cliToken: () => TOK.alice2 });
  let l = await acc.list();
  assert.deepEqual(l.accounts.map((a) => [a.login, a.source]), [['alice', 'env']]);
  assert.equal(existsSync(join(dir, '.gh-accounts.json')), false, 'implicit tokens are never written to disk');

  const both = make(tmp(), { envToken: TOK.alice, cliToken: () => TOK.bob });
  assert.deepEqual((await both.list()).accounts.map((a) => [a.login, a.source]), [['alice', 'env'], ['bob', 'cli']]);

  await acc.addToken(TOK.alice2);
  l = await acc.list();
  assert.deepEqual(l.accounts.map((a) => [a.login, a.source]), [['alice', 'token']]);
  noTokens(l, 'list');
});

test('adding the same login twice updates its token instead of duplicating it', async () => {
  const dir = tmp();
  const acc = make(dir);
  assert.deepEqual(await acc.addToken(TOK.alice), { login: 'alice', updated: false });
  assert.deepEqual(await acc.addToken(TOK.alice2), { login: 'alice', updated: true });
  assert.equal((await acc.list()).accounts.length, 1);
  await (await acc.forRepo('alice/app')).gh('/repos/alice/app/issues');
  assert.equal(mock.last('/repos/alice/app/issues').token, TOK.alice2);
  assert.equal(JSON.parse(readFileSync(join(dir, '.gh-accounts.json'), 'utf8')).accounts.length, 1);
});

test('rejects a bad token without storing it', async () => {
  const dir = tmp();
  const acc = make(dir);
  await assert.rejects(acc.addToken(TOK.dead), /GitHub rejected that token/);
  await assert.rejects(acc.addToken(''), /Paste a token/);
  assert.equal((await acc.list()).accounts.length, 0);
  assert.equal(existsSync(join(dir, '.gh-accounts.json')), false);
  await assert.rejects(acc.forRepo('alice/app'), /Not connected to GitHub/);
});

test('each repo is served with the token of the account that owns it', async () => {
  const acc = make(tmp());
  await acc.addToken(TOK.alice);
  await acc.addToken(TOK.bob);
  const repos = await acc.listRepos();
  const by = Object.fromEntries(repos.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), ['acme/api', 'alice/app', 'bob/tool', 'shared/lib', 'ssoorg/secret']);
  assert.equal(by['alice/app'].account, 'alice');
  assert.equal(by['bob/tool'].account, 'bob');
  assert.equal(by['shared/lib'].account, 'bob', 'admin beats read');
  assert.equal(by['shared/lib'].role, 'admin');
  assert.deepEqual(by['shared/lib'].accounts, [{ login: 'alice', role: 'read' }, { login: 'bob', role: 'admin' }]);
  assert.equal(by['acme/api'].account, 'alice', 'equal permission: the default account');
  noTokens(repos, 'repo list');

  for (const [repo, login, token] of [['alice/app', 'alice', TOK.alice], ['bob/tool', 'bob', TOK.bob], ['shared/lib', 'bob', TOK.bob], ['acme/api', 'alice', TOK.alice]]) {
    const c = await acc.forRepo(repo);
    assert.equal(c.login, login);
    await c.gh(`/repos/${repo}/issues`);
    assert.equal(mock.last(`/repos/${repo}/issues`).token, token, `${repo} used @${login}'s token`);
    await c.gh(`/repos/${repo}/issues`, { method: 'POST', body: { title: 'x' } }); // against the mock only
    const w = mock.last(`/repos/${repo}/issues`);
    assert.equal(w.method, 'POST');
    assert.equal(w.token, token, `writes to ${repo} are attributed to @${login}`);
  }

  // Changing the default flips ties only.
  await acc.setDefault('bob');
  assert.equal((await acc.forRepo('acme/api')).login, 'bob');
  assert.equal((await acc.forRepo('alice/app')).login, 'alice');

  // Explicit per-repo choice wins and is remembered across restarts.
  const info = await acc.setRepoAccount('shared/lib', 'alice');
  assert.equal(info.login, 'alice');
  assert.equal(info.overridden, true);
  assert.equal((await acc.forRepo('Shared/Lib')).login, 'alice', 'case-insensitive');
  noTokens(info, 'repo account');
  await acc.setRepoAccount('shared/lib', null);
  assert.equal((await acc.forRepo('shared/lib')).login, 'bob');
  await assert.rejects(acc.setRepoAccount('shared/lib', 'mallory'), /not connected/);
});

test('a repo in nobody\'s list is probed per account', async () => {
  const acc = make(tmp());
  await acc.addToken(TOK.alice);
  await acc.addToken(TOK.bob);
  assert.equal((await acc.forRepo('open/thing')).login, 'alice'); // both can read: default
  const info = await acc.repoAccount('open/thing');
  assert.deepEqual(info.candidates.map((c) => c.login).sort(), ['alice', 'bob']);
});

test('a revoked token flags only that account; the others keep working', async () => {
  const acc = make(tmp());
  await acc.addToken(TOK.alice);
  await acc.addToken(TOK.bob);
  await acc.listRepos();
  mock.revoke(TOK.bob);
  try {
    const c = await acc.forRepo('bob/tool');
    await assert.rejects(c.gh('/repos/bob/tool/issues'), /rejected the token for @bob/);
    const l = await acc.list();
    assert.equal(l.accounts.find((a) => a.login === 'bob').status, 'attention');
    assert.equal(l.accounts.find((a) => a.login === 'alice').status, 'ok');
    await (await acc.forRepo('alice/app')).gh('/repos/alice/app/issues');
    assert.equal((await acc.forRepo('shared/lib')).login, 'alice', 'falls back to a healthy account that can reach the repo');
    const repos = await acc.listRepos(); // must not throw because one account is broken
    assert.ok(repos.some((r) => r.name === 'alice/app'));
    assert.equal((await acc.check()).accounts.find((a) => a.login === 'bob').status, 'attention');
  } finally { mock.restore(TOK.bob); }
  assert.equal((await acc.check()).accounts.find((a) => a.login === 'bob').status, 'ok', 'recovers once the token works again');
});

test('disconnecting removes the account, its repos, its overrides and its token on disk', async () => {
  const dir = tmp();
  const acc = make(dir);
  await acc.addToken(TOK.alice);
  await acc.addToken(TOK.bob);
  await acc.listRepos();
  await acc.setRepoAccount('acme/api', 'bob');
  const r = await acc.remove('bob');
  assert.equal(r.removed, 'bob');
  assert.deepEqual(r.orphaned, ['bob/tool'], 'only repos nobody else can reach are reported for cache cleanup');
  const repos = await acc.listRepos();
  assert.ok(!repos.some((x) => x.name === 'bob/tool'));
  assert.ok(repos.every((x) => x.account === 'alice' && x.accounts.every((a) => a.login === 'alice')));
  const raw = readFileSync(join(dir, '.gh-accounts.json'), 'utf8');
  assert.ok(!raw.includes(TOK.bob) && !raw.includes('"bob"'));
  assert.equal((await acc.forRepo('acme/api')).login, 'alice');
  await assert.rejects(acc.remove('bob'), /not connected/);
  // Removing the default promotes another account.
  await acc.addToken(TOK.bob);
  await acc.remove('alice');
  assert.equal((await acc.status()).login, 'bob');
});

test('a disconnected env/CLI account stays disconnected across restarts until reconnected', async () => {
  const dir = tmp();
  const o = { cliToken: () => TOK.alice };
  const acc = make(dir, o);
  assert.equal((await acc.status()).login, 'alice');
  await acc.remove('alice');
  assert.equal((await acc.status()).connected, false);
  const again = make(dir, o);
  const l = await again.list();
  assert.equal(l.accounts.length, 0);
  assert.deepEqual(l.hidden.map((h) => [h.login, h.source]), [['alice', 'cli']]);
  noTokens(l, 'list');
  await again.reconnect('alice');
  assert.equal((await again.status()).login, 'alice');
});

test('READ_ONLY blocks writes for every account before any request is sent', async () => {
  const acc = make(tmp(), { readOnly: true });
  await acc.addToken(TOK.alice);
  await acc.addToken(TOK.bob);
  const before = mock.writes().length;
  for (const repo of ['alice/app', 'bob/tool']) {
    const c = await acc.forRepo(repo);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) await assert.rejects(c.gh(`/repos/${repo}/issues`, { method, body: {} }), /Read-only mode/);
    await c.gh(`/repos/${repo}/issues`); // reads still work
  }
  assert.equal(mock.writes().length, before);
});

test('an SSO-protected org gives a readable error naming the account', async () => {
  const acc = make(tmp());
  await acc.addToken(TOK.alice);
  await acc.addToken(TOK.bob);
  const c = await acc.forRepo('ssoorg/secret');
  await assert.rejects(c.gh('/repos/ssoorg/secret/issues'), (e) => {
    assert.match(e.message, /@alice's token is not authorized for this organization's single sign-on/);
    assert.match(e.message, /https:\/\/github\.com\/orgs\/ssoorg\/sso/);
    return true;
  });
  assert.equal((await acc.list()).accounts.find((a) => a.login === 'alice').status, 'ok', 'SSO is not a dead token');
});

test('tokens never appear in public shapes or error messages', async () => {
  const acc = make(tmp(), { envToken: TOK.bob });
  await acc.addToken(TOK.alice);
  const c = await acc.forRepo('alice/app');
  const err = await c.gh('/repos/alice/app/leak').catch((e) => e);
  assert.match(err.message, /GitHub 500/);
  assert.match(err.message, /\*\*\*/);
  noTokens(err.message, 'error message');
  noTokens(await acc.list(), 'list');
  noTokens(await acc.status(), 'status');
  noTokens(await acc.check(), 'check');
  noTokens(await acc.listRepos(), 'repos');
  noTokens(await acc.repoAccount('alice/app'), 'repo account');
  noTokens(await acc.setDefault('bob'), 'setDefault');
  noTokens(await acc.remove('bob'), 'remove');
  assert.equal(Object.keys(await acc.forRepo('alice/app')).includes('token'), true, 'the token exists only on the server-side client');
});
