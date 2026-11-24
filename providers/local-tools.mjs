// Read-only exploration of the selected repo's checkout for non-Claude providers: the equivalents of
// Claude Code's Read, Glob and Grep. Every path goes through repo-cache.mjs's guardPath, so the same
// rules apply as on the Claude path: nothing outside the checkout (symlinks and junctions resolved),
// no .git, no node_modules, no binaries, nothing over the read limit. There is no write and no shell.
import { readdir, readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { guardPath, guardTool } from '../repo-cache.mjs';

export const LIMITS = {
  readDefaultLines: 400, readMaxLines: 2000, lineChars: 2000,
  globMax: 300, grepDefault: 80, grepMax: 200, grepLineChars: 300, grepTimeoutMs: 20000,
  walkFiles: 20000, walkDirs: 5000,
};

const deny = (root, reason) => new Error(String(reason).split(root).join('the checkout'));

/** Glob -> RegExp over a forward-slash relative path. Supports ** * ? [set] {a,b}. A pattern without "/" matches at any depth. */
export function globToRegExp(glob) {
  let g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g.includes('/')) g = `**/${g}`;
  let re = ''; let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = g.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else { const body = g.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/^!/, '^'); re += `[${body}]`; i = end; }
    } else if (c === '{') { depth++; re += '(?:'; }
    else if (c === '}' && depth) { depth--; re += ')'; }
    else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|\\{}\]]/g, '\\$&');
  }
  if (depth) throw new Error('Unbalanced { in glob.');
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Walk a guarded directory. Yields forward-slash paths relative to the checkout root. Symlinks and junctions
 * are never followed, and every directory is re-checked by guardPath before it is listed.
 */
