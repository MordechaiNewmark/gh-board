// Read-only local checkouts for repo analysis, and the path guard that keeps the agent inside them.
// Nothing here writes to GitHub. The GitHub token is handed to git through the environment only:
// never in the remote URL, the process arguments, or .git/config.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, realpath, stat, lstat, open, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CACHE_ROOT = join(__dirname, '.repo-cache');
export const EMPTY_DIR = join(CACHE_ROOT, '.empty'); // agent cwd when no repo is selected
const NO_HOOKS = join(CACHE_ROOT, '.no-hooks'); // never created: git finds no hooks to run

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const MAX_MB = num(process.env.ANALYSIS_MAX_MB, 300);
export const SYNC_TIMEOUT_MS = num(process.env.ANALYSIS_SYNC_TIMEOUT_S, 180) * 1000;
export const MAX_READ_BYTES = num(process.env.ANALYSIS_MAX_FILE_MB, 5) * 1024 * 1024;

/* ------------------------------ validation ------------------------------ */

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,199}$/;

/** Strict "owner/name" parser. Throws on anything that could escape the cache dir or look like an option. */
export function parseRepo(repo) {
  if (typeof repo !== 'string') throw new Error('repo must be "owner/name"');
  const parts = repo.split('/');
  if (parts.length !== 2) throw new Error('repo must be "owner/name"');
  const [owner, name] = parts;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === '.' || name === '..' || name.endsWith('.') || WIN_RESERVED.test(name) || WIN_RESERVED.test(owner)) {
    throw new Error(`"${repo.slice(0, 80)}" is not a valid owner/name`);
  }
  return { owner, name, full: `${owner}/${name}`, key: `${owner}/${name}`.toLowerCase() };
}

export function checkRef(ref) {
  if (ref === undefined || ref === null || ref === '') return undefined;
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock') || ref.endsWith('.')) {
    throw new Error('ref must be a plain branch, tag or commit SHA');
  }
  return ref;
}

/** Absolute checkout dir for a repo; always directly under CACHE_ROOT/<owner>/<name>. */
export function checkoutDir(repo) {
  const { key } = parseRepo(repo);
  const dir = resolve(CACHE_ROOT, ...key.split('/'));
  const rel = relative(CACHE_ROOT, dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).length !== 2) throw new Error('Invalid repo path');
  return dir;
}

/* --------------------------------- git ---------------------------------- */

