// The tool set a non-Claude model gets: the SAME GitHub tool definitions server.mjs feeds to the Claude
// MCP server (passed in as `defs`), plus read_file_local / glob / grep over the guarded checkout in place
// of Claude Code's built-in Read / Glob / Grep. Nothing else: no shell, no disk writes, no network tools.
import { z } from 'zod';
import { readFileLocal, globLocal, grepLocal, LIMITS } from './local-tools.mjs';

/** Plain tool definition shared by both paths: { name, description, shape (zod raw shape), run(args) }. */
export const defineTool = (name, description, shape, run) => ({ name, description, shape, run });

const jsonSchema = (shape) => {
  const { $schema, ...rest } = z.toJSONSchema(z.object(shape), { io: 'input' });
  return { type: 'object', properties: {}, ...rest };
};

// Tool descriptions were written for Claude Code's tool names; point them at the local equivalents.
const reword = (s) => String(s)
  .replace(/Read, Glob and Grep/g, 'read_file_local, glob and grep')
  .replace(/Prefer Glob\b/g, 'Prefer glob').replace(/Prefer Read\b/g, 'Prefer read_file_local').replace(/Prefer Grep\b/g, 'Prefer grep')
  .replace('Returns the checkout path, commit sha', 'Returns the commit sha');

const UNTRUSTED = new Set(['get_issue', 'list_issues', 'list_sub_issues', 'read_file', 'search_code', 'read_file_local', 'grep']);
const stripNulls = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) : v);

/**
 * Build the tool list for the generic agent loop.
 *   defs       tool definitions from server.mjs (one source of truth with the MCP server)
 *   readNames  names that never need approval (server.mjs READ_NAMES)
 *   checkout   absolute checkout dir of the selected repo, or null
 *   ensureSynced()  syncs the checkout on first use, like the Claude path's guard does
 */
export function buildTools({ defs, readNames, checkout, ensureSynced }) {
  const reads = new Set(readNames);
  const local = async (fn) => {
    if (!checkout) throw new Error('No repository is selected. Ask the user to pick one in the board.');
    await ensureSynced();
    return fn();
  };
  const P = z.string().describe('Path relative to the repo root, e.g. "src/app.ts"');

  const all = [
    ...defs.map((d) => ({
      ...d, description: reword(d.description), write: !reads.has(d.name), uiName: d.name, uiInput: (a) => a,
      post: d.name === 'sync_repo' ? (r) => { const { checkout: _dir, ...rest } = r || {}; return { ...rest, note: 'Explore with read_file_local, glob and grep; paths are relative to the repo root. Line numbers are exact for this sha.' }; } : null,
    })),
    {
      name: 'read_file_local', write: false, uiName: 'Read', uiInput: (a) => ({ file_path: a.path, ...(a.offset ? { offset: a.offset } : {}), ...(a.limit ? { limit: a.limit } : {}) }),
      description: `Read a text file from the local checkout with exact line numbers ("N<TAB>text"). Returns up to ${LIMITS.readDefaultLines} lines by default; pass offset (1-based first line) and limit (max ${LIMITS.readMaxLines}) for other ranges of a long file. Paths outside the checkout, .git, node_modules and binary files are denied.`,
      shape: { path: P, offset: z.number().int().min(1).optional().describe('First line to return, 1-based'), limit: z.number().int().min(1).optional().describe('How many lines to return') },
      run: (a) => local(() => readFileLocal(checkout, a)),
    },
    {
      name: 'glob', write: false, uiName: 'Glob', uiInput: (a) => ({ pattern: a.pattern, ...(a.path ? { path: a.path } : {}) }),
      description: `List files in the local checkout by glob pattern, e.g. "**/*.ts", "src/**/*.test.js", "*.md" (a pattern without "/" matches at any depth). Returns up to ${LIMITS.globMax} paths.`,
      shape: { pattern: z.string(), path: z.string().optional().describe('Directory to search in, relative to the repo root. Default: the whole repo') },
      run: (a) => local(() => globLocal(checkout, a)),
    },
    {
      name: 'grep', write: false, uiName: 'Grep', uiInput: (a) => ({ pattern: a.pattern, ...(a.glob ? { glob: a.glob } : {}), ...(a.path ? { path: a.path } : {}) }),
      description: `Search file contents in the local checkout with a JavaScript regular expression. Returns "path:line: text" lines (up to ${LIMITS.grepDefault} matches by default, ${LIMITS.grepMax} max). Searches the whole repo at once unless you narrow it with path or glob.`,
      shape: {
        pattern: z.string().describe('Regular expression, e.g. "TODO|FIXME" or "function\\\\s+login"'),
        path: z.string().optional().describe('File or directory to search, relative to the repo root'),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.py"'),
        ignore_case: z.boolean().optional(), context: z.number().int().min(0).max(5).optional().describe('Lines of context around each match'),
        max_results: z.number().int().min(1).max(LIMITS.grepMax).optional(), files_only: z.boolean().optional().describe('Return only the paths of files that match'),
      },
      run: (a, opts) => local(() => grepLocal(checkout, a, opts)),
    },
  ];

  return all.map((t) => {
    const zod = z.object(t.shape);
    return {
      ...t, schema: jsonSchema(t.shape), untrusted: UNTRUSTED.has(t.name),
      /** Validate model-supplied arguments. Returns { ok, args } or { ok: false, error }. */
      parse(raw) {
        let r = zod.safeParse(raw);
        if (!r.success) r = zod.safeParse(stripNulls(raw)); // weaker models send null for omitted optionals
        if (r.success) return { ok: true, args: r.data };
        const why = r.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ');
        return { ok: false, error: `Invalid arguments for ${t.name}: ${why}. Send a JSON object that matches the tool's schema.` };
      },
    };
  });
}
