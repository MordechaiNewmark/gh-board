// A small delivery-loop world for the mock GitHub: one repo mid-flight, with a task in every loop state, the
// PRs that carry them, reviewer comments, check runs and patch history. Used by the loop tests and by the UI
// screenshots. Nothing here is real; attachment URLs point at hosts the tests never contact.
const HOUR = 3600e3;
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();
const L = (name, color = 'ededed') => ({ name, color });
const COLORS = { task: '1D76DB', epic: '3E4B9E', 'status:blocked': 'D93F0B', 'status:ready': '0E8A16', 'status:claimed': 'FBCA04', 'status:in-review': 'C5DEF5', 'status:changes-requested': 'E99695', 'status:approved': '2EA44F', 'needs-human': 'B60205', 'claim:agent': 'BFD4F2', 'agent-authored': 'EDEDED', 'size:S': 'C2E0C6', 'size:M': 'FEF2C0', 'size:L': 'F9D0C4', bug: 'd73a4a', enhancement: 'a2eeef' };
const labels = (...names) => names.map((n) => L(n, COLORS[n] || (n.startsWith('module:') ? '5319E7' : 'ededed')));

const task = (ctx, criteria, tail = '') => `## Context\n${ctx}\n\n## Acceptance criteria\n${criteria.map((c) => `- [ ] ${c}`).join('\n')}\n\n## Files\n- \`src/export/csv.ts\`\n\n## Out of scope\nXLSX export.${tail ? `\n\n${tail}` : ''}`;
const SHA = { 21: 'a1'.repeat(20), 22: 'b2'.repeat(20), 23: 'c3'.repeat(20), 24: 'd4'.repeat(20) };
export const SHOT = 'https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555';
export const CLIP = 'https://github.com/user-attachments/assets/66666666-7777-8888-9999-000000000000';

export const CONF = `# delivery-loop per-repo config.
BASE_BRANCH=main
WORKTREE_SETUP_CMD="npm ci"
GATE_CMD="bash scripts/check.sh"
SPEC_SOURCES="docs/*_spec.md"
STYLEGUIDES_DIR="styleguides/"
MODULES="api web reports"
REREVIEW_SCOPE="narrow"
AGENT_RULES_FILE=""
`;
export const CHECK = `#!/usr/bin/env bash
# check.sh - THE verification gate for this repo.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo '==> lint'; npm run lint
echo '==> typecheck'; npm run typecheck
echo '==> test'; npm run test
echo "==> gate passed"
`;
export const EMPTY_CHECK = `#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# init detected no linters, type-checkers, or test frameworks in this repo.
echo "check.sh: no checks defined yet — edit scripts/check.sh (see /delivery-loop:init)." >&2
exit 1
`;