/** Environment for git: token as a github.com-only HTTP header, no prompts, no credential helper, no hooks, no symlinks, no LFS. */
export function gitEnv(token) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Drop anything that could redirect git, turn on tracing (which prints headers), or leak app secrets to the child.
    if (/^GIT_/i.test(k) || /^(GITHUB_TOKEN|GH_TOKEN|ACCESS_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/i.test(k)) continue;
    env[k] = v;
  }
  const cfg = [
    ['credential.helper', ''],
    ['core.hooksPath', NO_HOOKS],
    ['core.symlinks', 'false'],
    ['core.fsmonitor', 'false'],
    ['core.longpaths', 'true'],
    ['core.autocrlf', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['submodule.recurse', 'false'],
    ['gc.auto', '0'],
    ['advice.detachedHead', 'false'],
  ];
  if (token) cfg.unshift(['http.https://github.com/.extraheader', `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]);
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_LFS_SKIP_SMUDGE = '1';
  env.GIT_ASKPASS = '';
  return env;
}

function scrub(text, token) {
  let s = String(text || '');
  if (token) {
    s = s.split(token).join('***');
    s = s.split(Buffer.from(`x-access-token:${token}`).toString('base64')).join('***');
  }
  return s.replace(/(authorization:\s*)\S+(\s+\S+)?/gi, '$1***');
}

/** Run git with an argument array (no shell). Rejects with scrubbed stderr; kills the process tree on timeout. */
export function git(args, { cwd, token, timeout = 60000, maxOut = 32 * 1024 * 1024 } = {}) {
  return new Promise((res, rej) => {
    const child = spawn('git', args, { cwd, env: gitEnv(token), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let outLen = 0; let err = ''; let timedOut = false;
    const kill = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    child.stdout.on('data', (c) => { outLen += c.length; if (outLen > maxOut) kill(); else out.push(c); });
    child.stderr.on('data', (c) => { if (err.length < 8000) err += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); rej(new Error(e.code === 'ENOENT' ? 'git is not installed or not on PATH' : scrub(e.message, token))); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return rej(new Error(`git ${args.find((a) => !a.startsWith('-') && a !== cwd) || ''} timed out after ${Math.round(timeout / 1000)}s`));
      if (code !== 0) return rej(new Error(scrub(err, token).trim().split('\n').slice(-4).join(' ').slice(0, 500) || `git exited with ${code}`));
      res(Buffer.concat(out).toString('utf8'));
    });
  });
}

const inflight = new Map(); // key -> Promise
const last = new Map(); // key -> { at, ref, result }

export const isSynced = (repo) => { try { return last.has(parseRepo(repo).key) && existsSync(join(checkoutDir(repo), '.git')); } catch { return false; } };

/**
 * Shallow-fetch one commit of the repo into .repo-cache/<owner>/<name> and check it out (detached, read-only use).
 * info: { size (KB), default_branch } from the GitHub API. Returns a summary the agent can orient itself with.
 */
export async function syncRepo(repo, { ref, token, info = {}, onProgress = () => {}, maxAgeMs = 0 } = {}) {
  const { owner, name, full, key } = parseRepo(repo);
  ref = checkRef(ref);
  const dir = checkoutDir(full);
  const want = ref || info.default_branch || 'HEAD';
  checkRef(want);

  const prev = last.get(key);
  if (prev && maxAgeMs && prev.ref === want && Date.now() - prev.at < maxAgeMs && existsSync(join(dir, '.git'))) return { ...prev.result, cached: true };
  const flightKey = `${key}@${want}`;
  if (inflight.has(flightKey)) return inflight.get(flightKey);
  // One sync per checkout at a time, whatever the ref.
  const others = [...inflight.entries()].filter(([k]) => k.startsWith(`${key}@`)).map(([, p]) => p.catch(() => {}));

  const run = (async () => {
    await Promise.all(others);
    const mb = Math.round((info.size || 0) / 1024);
    if (mb > MAX_MB) throw new Error(`${full} is about ${mb} MB, over the ${MAX_MB} MB analysis limit (ANALYSIS_MAX_MB in .env). Use read_file / search_code for this repo instead.`);

    await mkdir(dir, { recursive: true });
    const url = `https://github.com/${owner}/${name}.git`;
    const fresh = !existsSync(join(dir, '.git'));
    if (fresh) {
      await git(['init', '--quiet', '--', dir], { cwd: CACHE_ROOT });
      await git(['-C', dir, 'remote', 'add', '--', 'origin', url]);
    } else {
      await git(['-C', dir, 'remote', 'set-url', '--', 'origin', url]);
    }
    onProgress(fresh ? `Cloning ${full} (${want})…` : `Updating ${full} (${want})…`);
    await git(['-C', dir, 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--force', '--quiet', 'origin', want], { token, timeout: SYNC_TIMEOUT_MS });
    onProgress('Checking out files…');
    await git(['-C', dir, 'checkout', '--force', '--detach', '--quiet', 'FETCH_HEAD'], { timeout: SYNC_TIMEOUT_MS });
    const sha = (await git(['-C', dir, 'rev-parse', 'HEAD'])).trim();
    onProgress('Indexing files…');
    const result = { repo: full, ref: want, sha, checkout: dir, ...(await summarize(dir)) };
    last.set(key, { at: Date.now(), ref: want, result });
    onProgress(`${want} @ ${sha.slice(0, 7)} · ${result.files} files · ${fmtBytes(result.bytes)}`);
    return result;
  })();
  inflight.set(flightKey, run);
  try { return await run; } finally { inflight.delete(flightKey); }
}

/** Delete a repo's local checkout (used when the only account that could reach it is disconnected). */
export async function dropCheckout(repo) {
  const { key } = parseRepo(repo);
  const dir = checkoutDir(repo); // validated: always CACHE_ROOT/<owner>/<name>
  await Promise.all([...inflight.entries()].filter(([k]) => k.startsWith(`${key}@`)).map(([, p]) => p.catch(() => {})));
  last.delete(key);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** File inventory of a checkout: counts, sizes, top-level layout, extensions, and the files worth reading first. */
async function summarize(dir) {
  const files = (await git(['-C', dir, 'ls-files', '-z'])).split('\0').filter(Boolean);
  let bytes = 0;
  const byExt = new Map(); const top = new Map(); const big = [];
  for (const f of files.slice(0, 20000)) {
    const s = await lstat(join(dir, f)).catch(() => null);
    const size = s?.size || 0;
    bytes += size;
    const ext = extname(f).toLowerCase() || '(none)';
    byExt.set(ext, (byExt.get(ext) || 0) + 1);
    const head = f.includes('/') ? `${f.split('/')[0]}/` : f;
    top.set(head, (top.get(head) || 0) + 1);
    if (size > 300000) big.push({ path: f, bytes: size });
  }
  const pick = (re, n = 25) => files.filter((f) => re.test(f)).slice(0, n);
  return {
    files: files.length, bytes,
    top_level: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([p, n]) => (p.endsWith('/') ? `${p} (${n} files)` : p)),
    extensions: Object.fromEntries([...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)),
    docs: pick(/(^|\/)(readme|contributing|changelog|architecture|design|spec|roadmap|todo|claude|agents)[^/]*\.(md|mdx|txt|rst)$|^(docs?|specs?|rfcs?|adr)\//i, 40),
    manifests: pick(/(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml|pom\.xml|build\.gradle(\.kts)?|gemfile|composer\.json|[^/]*\.csproj|dockerfile|docker-compose[^/]*\.ya?ml|makefile|\.env\.example|tsconfig\.json)$/i),
    ci: pick(/^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\//i, 15),
    tests: { count: files.filter((f) => /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[a-z]+$/i.test(f)).length, sample: pick(/(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[a-z]+$/i, 12) },
    large_files: big.sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    note: 'Explore with Read, Glob and Grep; relative paths resolve inside the checkout. Line numbers from Read/Grep are exact for this sha.',
  };
}

/* ------------------------------ path guard ------------------------------ */

const DENY_SEGMENTS = new Set(['.git', 'node_modules']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.psd', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wav', '.ogg', '.flac',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war', '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.pyc', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.iso', '.dmg', '.pack', '.idx']);
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (root, p) => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Resolve a path the agent asked for and prove it is inside `root` (a checkout dir), following symlinks.
 * Returns { ok: true, path, rel, stat } or { ok: false, reason }.
 */
export async function guardPath(root, p, { want } = {}) {
  if (!root) return { ok: false, reason: 'No repository is selected.' };
  if (typeof p !== 'string' || !p || p.includes('\0')) return { ok: false, reason: 'Invalid path.' };
  let realRoot;
  try { realRoot = await realpath(root); } catch { return { ok: false, reason: 'The repo is not synced yet. Call sync_repo first.' }; }
  if (!inside(await realpath(CACHE_ROOT), realRoot) || same(realRoot, await realpath(CACHE_ROOT))) return { ok: false, reason: 'Invalid checkout.' };

  // Relative paths resolve against the checkout. The realpath comparison below is the authoritative check.
  const outside = `Outside the repo checkout: only files under ${root} can be read.`;
  const lexical = resolve(realRoot, p);
  if (lexical.slice(2).includes(':')) return { ok: false, reason: 'Invalid path.' }; // NTFS alternate data streams
  let real;
  try { real = await realpath(lexical); } catch { return { ok: false, reason: inside(realRoot, lexical) ? `Not found in the checkout: ${relative(realRoot, lexical) || '.'}` : outside }; }
  if (!inside(realRoot, real)) return { ok: false, reason: outside };
  const rel = relative(realRoot, real);
  const segs = rel.split(sep).filter(Boolean).map((s) => s.toLowerCase().replace(/[. ]+$/, ''));
  const bad = segs.find((s) => DENY_SEGMENTS.has(s));
  if (bad) return { ok: false, reason: `${bad} is excluded from analysis.` };
  const st = await stat(real);
  if (want === 'file') {
    if (!st.isFile()) return { ok: false, reason: `${rel || '.'} is not a file. Use Glob to list directories.` };
    if (BINARY_EXT.has(extname(real).toLowerCase())) return { ok: false, reason: `${rel} is a binary/media file and is skipped.` };
    if (st.size > MAX_READ_BYTES) return { ok: false, reason: `${rel} is ${fmtBytes(st.size)}, over the ${fmtBytes(MAX_READ_BYTES)} read limit. Use Grep to look inside it.` };
    const fh = await open(real, 'r');
    try {
      const buf = Buffer.alloc(Math.min(4096, st.size));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.includes(0)) return { ok: false, reason: `${rel} looks binary and is skipped.` };
    } finally { await fh.close(); }
  }
  return { ok: true, path: real, rel: rel.split(sep).join('/'), stat: st };
}

// A glob may only describe paths below the search root.
const globOk = (g) => typeof g === 'string' && g.length < 500 && !g.includes('\0') && !/^([\\/]|[A-Za-z]:|~)/.test(g) && !g.split(/[\\/{},]/).includes('..');

/**
 * Decide whether a built-in tool call may run. Only Read, Glob and Grep are ever allowed, and only inside `root`.
 * Returns { ok: true, input } (paths rewritten to their resolved form) or { ok: false, reason }.
 */
export async function guardTool(root, toolName, input) {
  const inp = input && typeof input === 'object' ? { ...input } : {};
  if (toolName === 'Read') {
    const g = await guardPath(root, inp.file_path, { want: 'file' });
    if (!g.ok) return g;
    return { ok: true, input: { ...inp, file_path: g.path } };
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    if (toolName === 'Glob' && !globOk(inp.pattern)) return { ok: false, reason: 'Glob patterns must be relative to the repo checkout and may not contain "..".' };
    if (toolName === 'Grep' && typeof inp.pattern !== 'string') return { ok: false, reason: 'Missing pattern.' };
    if (inp.glob !== undefined && !globOk(inp.glob)) return { ok: false, reason: 'The glob filter must be relative and may not contain "..".' };
    const g = await guardPath(root, inp.path === undefined || inp.path === '' ? '.' : inp.path);
    if (!g.ok) return g;
    return { ok: true, input: { ...inp, path: g.path } };
  }
  return { ok: false, reason: 'Tool not available.' };
}
