// Remote access through `tailscale serve`: the board stays bound to loopback, and Tailscale publishes it over
// HTTPS to the devices of the tailnet only. Turning it on creates an access key that every remote request needs.
// This module never uses Funnel (public internet) and never touches a port it did not set up itself.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HTTPS_PORT = 8443;
const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// A request is remote unless it comes straight from this computer. A proxy such as tailscale serve connects from
// loopback and forwards whatever Host the client sent, so the headers it adds are checked as well as the Host.
export function isRemote(req, port) {
  const h = req.headers;
  if (!LOOPBACK_ADDR.has(req.socket?.remoteAddress)) return true;
  if (![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(h.host) && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h.host || '')) return true;
  return Object.keys(h).some((k) => k === 'forwarded' || k.startsWith('x-forwarded-') || k.startsWith('tailscale-') || k.startsWith('cf-'));
}

function findBin(env) {
  if (env.TAILSCALE_BIN) return env.TAILSCALE_BIN;
  const known = ['C:\\Program Files\\Tailscale\\tailscale.exe', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return known.find((p) => existsSync(p)) || 'tailscale';
}

export function createTunnel({ dir, port, env = process.env }) {
  const file = join(dir, '.tunnel.json');
  const bin = findBin(env);
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  let state = load();
  const save = (next) => {
    state = next;
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };

  // A .mjs override is run with this node binary (used by the tests).
  const ts = (args) => new Promise((resolve, reject) => {
    const [cmd, pre] = bin.endsWith('.mjs') ? [process.execPath, [bin]] : [bin, []];
    execFile(cmd, [...pre, ...args], { timeout: 20000, windowsHide: true, maxBuffer: 5e6 }, (e, stdout, stderr) => {
      if (!e) return resolve(stdout);
      if (e.code === 'ENOENT') return reject(Object.assign(new Error('Tailscale is not installed on this computer (tailscale.com/download).'), { notInstalled: true }));
      reject(new Error(`tailscale ${args[0]} failed: ${(stderr || stdout || e.message).trim().slice(0, 400)}`));
    });
  });

  const target = `http://127.0.0.1:${port}`;
  async function inspect() {
    const s = JSON.parse(await ts(['status', '--json']));
    if (s.BackendState !== 'Running') throw new Error('Tailscale is installed but not connected. Open Tailscale and sign in.');
    const name = String(s.Self?.DNSName || '').replace(/\.$/, '');
    if (!name || !(s.CertDomains || []).includes(name)) throw new Error('HTTPS is not enabled for this tailnet. Turn on MagicDNS and HTTPS certificates in the Tailscale admin console.');
    const serve = JSON.parse((await ts(['serve', 'status', '--json'])).trim() || '{}');
    const host = `${name}:${HTTPS_PORT}`;
    const handlers = Object.entries(serve.Web?.[host]?.Handlers || {});
    const ours = handlers.length === 1 && handlers[0][0] === '/' && handlers[0][1].Proxy === target;
    return {
      host,
      ours,
      occupied: !ours && !!(handlers.length || serve.TCP?.[HTTPS_PORT]),
      funnelOnOurPort: !!serve.AllowFunnel?.[host],
      // Anything on this machine that the public internet can reach, so Settings can point it out.
      publicElsewhere: Object.entries(serve.AllowFunnel || {}).filter(([k, on]) => on && k !== host)
        .map(([k]) => ({ address: k, to: Object.values(serve.Web?.[k]?.Handlers || {}).map((h) => h.Proxy || 'files or text').join(', ') })),
    };
  }

  const host = () => (state.enabled ? state.host : null);
  const key = () => (state.enabled ? state.key : null);
  const newKey = () => randomBytes(24).toString('hex');

  async function status({ reveal = false } = {}) {
    const base = { enabled: !!state.enabled, url: state.enabled ? `https://${state.host}` : null };
    if (!reveal) return { ...base, local: false };
    const link = state.enabled ? `https://${state.host}/?key=${state.key}` : null;
    try {
      const i = await inspect();
      return { ...base, local: true, installed: true, ready: true, live: i.ours, public: i.funnelOnOurPort, publicElsewhere: i.publicElsewhere, link };
    } catch (e) {
      return { ...base, local: true, installed: !e.notInstalled, ready: false, live: false, public: false, publicElsewhere: [], link, error: e.message };
    }
  }

  async function enable() {
    const i = await inspect();
    if (i.funnelOnOurPort) throw new Error(`Funnel (public internet) is on for port ${HTTPS_PORT}. Turn it off first: tailscale funnel --https=${HTTPS_PORT} off`);
    if (i.occupied) throw new Error(`Tailscale port ${HTTPS_PORT} already serves something else; it was left untouched.`);
    const before = state;
    // The key is saved before the address goes live, so there is no moment where it is reachable without one.
    save({ enabled: true, host: i.host, key: state.key || newKey() });
    try {
      if (!i.ours) await ts(['serve', '--bg', `--https=${HTTPS_PORT}`, target]);
    } catch (e) { save(before); throw e; }
    return status({ reveal: true });
  }

  async function disable() {
    // The key stops working first, even if Tailscale cannot be reached to remove the address.
    save({ ...state, enabled: false, key: undefined });
    const i = await inspect();
    if (i.ours) await ts(['serve', `--https=${HTTPS_PORT}`, 'off']);
    return status({ reveal: true });
  }

  // Signs every remote device out.
  async function rotate() {
    if (!state.enabled) throw new Error('Remote access is off.');
    save({ ...state, key: newKey() });
    return status({ reveal: true });
  }

  return { status, enable, disable, rotate, host, key };
}