/** Fresh mutable state for one repo. */
export function loopWorld({ gate = true, conf = true } = {}) {
  const issue = (number, title, labelNames, body, o = {}) => ({
    number, id: 1000 + number, node_id: `I_${number}`, title, state: o.closed ? 'closed' : 'open', body, labels: labels(...labelNames),
    assignees: (o.assignees || []).map((login) => ({ login })), html_url: `https://github.com/acme/timesheet/issues/${number}`, comments: o.comments || 0,
    created_at: ago(200 - number), updated_at: ago(o.idle ?? 1), milestone: null,
  });
  const issues = [
    issue(1, 'Epic: Timesheet export', ['epic'], '## Goal\nPeople can export a month of timesheets.\n\n## Tasks\n- [ ] #3 Scaffold the export module\n- [ ] #4 Add the CSV export endpoint\n- [ ] #5 Export button on the timesheet page\n- [ ] #6 Monthly summary totals\n- [ ] #10 Stream large exports\n- [ ] #11 Export audit log'),
    issue(2, 'Epic: Approvals workflow', ['epic'], '## Goal\nManagers approve a week of entries.\n\n## Tasks\n- [ ] #7 Add approval states to the entry model\n- [ ] #8 Document the approval states\n- [ ] #12 Timezone handling in the week view'),
    issue(3, 'Scaffold the export module', ['task', 'module:api', 'size:S', 'agent-authored'], task('Spec: docs/export_spec.md §1.', ['`bash scripts/check.sh` passes', '`test -f src/export/index.ts`'], 'Part of epic #1'), { closed: true, idle: 30 }),
    issue(4, 'Add the CSV export endpoint', ['task', 'module:api', 'size:M', 'status:approved', 'claim:agent', 'agent-authored'], task('Spec: docs/export_spec.md §2. Builds on `src/export/index.ts:12`.', ['`bash scripts/check.sh` passes', '`npm test -- export/csv` passes', '`test -f src/export/csv.ts`'], 'Depends-on: #3\nPart of epic #1'), { assignees: ['alice'], idle: 2, comments: 3 }),
    issue(5, 'Export button on the timesheet page', ['task', 'module:web', 'size:S', 'status:in-review', 'claim:agent', 'agent-authored'], task('Spec: docs/export_spec.md §3.', ['`bash scripts/check.sh` passes', '`npm test -- web/export-button` passes'], 'Depends-on: #3\nPart of epic #1'), { assignees: ['alice'], idle: 0.4 }),
    issue(6, 'Monthly summary totals', ['task', 'module:reports', 'size:M', 'status:changes-requested', 'claim:agent', 'agent-authored', 'bug'], task('Spec: docs/export_spec.md §4.', ['`bash scripts/check.sh` passes', '`npm test -- reports/summary` passes', '`node scripts/verify-totals.mjs fixtures/march.json` exits 0'], 'Depends-on: #3\nPart of epic #1'), { assignees: ['alice'], idle: 0.2, comments: 5 }),
    issue(7, 'Add approval states to the entry model', ['task', 'module:infra', 'size:S', 'status:claimed', 'claim:agent', 'agent-authored'], task('Spec: docs/approvals_spec.md §1.', ['`bash scripts/check.sh` passes', '`npm test -- model/entry` passes'], 'Part of epic #2'), { assignees: ['alice'], idle: 0.3, comments: 1 }),
    issue(8, 'Document the approval states', ['task', 'module:docs', 'size:S', 'status:ready', 'agent-authored'], task('Spec: docs/approvals_spec.md §1.', ['`bash scripts/check.sh` passes', '`test -f docs/approvals.md`'], 'Part of epic #2'), { idle: 20 }),
    issue(9, 'Keyboard shortcuts for the week view', ['task', 'module:web', 'size:M', 'status:ready', 'agent-authored', 'enhancement'], '## Context\nUsers asked for it.\n\n## Acceptance criteria\n- [ ] Shortcuts work correctly\n- [ ] `bash scripts/check.sh` passes', { idle: 26 }),
    issue(10, 'Stream large exports', ['task', 'module:api', 'size:M', 'status:blocked', 'agent-authored'], task('Spec: docs/export_spec.md §5.', ['`bash scripts/check.sh` passes', '`npm test -- export/stream` passes'], 'Depends-on: #4 #6\nPart of epic #1'), { idle: 40 }),
    issue(11, 'Export audit log', ['task', 'module:api', 'size:S', 'status:blocked', 'agent-authored'], task('Spec: docs/export_spec.md §6.', ['`bash scripts/check.sh` passes', '`npm test -- export/audit` passes'], 'Depends-on: #10\nPart of epic #1'), { idle: 40 }),
    issue(12, 'Timezone handling in the week view', ['task', 'module:web', 'size:M', 'status:changes-requested', 'needs-human', 'claim:agent', 'agent-authored'], task('Spec: docs/approvals_spec.md §3.', ['`bash scripts/check.sh` passes', '`npm test -- web/week-tz` passes'], 'Part of epic #2'), { assignees: ['alice'], idle: 5, comments: 8 }),
    issue(13, 'Rate-limit the export endpoint', ['task', 'module:reports', 'size:S', 'status:claimed', 'claim:agent', 'agent-authored'], task('Spec: docs/export_spec.md §7.', ['`bash scripts/check.sh` passes', '`npm test -- export/rate-limit` passes'], 'Part of epic #1'), { assignees: ['alice'], idle: 6.5 }),
    issue(14, 'Idea: bulk edit of entries', ['enhancement'], 'Would be nice to edit many entries at once.', { idle: 60 }),
    issue(15, 'Import from the old spreadsheet', ['task', 'module:billing', 'status:ready'], 'Bring the 2023 sheet in.\n\nDepends-on: #999', { idle: 70 }),
    issue(16, 'Set up the delivery loop', ['task', 'module:infra', 'size:S', 'agent-authored'], task('Bootstrap.', ['`bash scripts/check.sh` passes']), { closed: true, idle: 90 }),
    issue(17, 'Add lint and typecheck to the gate', ['task', 'module:infra', 'size:S', 'agent-authored'], task('Gate.', ['`bash scripts/check.sh` passes']), { closed: true, idle: 80 }),
  ];
  const pull = (number, title, n, labelNames, o = {}) => ({
    number, id: 2000 + number, title, state: 'open', draft: false, merged: false, mergeable: o.mergeable ?? true, mergeable_state: o.mergeable_state || 'clean',
    body: `Closes #${n}\n\n## Summary\n${o.summary || 'Implements the task.'}\n\n## Acceptance criteria\n${o.claims || '- [x] `bash scripts/check.sh` passes'}\n\nAgent-authored (model: claude-sonnet-5-5)`,
    html_url: `https://github.com/acme/timesheet/pull/${number}`, user: { login: 'alice' }, labels: labels(...labelNames),
    head: { ref: `task/${n}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`, sha: SHA[number] }, base: { ref: 'main' },
    additions: o.add ?? 120, deletions: o.del ?? 14, changed_files: o.files ?? 4, updated_at: ago(o.idle ?? 1),
  });
  const pulls = [
    pull(21, 'Add the CSV export endpoint (#4)', 4, ['agent-authored'], { add: 212, del: 9, files: 5, idle: 2, summary: 'Adds `GET /api/export.csv` with streaming rows and RFC 4180 quoting.', claims: '- [x] `bash scripts/check.sh` passes\n- [x] `npm test -- export/csv` passes (14 tests)\n- [x] `test -f src/export/csv.ts`' }),
    pull(22, 'Export button on the timesheet page (#5)', 5, ['agent-authored'], { add: 64, del: 3, files: 3, idle: 0.4 }),
    pull(23, 'Monthly summary totals (#6)', 6, ['agent-authored'], { add: 148, del: 31, files: 6, idle: 0.2 }),
    pull(24, 'Timezone handling in the week view (#12)', 12, ['agent-authored', 'needs-human'], { add: 310, del: 122, files: 9, idle: 5, mergeable: false, mergeable_state: 'dirty' }),
  ];
  const c = (login, body, h) => ({ user: { login }, body, created_at: ago(h) });
  const comments = {
    21: [c('alice', 'Patch iteration: 1/3\nQuoted fields that contain a newline; added a regression test.', 3)],
    22: [],
    23: [c('alice', 'Patch iteration: 1/3\nFixed rounding in the weekly subtotal.', 9), c('alice', 'Patch iteration: 2/3\nUse integer cents end to end; totals still off for March, investigating fixture.', 1)],
    24: [c('alice', 'Patch iteration: 1/3', 30), c('alice', 'Patch iteration: 2/3', 20), c('alice', 'Patch iteration: 3/3\nDST boundary still fails for Europe/Lisbon.', 8), c('alice', 'Escalating: three rounds did not converge. The spec does not say which timezone a week belongs to when it spans a DST change.', 5)],
    4: [], 6: [], 12: [],
  };
  const r = (id, state, body, h, commit) => ({ id, user: { login: 'alice' }, state, body, submitted_at: ago(h), commit_id: commit });
  const reviews = {
    21: [
      r(1, 'COMMENTED', `Changes requested.\n\n- FAIL \`npm test -- export/csv\` - 1 of 14 failing: quoted newline\n- PASS \`bash scripts/check.sh\`\n- PASS \`test -f src/export/csv.ts\``, 4, 'ee'.repeat(20)),
      r(2, 'COMMENTED', `Approved: every criterion passes in a clean checkout.\n\n- PASS \`bash scripts/check.sh\` - gate passed (lint, typecheck, 212 tests)\n- PASS \`npm test -- export/csv\` - 14 passed\n- PASS \`test -f src/export/csv.ts\` (carried forward from ${'ee'.repeat(4)})\n\nEvidence: export of the March fixture opened in a spreadsheet.\n\n![March export](${SHOT})\n\n${CLIP}\n\nNote: \`csv.ts\` duplicates the date formatter from \`src/format.ts\`; not a criterion, left as a comment.`, 2, SHA[21]),
    ],
    22: [],
    23: [r(3, 'COMMENTED', `Changes requested.\n\n- PASS \`bash scripts/check.sh\` - gate passed\n- PASS \`npm test -- reports/summary\` - 9 passed\n- FAIL \`node scripts/verify-totals.mjs fixtures/march.json\` - exit 1: expected 16840.50, got 16840.49\n\n## Findings\n- The monthly total is summed from rounded weekly subtotals; sum the entries instead (\`src/reports/summary.ts:41\`).\n- No test covers a month whose weeks straddle two months.`, 0.5, SHA[23])],
    24: [r(4, 'COMMENTED', `Changes requested.\n\n- PASS \`bash scripts/check.sh\`\n- FAIL \`npm test -- web/week-tz\` - Europe/Lisbon DST week renders 6 days`, 9, SHA[24])],
  };
  const run = (name, conclusion, status = 'completed') => ({ name, status, conclusion, html_url: 'https://github.com/acme/timesheet/actions/runs/1' });
  const checks = {
    [SHA[21]]: [run('gate', 'success'), run('build', 'success')],
    [SHA[22]]: [run('gate', null, 'in_progress')],
    [SHA[23]]: [run('gate', 'failure'), run('build', 'success')],
    [SHA[24]]: [run('gate', 'failure')],
  };
  const f = (filename, additions, deletions, status = 'modified') => ({ filename, additions, deletions, status });
  const files = {
    21: [f('src/export/csv.ts', 148, 0, 'added'), f('src/export/index.ts', 12, 4), f('src/routes.ts', 6, 1), f('test/export/csv.test.ts', 44, 0, 'added'), f('docs/export_spec.md', 2, 4)],
    22: [f('web/src/Timesheet.tsx', 31, 3), f('web/src/ExportButton.tsx', 22, 0, 'added'), f('web/test/export-button.test.tsx', 11, 0, 'added')],
    23: [f('src/reports/summary.ts', 96, 31), f('test/reports/summary.test.ts', 52, 0, 'added')],
    24: [f('web/src/WeekView.tsx', 210, 100), f('web/src/tz.ts', 100, 22)],
  };
  const contents = {
    ...(conf ? { '.claude/delivery.conf': CONF } : {}),
    ...(conf ? { 'scripts/check.sh': gate ? CHECK : EMPTY_CHECK } : {}),
    'styleguides/': ['README.md', 'typescript.md', 'api.md'], 'docs/': ['export_spec.md', 'approvals_spec.md', 'notes.md'],
    '.github/workflows/': ['gate.yml'], 'CLAUDE.md': '# Rules\nRun the gate before every commit.\n',
  };
  return { issues, pulls, comments, reviews, checks, files, contents, next: 30 };
}
