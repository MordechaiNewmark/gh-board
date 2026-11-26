// Remote access over a real server process, with a stub in place of the tailscale CLI. Nothing is exposed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3947;
const HOST = 'box.example.ts.net:8443';
const LOCALHOST = `127.0.0.1:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'ghb-t-'));
const serveFile = join(data, 'serve.json');
const stub = join(data, 'tailscale.mjs');
// 443 is somebody else's public Funnel: it must be reported and left alone.
const OTHER = { TCP: { 443: { HTTPS: true } }, Web: { 'box.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8000' } } } }, AllowFunnel: { 'box.example.ts.net:443': true } };
writeFileSync(serveFile, JSON.stringify(OTHER));
writeFileSync(stub, `import { readFileSync, writeFileSync } from 'node:fs';
const f = ${JSON.stringify(serveFile)}; const a = process.argv.slice(2); const s = JSON.parse(readFileSync(f, 'utf8'));
if (a[0] === 'status') console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.example.ts.net.' }, CertDomains: ['box.example.ts.net'] }));
else if (a[1] === 'status') console.log(JSON.stringify(s));
else if (a.join(' ') === 'serve --https=8443 off') { delete s.Web['${HOST}']; delete s.TCP[8443]; writeFileSync(f, JSON.stringify(s)); }
else if (a[0] === 'serve' && a[1] === '--bg' && a[2] === '--https=8443') { s.TCP[8443] = { HTTPS: true }; s.Web['${HOST}'] = { Handlers: { '/': { Proxy: a[3] } } }; writeFileSync(f, JSON.stringify(s)); }
else { console.error('unexpected: ' + a.join(' ')); process.exit(1); }
`);

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ACCESS_KEY: '', ALLOWED_HOSTS: '', GH_BOARD_DATA_DIR: data, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_API_URL: 'http://127.0.0.1:9', TAILSCALE_BIN: stub },
});
test.after(() => { child.kill(); rmSync(data, { recursive: true, force: true }); });

const send = (path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path, method: body ? 'POST' : 'GET', headers: { host: LOCALHOST, ...headers } }, (res) => {
    let text = ''; res.on('data', (c) => (text += c));
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text }); });
  });
  req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
});
for (let i = 0; i < 100; i++) { try { await send('/api/tunnel'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

const proxied = { 'x-forwarded-for': '100.64.0.9', 'x-forwarded-proto': 'https' };

test('off: local works without a key, the tunnel address is refused', async () => {
  const r = await send('/api/tunnel');
  assert.deepEqual([r.status, r.json.enabled, r.json.live, r.json.link], [200, false, false, null]);
  assert.deepEqual(r.json.publicElsewhere, [{ address: 'box.example.ts.net:443', to: 'http://127.0.0.1:8000' }]);
  assert.equal((await send('/api/tunnel', { headers: { host: HOST } })).status, 403);
  assert.equal((await send('/api/tunnel', { headers: proxied })).status, 401, 'a proxied request never counts as local');
});

test('on: remote needs the key, cannot change the setting, and cannot pose as local', async () => {
  assert.match((await send('/api/tunnel/enable', { body: {} })).json.error, /Confirmation required/);
  const on = (await send('/api/tunnel/enable', { body: { confirm: true } })).json;
  assert.deepEqual([on.enabled, on.live, on.url], [true, true, `https://${HOST}`]);
  const key = new URL(on.link).searchParams.get('key');
  assert.match(key, /^[0-9a-f]{48}$/);
  const serve = JSON.parse(readFileSync(serveFile, 'utf8'));
  assert.equal(serve.Web[HOST].Handlers['/'].Proxy, `http://127.0.0.1:${PORT}`);
  assert.deepEqual(serve.Web['box.example.ts.net:443'], OTHER.Web['box.example.ts.net:443']);

  const remote = { host: HOST, ...proxied };
  assert.equal((await send('/api/tunnel', { headers: remote })).status, 401);
  assert.equal((await send('/api/tunnel', { headers: proxied })).status, 401, 'Host: localhost through the proxy');
  assert.equal((await send('/api/tunnel', { headers: { ...remote, cookie: 'ghbs=wrong-token-000000000000000' } })).status, 401);

  const login = await send(`/?key=${key}`, { headers: remote });
  assert.equal(login.status, 303);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; .*Secure/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.match(cookie, /^ghbs=/);
  assert.ok(!cookie.includes(key), 'the cookie holds a session token, not the key');
  assert.equal((await send('/api/tunnel', { headers: { ...remote, cookie: `ghbs=${key}` } })).status, 401);
  const authed = { ...remote, cookie, origin: `https://${HOST}` };
  const seen = await send('/api/tunnel', { headers: authed });
  assert.deepEqual(seen.json, { enabled: true, url: `https://${HOST}`, local: false });
  assert.ok(!seen.text.includes(key));
  for (const action of ['enable', 'disable', 'rotate']) {
    assert.match((await send(`/api/tunnel/${action}`, { headers: authed, body: { confirm: true } })).json.error, /only be changed on the computer/);
  }
  assert.equal((await send('/api/tunnel')).status, 200, 'this computer still needs no key');
  assert.equal((await send('/api/tunnel/disable', { headers: { origin: 'https://evil.example' }, body: { confirm: true } })).status, 403);

  const rotated = (await send('/api/tunnel/rotate', { body: {} })).json;
  assert.notEqual(rotated.link, on.link);
  assert.equal((await send('/api/tunnel', { headers: authed })).status, 401, 'the old key is signed out');
});

test('off again: the address is removed, other ports stay, the key is dead', async () => {
  const off = (await send('/api/tunnel/disable', { body: {} })).json;
  assert.deepEqual([off.enabled, off.live, off.link], [false, false, null]);
  assert.deepEqual(JSON.parse(readFileSync(serveFile, 'utf8')), OTHER);
});

test('a port serving something else, or made public, is refused and left alone', async () => {
  for (const [extra, why] of [
    [{ Web: { ...OTHER.Web, [HOST]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }, /already serves something else/],
    [{ AllowFunnel: { ...OTHER.AllowFunnel, [HOST]: true } }, /Funnel \(public internet\) is on/],
  ]) {
    const before = JSON.stringify({ ...OTHER, ...extra });
    writeFileSync(serveFile, before);
    assert.match((await send('/api/tunnel/enable', { body: { confirm: true } })).json.error, why);
    assert.equal(readFileSync(serveFile, 'utf8'), before);
    assert.equal((await send('/api/tunnel')).json.enabled, false);
  }
});
