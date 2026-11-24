// The delivery-loop plugin's per-repo adapter (.claude/delivery.conf), read WITHOUT executing it, plus the
// "is this repo ready for the loop" checks built on it: is there a gate, are there styleguides, specs, rules.
// The plugin sources the file with bash; here it is parsed as plain KEY=value text so nothing in an untrusted
// repo ever runs in this process.

export const CONF_PATH = '.claude/delivery.conf';
export const DEFAULTS = {
  BASE_BRANCH: 'main', WORKTREE_SETUP_CMD: '', GATE_CMD: 'bash scripts/check.sh', SPEC_SOURCES: 'docs/*_spec.md',
  STYLEGUIDES_DIR: 'styleguides/', MODULES: '', NOTIFY_APPROVE_CMD: '', NOTIFY_ESCALATE_CMD: '',
  MODEL_IMPLEMENT_S: '', MODEL_IMPLEMENT_M: '', MODEL_IMPLEMENT_L: '', MODEL_REVIEW: '', MODEL_REREVIEW: '', MODEL_PATCH: '',
  REREVIEW_SCOPE: 'narrow', AGENT_RULES_FILE: '',
};
export const BUILTIN_MODULES = ['infra', 'docs'];

/** Parse delivery.conf text. Returns { values (defaults applied), set (keys the file assigns) }. No expansion, no execution. */
export function parseConf(text) {
  const values = { ...DEFAULTS };
  const set = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw);
    if (!m || !(m[1] in DEFAULTS)) continue;
    let v = m[2].trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else v = v.replace(/\s+#.*$/, '').trim();
    values[m[1]] = v;
    set.add(m[1]);
  }
  if (!['narrow', 'full'].includes(values.REREVIEW_SCOPE)) values.REREVIEW_SCOPE = 'full';
  return { values, set };
}

export const modulesOf = (conf) => String(conf?.MODULES || '').split(/\s+/).filter(Boolean);

