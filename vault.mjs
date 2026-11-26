// Hosted board only: it has no durable disk, so the GitHub accounts and provider keys added in the UI are kept in a
// Redis database (Upstash over its REST API, as the Vercel Marketplace provides it). The database only ever holds
// ciphertext (AES-256-GCM, key derived from ACCESS_KEY), so changing ACCESS_KEY discards what was saved.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ENTRY = 'gh-board:state';

export function createVault(secret, env = process.env) {
  const url = String(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  // The database token is for this module only: no child process or error message gets it.
  for (const k of ['KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'KV_URL', 'REDIS_URL']) delete env[k];
  const configured = !!(url && token);
  const key = scryptSync(String(secret), 'gh-board vault v1', 32);

  const seal = (value) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  };
  /** null when the entry was written under another key or has been altered. */
  const open = (sealed) => {
    try {
      const raw = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
    } catch { return null; }
  };

  async function command(args) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
    } catch { throw new Error('The database could not be reached. Try again.'); }
    if (!r.ok) throw new Error(`The database refused the request (${r.status}). Check its connection in the Vercel project.`);
    return (await r.json()).result;
  }
  const needDb = () => { if (!configured) throw new Error('No database is connected, so this cannot be saved. In the Vercel project open Storage, add an Upstash Redis database, then redeploy.'); };

  return {
    configured, seal, open, needDb, command,
    /** The stored entry as sealed text, or ''. */
    read: async () => (configured ? String((await command(['GET', ENTRY])) || '') : ''),
    write: async (sealed) => { needDb(); await command(['SET', ENTRY, sealed]); },
  };
}
