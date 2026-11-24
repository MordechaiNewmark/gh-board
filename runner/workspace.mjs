// Persistent working clones for the delivery loop: .workspaces/<owner>/<name>. Unlike the read-only analysis
// checkout in .repo-cache, agents work here (in git worktrees under .worktrees/), so it is a full clone that is
// only ever fast-forwarded, never reset. Clone and fetch reuse repo-cache.mjs's hardened git: the token reaches
// git through the environment only, arguments are arrays, there is no shell, and the repo name is validated.
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { parseRepo, git, SYNC_TIMEOUT_MS, checkRef } from '../repo-cache.mjs';

const MAX_READ = 400 * 1024;

export function createWorkspaces({ root, remoteBase = 'https://github.com' }) {
  root = resolve(root);
  const inflight = new Map();

  /** Absolute workspace dir; always exactly <root>/<owner>/<name>. */
  function dirFor(repo) {
    const { key } = parseRepo(repo);
    const dir = resolve(root, ...key.split('/'));
    const rel = relative(root, dir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).length !== 2) throw new Error('Invalid repo path');
    return dir;
  }
  const exists = (repo) => { try { return existsSync(join(dirFor(repo), '.git')); } catch { return false; } };
  const remoteUrl = (repo) => { const { owner, name } = parseRepo(repo); return `${remoteBase.replace(/[\\/]+$/, '')}/${owner}/${name}.git`; };

  /**
   * Clone the repo, or bring an existing workspace up to date with a fast-forward of the base branch.
   * Local work is never discarded: a dirty or diverged workspace is left as it is and reported in `warning`.
   */
  async function ensure(repo, { token, branch = 'main', onProgress = () => {} } = {}) {
    const { full, key } = parseRepo(repo);
    branch = checkRef(branch) || 'main';
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      const dir = dirFor(full);
      await mkdir(dir, { recursive: true });
      const fresh = !existsSync(join(dir, '.git'));
      const g = (args, o = {}) => git(['-C', dir, ...args], o);
      if (fresh) {
        onProgress(`Cloning ${full}…`);
        await git(['init', '--quiet', '--', dir], { cwd: root });
        await g(['remote', 'add', '--', 'origin', remoteUrl(full)]);
      } else {
        await g(['remote', 'set-url', '--', 'origin', remoteUrl(full)]);
        onProgress(`Updating ${full}…`);
      }
      await g(['fetch', '--prune', '--no-recurse-submodules', '--quiet', 'origin'], { token, timeout: SYNC_TIMEOUT_MS * 2 });
      let warning = '';
      if (fresh) await g(['checkout', '--quiet', '-B', branch, '--track', `origin/${branch}`], { timeout: SYNC_TIMEOUT_MS });
      else {
        const dirty = (await g(['status', '--porcelain', '--untracked-files=no'])).trim();
        if (dirty) warning = 'The workspace has uncommitted changes in its main checkout, so it was not updated.';
        else {
          try {
            const head = (await g(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
            if (head !== branch) await g(['checkout', '--quiet', branch]);
            await g(['merge', '--ff-only', '--quiet', `origin/${branch}`]);
          } catch (e) { warning = `The workspace could not be fast-forwarded to origin/${branch}: ${String(e.message || e).slice(0, 200)}`; }
        }
      }
      const sha = (await g(['rev-parse', 'HEAD'])).trim();
      onProgress(`${branch} @ ${sha.slice(0, 7)}`);
      return { dir, fresh, branch, sha, warning };
    })();
    inflight.set(key, run);
    try { return await run; } finally { inflight.delete(key); }
  }

  /** Read-only view of the workspace's main checkout for the readiness checks: { read(path), list(dir) }. */
  function reader(repo) {
    const dir = dirFor(repo);
    const safe = async (p) => {
      if (typeof p !== 'string' || p.includes('\0') || isAbsolute(p) || p.split(/[\\/]/).includes('..')) return null;
      const abs = resolve(dir, p);
      try {
        const [realRoot, real] = await Promise.all([realpath(dir), realpath(abs)]);
        const rel = relative(realRoot, real);
        return rel.startsWith('..') || isAbsolute(rel) ? null : real;
      } catch { return null; }
    };
    return {
      async read(p) {
        const f = await safe(p);
        if (!f) return null;
        try { const st = await lstat(f); if (!st.isFile() || st.size > MAX_READ) return null; return await readFile(f, 'utf8'); } catch { return null; }
      },
      async list(p) {
        const f = await safe(p || '.');
        if (!f) return null;
        try { return (await readdir(f, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name); } catch { return null; }
      },
    };
  }

  return { root, dirFor, exists, ensure, reader, remoteUrl };
}

/** The same reader over the GitHub contents API, for repos that have no workspace yet. */
export function apiReader(gh, repo, ref) {
  const enc = (p) => String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const cache = new Map();
  const get = (p) => { if (!cache.has(p)) cache.set(p, gh(`/repos/${repo}/contents/${enc(p)}${q}`).catch(() => null)); return cache.get(p); };
  return {
    async read(p) { const r = await get(p); return r && !Array.isArray(r) && typeof r.content === 'string' ? Buffer.from(r.content, 'base64').toString('utf8') : null; },
    async list(p) { const r = await get(p || ''); return Array.isArray(r) ? r.filter((e) => e.type === 'file').map((e) => e.name) : null; },
  };
}