/** The script file a gate command runs, when it is of the form `bash path.sh` / `sh path.sh` / `./path.sh`. */
export function gateScript(cmd) {
  const m = /^\s*(?:(?:bash|sh)\s+)?(\.?\/?[\w./-]+\.sh)\b/.exec(String(cmd || ''));
  return m ? m[1].replace(/^\.\//, '') : null;
}

const SEEDED_EMPTY = /no checks defined yet/;
/** Lines of a gate script that actually check something (not comments, blank lines, shell options or a bare cd/echo). */
export const gateSteps = (text) => String(text || '').split(/\r?\n/)
  .map((l) => l.trim().replace(/^(?:echo\s+(?:'[^']*'|"[^"]*"|[^;&|]*)\s*;\s*)+/, '')) // "echo '==> lint'; npm run lint" is a step
  .filter((l) => l && !l.startsWith('#') && !/^(set\s+-|cd\s|echo\s|exit\s+0\b|true$|:$)/.test(l));

/**
 * Is there a gate the loop can run? reader: { read(path) -> string|null }.
 * A missing conf, an empty GATE_CMD, a missing/empty gate script, or the seeded "no checks defined yet" guard all mean NO gate.
 */
export async function gateStatus(reader, parsed) {
  const conf = parsed ?? parseConf(await reader.read(CONF_PATH));
  const cmd = conf.values.GATE_CMD.trim();
  if (!cmd) return { ok: false, cmd: '', script: null, reason: 'GATE_CMD is empty in .claude/delivery.conf.' };
  const script = gateScript(cmd);
  if (!script) return { ok: true, cmd, script: null, verified: false, text: '', reason: '' };
  const text = await reader.read(script);
  if (text === null) return { ok: false, cmd, script, reason: `The gate script ${script} does not exist.` };
  if (SEEDED_EMPTY.test(text) && /^\s*exit\s+1\b/m.test(text)) return { ok: false, cmd, script, reason: `${script} is the seeded placeholder: no checks are defined yet.` };
  if (!gateSteps(text).length) return { ok: false, cmd, script, reason: `${script} is empty: it checks nothing.` };
  return { ok: true, cmd, script, verified: true, text, reason: '' };
}

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
/** Files matched by SPEC_SOURCES (space-separated globs; wildcards in the last segment only, which is how the plugin uses it). */
async function specFiles(reader, patterns) {
  const out = [];
  for (const p of String(patterns || '').split(/\s+/).filter(Boolean)) {
    const i = p.lastIndexOf('/');
    const dir = i >= 0 ? p.slice(0, i) : '';
    const re = globRe(i >= 0 ? p.slice(i + 1) : p);
    for (const name of (await reader.list(dir)) || []) if (re.test(name)) out.push(dir ? `${dir}/${name}` : name);
  }
  return [...new Set(out)];
}

const LINT_RE = /\b(eslint|biome|ruff|flake8|pylint|clippy|golangci-lint|go vet|rubocop|shellcheck|stylelint|ktlint|lint)\b/i;
const TYPES_RE = /\b(tsc|typecheck|type-check|mypy|pyright|go build|cargo (?:build|check)|flow check|bash -n)\b/i;
const TESTS_RE = /\b(pytest|vitest|jest|mocha|go test|cargo test|rspec|phpunit|playwright|node --test|npm (?:run )?test|pnpm (?:run )?test|yarn test|tests?\b)/i;
const EVIDENCE_RE = /\b(playwright|puppeteer|cypress|screenshot|video|storybook|hypothesis|fast-check|proptest|quickcheck|property[- ]based|state ?chart|xstate|tla\+?|e2e)\b/i;

const ask = (text) => ({ kind: 'planner', label: 'Ask the planner to file an issue', prompt: text });
const SETUP = { kind: 'setup', label: 'Run setup' };

/**
 * The light "trust pyramid" view of a repo: what exists at each layer, and what to do about each gap.
 * reader: { read(path) -> string|null, list(dir) -> string[]|null }. No scoring beyond ok / partial / missing.
 */
export async function readiness(reader) {
  const confText = await reader.read(CONF_PATH);
  const parsed = parseConf(confText);
  const conf = parsed.values;
  const initialized = confText !== null;
  const gate = initialized ? await gateStatus(reader, parsed) : { ok: false, cmd: '', script: null, reason: 'This repo has no .claude/delivery.conf yet: the loop is not set up.' };
  const gateText = `${gate.cmd || ''}\n${gate.text || ''}`;
  const checks = { lint: gate.ok && LINT_RE.test(gateText), types: gate.ok && TYPES_RE.test(gateText), tests: gate.ok && TESTS_RE.test(gateText) };

  const sgDir = conf.STYLEGUIDES_DIR.replace(/\/+$/, '');
  const sgList = await reader.list(sgDir);
  const guides = (sgList || []).filter((n) => /\.(md|mdx|txt)$/i.test(n) && !/^readme\./i.test(n));
  const specs = await specFiles(reader, conf.SPEC_SOURCES);
  const rulesFile = conf.AGENT_RULES_FILE;
  const rulesText = rulesFile ? await reader.read(rulesFile) : null;
  const [claudeMd, agentsMd] = await Promise.all([reader.read('CLAUDE.md'), reader.read('AGENTS.md')]);
  const ci = ((await reader.list('.github/workflows')) || []).filter((n) => /\.ya?ml$/i.test(n));
  const modules = modulesOf(conf);
  const evidence = EVIDENCE_RE.test(`${gateText}\n${rulesText || ''}`);
  const prose = [rulesText !== null && rulesFile, claudeMd !== null && 'CLAUDE.md', agentsMd !== null && 'AGENTS.md'].filter(Boolean);

  const layers = [
    {
      id: 'design', title: 'Codebase design', hint: 'Architecture, APIs and banned patterns the agents build against. The strongest layer.',
      items: [
        { label: 'Styleguides', ok: guides.length > 0, detail: guides.length ? `${guides.length} guide${guides.length === 1 ? '' : 's'} in ${sgDir}/` : sgList ? `${sgDir}/ holds only the stub` : `${sgDir}/ does not exist`,
          action: guides.length ? null : ask(`Plan a task to author this repo's styleguides in ${sgDir}/ (the conventions implementers follow and reviewers enforce). Ground it in the code that exists and give it executable acceptance criteria.`) },
        { label: 'Specs', ok: specs.length > 0, detail: specs.length ? specs.slice(0, 4).join(', ') + (specs.length > 4 ? ` +${specs.length - 4}` : '') : `nothing matches ${conf.SPEC_SOURCES}`,
          action: specs.length ? null : ask(`Help me write the first spec for this repo as an issue: ask me what to build, then draft a decompose-ready spec (it will live at ${conf.SPEC_SOURCES}).`) },
        { label: 'Modules', ok: modules.length > 0, detail: modules.length ? modules.join(', ') : 'MODULES is empty: tasks cannot be parallelised safely',
          action: modules.length ? null : ask('Propose a MODULES list for .claude/delivery.conf from the code layout (the module is the concurrency unit: one in-flight task per module), and file an infra task to set it and create the module: labels.') },
      ],
    },
    {
      id: 'checks', title: 'Lint, types and tests', hint: 'The gate: one command whose errors tell an agent how to fix what it broke.',
      items: [
        { label: 'Gate', ok: gate.ok, detail: gate.ok ? gate.cmd : gate.reason, action: gate.ok ? null : SETUP },
        { label: 'Lint in the gate', ok: checks.lint, detail: checks.lint ? 'found' : 'no linter found in the gate', action: checks.lint || !gate.ok ? null : ask('File an infra task to add a linter to the gate (scripts/check.sh), with the acceptance criterion that the gate runs it and passes.') },
        { label: 'Types in the gate', ok: checks.types, detail: checks.types ? 'found' : 'no type check found in the gate', action: checks.types || !gate.ok ? null : ask('File an infra task to add a type check (or build) to the gate, with the acceptance criterion that the gate runs it and passes.') },
        { label: 'Tests in the gate', ok: checks.tests, detail: checks.tests ? 'found' : 'no test run found in the gate', action: checks.tests || !gate.ok ? null : ask('File an infra task to run the test suite from the gate, with the acceptance criterion that the gate runs it and passes.') },
      ],
    },
    {
      id: 'verification', title: 'Verification evidence', hint: 'Runtime proof a human can review instead of a diff: screenshots, video, property tests, CI runs.',
      items: [
        { label: 'CI runs the gate', ok: ci.length > 0, detail: ci.length ? ci.slice(0, 3).join(', ') : 'no workflow in .github/workflows', action: ci.length ? null : ask('File an infra task to add a CI workflow that runs the gate on every pull request, so merges wait on it.') },
        { label: 'Evidence tooling', ok: evidence, detail: evidence ? 'the gate or the agent rules mention runtime evidence' : 'no browser, property-test or screenshot tooling found', action: evidence ? null : ask('Plan how this repo should produce review evidence (screenshots or video of the real app, property tests) and file the tasks to add it to the gate.') },
      ],
    },
    {
      id: 'prose', title: 'Prose rules', hint: 'AGENTS.md, CLAUDE.md, the agent rules file. The weakest layer: prefer a check over another rule.',
      items: [
        { label: 'Agent rules', ok: prose.length > 0, detail: prose.length ? prose.join(', ') : 'no CLAUDE.md, AGENTS.md or AGENT_RULES_FILE', action: prose.length ? null : ask('File a docs task to add a short agent rules file (and set AGENT_RULES_FILE) covering only what a check cannot enforce.') },
      ],
    },
  ].map((l) => {
    const okN = l.items.filter((i) => i.ok).length;
    return { ...l, status: okN === l.items.length ? 'ok' : okN === 0 ? 'missing' : 'partial' };
  });

  return {
    initialized, gate: { ok: gate.ok, cmd: gate.cmd, script: gate.script, reason: gate.reason, verified: gate.verified ?? false },
    conf: { BASE_BRANCH: conf.BASE_BRANCH, GATE_CMD: conf.GATE_CMD, WORKTREE_SETUP_CMD: conf.WORKTREE_SETUP_CMD, SPEC_SOURCES: conf.SPEC_SOURCES, STYLEGUIDES_DIR: conf.STYLEGUIDES_DIR, MODULES: conf.MODULES, REREVIEW_SCOPE: conf.REREVIEW_SCOPE, AGENT_RULES_FILE: conf.AGENT_RULES_FILE },
    modules, layers,
  };
}