export async function* walk(root, startRel = '.', counters = { files: 0, dirs: 0, capped: false }) {
  const stack = [startRel];
  while (stack.length) {
    const rel = stack.pop();
    const g = await guardPath(root, rel);
    if (!g.ok || !g.stat.isDirectory()) continue;
    if (++counters.dirs > LIMITS.walkDirs) { counters.capped = true; return; }
    let entries;
    try { entries = await readdir(g.path, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const child = g.rel ? `${g.rel}/${e.name}` : e.name;
      if (e.isDirectory()) dirs.push(child);
      else if (e.isFile()) {
        if (++counters.files > LIMITS.walkFiles) { counters.capped = true; return; }
        yield child;
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
  }
}

/** read_file_local: a line range of one text file, with line numbers. */
export async function readFileLocal(root, { path, offset, limit }) {
  const g = await guardPath(root, String(path ?? ''), { want: 'file' });
  if (!g.ok) throw deny(root, g.reason);
  const lines = (await readFile(g.path, 'utf8')).split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(1, Math.floor(Number(offset) || 1));
  const count = Math.min(LIMITS.readMaxLines, Math.max(1, Math.floor(Number(limit) || LIMITS.readDefaultLines)));
  const end = Math.min(lines.length, start + count - 1);
  if (start > lines.length) return `${g.rel}: ${lines.length} lines; offset ${start} is past the end.`;
  const body = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l.length > LIMITS.lineChars ? `${l.slice(0, LIMITS.lineChars)}… (line cut)` : l}`).join('\n');
  return `${g.rel} (lines ${start}-${end} of ${lines.length})${end < lines.length ? `. More below: call again with offset ${end + 1}.` : ''}\n${body}`;
}

/** glob: list files by pattern, sorted by path. */
export async function globLocal(root, { pattern, path }) {
  const g = await guardTool(root, 'Glob', { pattern, path: path === undefined || path === '' ? '.' : String(path) });
  if (!g.ok) throw deny(root, g.reason);
  const base = await guardPath(root, g.input.path);
  if (!base.ok) throw deny(root, base.reason);
  if (!base.stat.isDirectory()) throw new Error(`${base.rel} is a file, not a directory.`);
  if ((String(pattern).match(/[*?]/g) || []).length > 24) throw new Error('Too many wildcards in the pattern.');
  const re = globToRegExp(pattern);
  const counters = { files: 0, dirs: 0, capped: false };
  const out = []; let total = 0;
  const prefix = base.rel ? `${base.rel}/` : '';
  for await (const f of walk(root, base.rel || '.', counters)) {
    if (!re.test(f.slice(prefix.length))) continue;
    total++;
    if (out.length < LIMITS.globMax) out.push(f);
  }
  if (!total) return `No files match ${pattern}${base.rel ? ` under ${base.rel}` : ''}.`;
  return `${total} file${total === 1 ? '' : 's'} match${total > out.length ? ` (first ${out.length} shown; narrow the pattern)` : ''}${counters.capped ? ' (large repo: the walk was capped, results are partial)' : ''}:\n${out.join('\n')}`;
}

/**
 * grep: regex search. Runs in a worker thread, so a pathological pattern (repo text can try to make the
 * model send one) cannot stall the server: the worker is terminated at the timeout.
 */
export async function grepLocal(root, args, { signal } = {}) {
  const g = await guardTool(root, 'Grep', { pattern: args.pattern, path: args.path === undefined || args.path === '' ? '.' : String(args.path), ...(args.glob ? { glob: String(args.glob) } : {}) });
  if (!g.ok) throw deny(root, g.reason);
  if (!args.pattern || String(args.pattern).length > 1000) throw new Error('Give a regular expression of at most 1000 characters.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./grep-worker.mjs', import.meta.url), { workerData: { root, args: { ...args, path: g.input.path } }, env: process.env.ANALYSIS_MAX_FILE_MB ? { ANALYSIS_MAX_FILE_MB: process.env.ANALYSIS_MAX_FILE_MB } : {} });
    let done = false;
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); worker.terminate().catch(() => {}); fn(v); };
    const timer = setTimeout(() => end(reject, new Error(`Search timed out after ${LIMITS.grepTimeoutMs / 1000}s. Use a simpler pattern or a narrower path/glob.`)), LIMITS.grepTimeoutMs);
    const onAbort = () => end(reject, new Error('Stopped.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m) => (m.ok ? end(resolve, m.result) : end(reject, deny(root, m.error))));
    worker.once('error', (e) => end(reject, deny(root, e.message || e)));
    worker.once('exit', () => end(reject, new Error('Search stopped unexpectedly.')));
  });
}

/** The body of grep; called inside the worker. Exported so tests can run it directly. */
export async function grepRun(root, { pattern, path = '.', glob, ignore_case, context, max_results, files_only }) {
  let re;
  try { re = new RegExp(String(pattern), ignore_case ? 'i' : ''); } catch (e) { throw new Error(`Invalid regular expression: ${e.message}`); }
  const base = await guardPath(root, path);
  if (!base.ok) throw new Error(base.reason);
  const max = Math.min(LIMITS.grepMax, Math.max(1, Math.floor(Number(max_results) || LIMITS.grepDefault)));
  const ctxN = Math.min(5, Math.max(0, Math.floor(Number(context) || 0)));
  const filter = glob ? globToRegExp(glob) : null;
  const counters = { files: 0, dirs: 0, capped: false };
  const cut = (l) => (l.length > LIMITS.grepLineChars ? `${l.slice(0, LIMITS.grepLineChars)}…` : l);
  const out = []; let matches = 0; let scanned = 0; let hitFiles = 0; let truncated = false;

  const scan = async (rel) => {
    const g = await guardPath(root, rel, { want: 'file' });
    if (!g.ok) return;
    scanned++;
    const lines = (await readFile(g.path, 'utf8')).split(/\r?\n/);
    let last = -1; let hit = false;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i].length > 4000 ? lines[i].slice(0, 4000) : lines[i])) continue;
      if (!hit) { hit = true; hitFiles++; if (files_only) { out.push(g.rel); matches++; return; } }
      if (matches >= max) { truncated = true; return; }
      matches++;
      for (let k = Math.max(last + 1, i - ctxN); k < i; k++) out.push(`${g.rel}-${k + 1}- ${cut(lines[k])}`);
      out.push(`${g.rel}:${i + 1}: ${cut(lines[i])}`);
      const until = Math.min(lines.length - 1, i + ctxN);
      for (let k = i + 1; k <= until; k++) { if (re.test(lines[k])) break; out.push(`${g.rel}-${k + 1}- ${cut(lines[k])}`); last = k; }
      last = Math.max(last, i);
    }
  };

  if (base.stat.isFile()) await scan(base.rel);
  else {
    const prefix = base.rel ? `${base.rel}/` : '';
    for await (const f of walk(root, base.rel || '.', counters)) {
      if (filter && !filter.test(f.slice(prefix.length))) continue;
      await scan(f);
      if (truncated || (files_only && matches >= max)) { truncated = true; break; }
    }
  }
  const where = `${base.rel || 'the repo'}${glob ? ` (${glob})` : ''}`;
  if (!matches) return `No matches for /${pattern}/ in ${where}. ${scanned} text file${scanned === 1 ? '' : 's'} searched.`;
  const head = files_only ? `${matches} file${matches === 1 ? '' : 's'} contain a match` : `${matches} match${matches === 1 ? '' : 'es'} in ${hitFiles} file${hitFiles === 1 ? '' : 's'}`;
  return `${head} for /${pattern}/ in ${where}${truncated ? ` (stopped at ${max}; narrow the search for more)` : ''}${counters.capped ? ' (large repo: the walk was capped)' : ''}:\n${out.join('\n')}`;
}
