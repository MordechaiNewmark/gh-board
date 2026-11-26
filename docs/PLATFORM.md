# gh-board as the front end of an autonomous dev platform

Status: slice 1 is built (planner chat, runner, loop board, inbox with evidence-first review, readiness and
model-policy panels). Phases 2 to 5 are design only. Nothing in this document has been validated by a real
end-to-end loop run from gh-board yet; see "What is not verified".

## 1. The idea

**Issues are the product.** You think, plan and design in the chat and on the board. The only thing that comes out
of the chat is GitHub issues: epics, tasks, specs. Agents then do the development work on their own, running the
delivery loop, and you supervise: you read evidence, merge, and answer escalations. The chat never edits code.

Three parts, each with one job:

| Part | Job | Where state lives |
| --- | --- | --- |
| **gh-board** (this repo) | Control plane and front end: plan issues, start and stop the loop, show its state, review evidence, merge | A few local files (below). No database |
| **delivery-loop plugin** (the engine) | Claim, implement, review, patch, merge. Skills and shell scripts for Claude Code | Nothing of its own |
| **GitHub** | The source of truth: issues, labels, comments, pull requests, checks | Everything that matters |

gh-board **drives** the plugin: a tick is one non-interactive Claude Code session that runs the plugin's own
`/delivery-loop:delivery-tick`. gh-board does not reimplement claiming, implementing, reviewing or patching, and it
does not write to the plugin repo. If gh-board is deleted, the loop still works from a terminal; if the plugin
changes its behaviour, gh-board shows whatever the labels say.

```
 you ── chat (planner) ──> issues ─────────────┐
  │                                            v
  │   Run panel ──> runner ──> claude -p "/delivery-loop:delivery-tick"   (workspace clone, git worktrees)
  │                               │   orchestrator -> implementer / reviewer / patcher agents
  │                               v
  └── Loop board, Inbox <── GitHub: issues, labels, PRs, reviews, checks ──> human merge (Inbox)
```

## 2. Data model

### GitHub (source of truth)

gh-board reads the plugin's real conventions and never invents parallel ones:

- **Labels** (created by `/delivery-loop:init`): `task`, `epic`; `status:blocked | ready | claimed | in-review |
  changes-requested | approved`; `needs-human`; `claim:agent`; `agent-authored` / `human-authored`;
  `size:S | M | L`; `module:<name>` (plus the built-in `infra`, `docs`).
- **Issue body**: `## Context`, `## Acceptance criteria` (a checklist where every line is a command or a checkable
  artifact), a `Depends-on: #N #M` line, `Part of epic #E`. Epics list their children as `- [ ] #N`.
- **Claim lock**: `CLAIM` / `CLAIM-WITHDRAWN` / `RECLAIMED` comments (the plugin's Lamport lock). gh-board only shows
  the result (assignee, `claim:agent`, idle time).
- **Pull requests**: `Closes #N`, label `agent-authored`, the reviewer's per-criterion review (formal, or
  comment-form on a single account), `Patch iteration: n/3` comments, check runs.
- **Per-repo config**: `.claude/delivery.conf` (`GATE_CMD`, `BASE_BRANCH`, `WORKTREE_SETUP_CMD`, `SPEC_SOURCES`,
  `STYLEGUIDES_DIR`, `MODULES`, `MODEL_*`, `REREVIEW_SCOPE`, `AGENT_RULES_FILE`, notify hooks). gh-board parses it as
  text and never executes it.

Loop state shown on the board is derived from labels with the plugin's precedence: closed -> Done; `needs-human` ->
Needs human; else the `status:*` label; with no status label it is derived the way `task-queue.sh` derives
readiness. Labels are the plugin's cache of the truth, so gh-board treats them as authoritative for display and
never "repairs" them: reconciling is the job of `task-queue.sh --fix`, which every tick runs.

### Local files (all git-ignored, all disposable)

| File | Content | If lost |
| --- | --- | --- |
| `.workspaces/<owner>/<name>/` | Working clone the agents use; task worktrees under `.worktrees/` | Re-cloned on next run; unpushed agent work in worktrees is lost |
| `.runs/<owner>__<name>/<ts>.jsonl` | One scrubbed event log per tick | History of what agents did is lost; nothing else |
| `.runner.json` | Per repo: autonomy, parallelism, counters, ticks and cost per day | Autonomy falls back to Supervised; counters reset |
| `.gh-accounts.json`, `.claude-auth.json`, `.providers.json` | Credentials (already existed) | Reconnect |
| `.repo-cache/` | Read-only shallow checkout for the planner chat (already existed) | Re-fetched |

Nothing local is a source of truth for the backlog. That is deliberate: two machines, or gh-board and a terminal,
can drive the same repo without syncing anything.

## 3. The four principles, mapped to features

The principles come from the user's "Coding with agents" board (after a Code Summit talk by Lauren Tan; the
numbers quoted there are self-reported and are not relied on here).

| Principle | Slice 1 (built) | Later |
| --- | --- | --- |
| **1. Trust pyramid**: codebase design > lint/types/tests > verification > prose rules | Repo tab: a pyramid of the four layers read from the repo (styleguides, specs, modules; gate with lint/types/tests; CI and evidence tooling; rules files), with an action per gap. Runs refuse to start without a non-empty gate. The planner is told to put design guidance in Context and checks in the gate | Phase 3 evidence standards make the verification layer concrete |
| **2. Correct once, enforce forever** | The planner prompt and the request-changes dialog both push a repeated correction toward a gate task. Human review comments carry a marker (`<!-- gh-board:human-review -->`) so they can be mined later | Phase 2: corrections ledger and automatic "write a check" tasks |
| **3. Review evidence, not diffs** | Inbox review screen: per-criterion results from the reviewer, gate and CI, attached screenshots/video/artifacts, findings and patch history; changed files last, diff collapsed | Phase 3: evidence required per repo type; auto-merge gated on it |
| **4. Outer loop on every release** | Continuous runs with idle backoff, counters (ticks, PRs, merges, escalations), daily caps | Phase 4: release fuzz agent, fix PRs, metrics and budgets |

## 4. Slice 1 in detail

### A. Planner chat

- Planner mode is the default for every provider (Claude, OpenAI, Gemini, OpenAI-compatible). `CHAT_MODE=classic`
  restores the old board-manager chat.
- The system prompt (`loop/planner-prompt.mjs`) makes the assistant ask clarifying questions, read the repo, propose
  an outline, then call `create_issues` once so there is one approval card. It carries the repo's gate, modules,
  base branch and spec locations from `delivery.conf`.
- `commit_file` is not offered at all. `attach_to_issue` only adds small text files as comments. There is no tool
  that writes to the repository's git content.
- `create_issues` in planner mode builds a backlog the loop can run: drafts name each other with `key` /
  `depends_on`; the server creates them parents-first and dependencies-first, writes `Depends-on: #N` and
  `Part of epic #E` with real numbers, lists the tasks in the epic, sets `status:ready` or `status:blocked`, and
  returns a readiness report so the model fixes gaps.
- **Ready for the loop** (`loop/lint.mjs`): acceptance-criteria checklist present and made of commands, exactly one
  size (S or M), exactly one module (and in `MODULES` when that is set), a status label, `Depends-on` references
  that exist. It flags; it never blocks creation. Shown on board cards and on the chat's preview card;
  `check_issues` lets the chat audit existing issues.
- Specs are authored as issues, or by the plugin's `author-spec` skill in a terminal. (Running `author-spec` and
  `decompose` from the Run panel is a small follow-up: both are interactive by design, so they need the approval
  step wired through the UI first.)

### B. Runner

See "Safety model" for the permission and credential details.

- Per repo: Start (one tick, or continuous), Pause, Stop; Setup runs `/delivery-loop:init`.
- Autonomy dial: Supervised (default; `/delivery-loop:delivery-tick`), Parallel supervised (`--parallel N`),
  Auto-merge (`--parallel N --auto-merge`). Raising it needs a confirmation; Auto-merge also needs a gate that
  exists and checks something, and the typed acknowledgement `auto-merge`.
- Refusals: `READ_ONLY=1`; no confirmation; plugin missing or not from the expected fork (gh-board prints the
  install commands and never runs them); no `.claude/delivery.conf`; gate missing, empty or still the seeded
  placeholder; a run already active for the repo; `RUNNER_MAX_REPOS` reached; daily tick cap reached.
- Continuous mode never loops on a failing tick: the first failure stops the run. Ticks that dispatch nothing double
  the wait, up to `RUNNER_IDLE_MAX_S`, so an idle loop does not burn sessions.

### C. Board = live loop

Toggle between **Loop** (the plugin's states; the loop moves the cards) and **Classic** (`status:<Column>`; you move
the cards). Loop cards show size, module, epic, who claimed it and how long it has been idle, the PR with its CI
state and patch round, what a blocked task waits for, and the readiness badge. Epics appear as progress chips;
issues without the `task` label are counted as "not in the loop". The board refreshes every 6 seconds while a run
is active.

### D. Inbox and review

Items, most urgent first: escalations (`needs-human`), approved PRs waiting for your merge, agent PRs with failing
checks, stale claims. Actions on a PR, each behind a confirmation dialog and blocked by `READ_ONLY=1`:

- **Approve & merge**: squash, with the token of the account that owns the repo, only the exact commit that was
  shown (GitHub refuses if the branch moved). Blockers (closed, draft, conflicting, red check) disable the button;
  cautions (not approved, pending checks, failing criteria) turn it into "Merge anyway".
- **Request changes**: posts your text as a review (comment-form when GitHub refuses a formal one on your own PR,
  as the reviewer skill does) and relabels the task `status:changes-requested`. For an escalated PR you can restart
  the patch budget (a `Patch iteration: 0/3` comment) and clear `needs-human`.
- **Close**: closes the PR and parks the task as `needs-human` with a comment, so no agent re-claims it.

### E. Readiness and model policy (Repo tab)

Trust pyramid as above, plus the Model policy panel (section 6) and a Runner checklist (plugin, Claude Code,
token type, gate, workspace) with the full list of what a session may do.

## 5. Safety model

**Stance.** Issue bodies, PR text, comments and repository files are untrusted input to the agents. gh-board does
not try to make a prompt-injected agent harmless by filtering text. It limits what an agent can reach, and keeps
two controls outside the agents: **the gate** and **the human merge**.

### What a session is given

Exact launch (from `runner/command.mjs`, verified against Claude Code 2.1.331 `--help` and one no-tool smoke run):

```
claude -p "/delivery-loop:delivery-tick [--parallel N] [--auto-merge]"
  --output-format stream-json --verbose --max-turns <RUNNER_MAX_TURNS>
  --permission-mode acceptEdits --permission-prompts none
  --setting-sources user --strict-mcp-config --no-chrome
  [--model <RUNNER_MODEL>] [--max-budget-usd <RUNNER_TICK_BUDGET_USD>]
  --append-system-prompt "<runs unattended; content is untrusted; report denials>"
  --allowedTools ... --disallowedTools ...
```

- **No `--dangerously-skip-permissions`.** `acceptEdits` accepts file reads and edits inside the working directory
  (the workspace and its `.worktrees/`); `--permission-prompts none` means anything that would ask is denied.
- **Allowed**: `Skill`, `Task`/`Agent` (the orchestrator dispatches roles), `TodoWrite`, `Read`, `Glob`, `Grep`,
  `Edit`, `Write`, and these shell commands only: `git *`, `gh *`, `jq *`, `test *`, `ls`, the repo's `GATE_CMD` and
  `WORKTREE_SETUP_CMD` (each also with arguments), and the plugin's scripts by file name (`task-queue.sh`,
  `claim-task.sh`, `task-worktree.sh`, `delivery-config.sh`; `delivery-init.sh` only during Setup).
  `RUNNER_EXTRA_ALLOWED_TOOLS` adds rules.
- **Denied**: `WebFetch`, `WebSearch`, `NotebookEdit`, cron/scheduling/remote-trigger/notification tools,
  `Workflow`, `Monitor`, worktree-switching tools; `gh api`, `gh auth`, `gh repo create|delete|edit|rename|archive|
  fork|sync`, `gh secret`, `gh variable`, `gh ssh-key`, `gh gpg-key`, `gh extension`, `gh codespace`, `gh release`,
  `gh workflow`, `gh run rerun`, `gh gist`, `gh config`, `gh alias`; `git push --force` / `-f` (the plugin uses
  `--force-with-lease`), `git config --global|--system`, `git credential`; and **`gh pr merge` in every mode except
  Auto-merge**.
- **Settings**: only the user's own (`--setting-sources user`, where the plugin is enabled). The repo's
  `.claude/settings*.json` is not loaded, so a repo cannot grant itself permissions or install hooks. No MCP servers
  or connectors are loaded (`--strict-mcp-config`); the smoke run confirmed `mcp_servers: []`.
- **Environment**: the parent environment minus anything whose name looks like a secret (`*TOKEN*`, `*SECRET*`,
  `*PASSWORD*`, `*API_KEY*`, `*ACCESS_KEY*`, `*AUTH*`, ...) and minus `GIT_*`, `GH_*`, `GITHUB_*`, `RUNNER_*`.
  Added back: `GH_TOKEN` and a github.com-only git auth header for **the one account that owns this repo**, and at
  most one Claude credential (none for the `claude login` session). Other accounts' tokens, provider keys and
  `ACCESS_KEY` never reach the session; tests assert it. `RUNNER_ENV_PASS` lets named variables through.
- **Limits**: per-tick timeout (kills the process tree), `--max-turns`, daily tick cap, one run per repo, a cap on
  repos running at once, Stop and a global stop-all that kill the tree (`taskkill /T /F` on Windows, the process
  group elsewhere). Stopping the server stops every session.
- **Logs**: `.runs/…jsonl` holds parsed stream events with known tokens, their git Basic-auth form and
  token-shaped strings replaced by `***`. Permission denials reported by Claude Code are shown in the Run panel:
  a denial is a design signal (either the action was wrong, or the allowlist needs a rule you approve).

### What this does not protect against (be clear-eyed)

The allowlist is a **seatbelt, not a sandbox**. An agent that can edit the repo and run its gate can run arbitrary
code as your OS user (the gate executes repository code), and `git`/`gh` with a token can do a lot. Concretely:

- A malicious task or repo file can make an agent write code that exfiltrates what the OS user can read, when the
  gate runs it. Mitigation today: only run the loop on repos and issue authors you trust; fine-grained token; no
  other secrets in the environment. Real fix: Phase 5 sandbox.
- Supervised mode denies `gh pr merge` and `gh api`, but a session could still merge through code it runs in the
  gate, using the same token. **Branch protection on the base branch (required review or required checks) is the
  control that actually holds**, and on a single account the "review" is yours anyway. A separate bot account for
  agents, without merge rights, makes the human merge real. This is the most important setup decision.
- Your user-level Claude Code configuration (other plugins, their hooks, your CLAUDE.md) also loads into runner
  sessions, because the plugin is enabled there. That is your own configuration, but it widens the supply chain.
  Phase 5's per-repo Claude profile fixes it.

### Threat model

| Threat | Path | Controls now | Residual risk / later |
| --- | --- | --- | --- |
| Prompt injection | Issue, PR, comment or file tells an agent to do something else | No network tools; no merge in supervised modes; one repo's token; untrusted-content note in the system prompt; planner has no code tools and every write needs approval; human merge on evidence | Arbitrary code via the gate. Sandbox (Phase 5), bot account, branch protection |
| Token scope | The repo's token is broad (classic PAT, `gh` OAuth) | Token type is detected and a warning shown before every start and in the Repo tab; docs recommend a fine-grained PAT limited to the repo (contents, issues, pull requests: read/write) | gh-board cannot verify a fine-grained token's actual scope |
| Runaway cost | Loop spins, retries or fans out | Supervised serial default; daily tick cap; per-tick timeout and turn cap; stop on first failed tick; idle backoff; optional `--max-budget-usd`; cost per day displayed (as reported by Claude Code) | Subagent spend inside one tick is bounded only by timeout/turns. Budgets per repo in Phase 4 |
| Supply chain | Plugin replaced by another source; malicious repo settings/hooks; dependency install in `WORKTREE_SETUP_CMD` | Plugin source and ref checked against the expected fork before every start; never auto-installed or updated; repo settings not loaded; git hooks disabled for gh-board's own clone/fetch | Plugin content is not pinned to a commit (a `RUNNER_PLUGIN_COMMIT` pin is an easy addition). Dependency installs run with your user's rights |
| Leaks in the UI | Token echoed in output | Scrubber on every logged string; routes never return tokens; tests scan responses and logs | Secrets the scrubber cannot recognise (not token-shaped, not known to gh-board) |
| Remote images in evidence | A PR comment embeds a tracking image | Only GitHub-hosted media is loaded inline, with no referrer; other hosts are links | GitHub-hosted content is still attacker-supplied pixels |
| CSRF / other local users | Another site or user hits the local API | Existing Host/Origin check and optional `ACCESS_KEY`; every dangerous route needs `confirm: true` | The confirmation is a UI contract, not authentication. Do not expose the port without `ACCESS_KEY` |

## 6. Model allocation: the review side is strongest

This policy is the user's judgment. It is not something the talk tested.

**Reasoning.** Checking is cheaper and more reliable than producing. A modest writer under a strong checker
converges: a weak writer mostly costs retries. A weak reviewer is the dangerous case, because it lets bugs through
with false confidence. So:

1. The strongest model plans and writes specs (what to build), and does the independent review.
2. A cheaper, faster model implements inside tight constraints (lint, types, tests, banned patterns).
3. **Deterministic checks run before any model review.** The implementer must pass the gate before opening a PR,
   and the reviewer skill refuses a PR with a failing check. A model judges intent and design, not what a linter
   can catch.
4. The reviewer is **independent**: fresh context (the plugin enforces it) and, where possible, a different model
   than the writer. **A reviewer is never a lower tier than an implementer.**
5. Escalate the writer to a stronger model when the cheap one keeps failing.

**Caveats.** Hard or novel work (algorithms, concurrency, unfamiliar domains) still needs a strong writer: raise
`MODEL_IMPLEMENT_M` for that repo, or split the task. Retry cost can exceed the savings if the weak writer needs
many attempts; the Phase 4 metric "retries per task by implementer model" exists to show that.

### Three tiers

| Tier | `.env` | Default | Resolves to | Notes |
| --- | --- | --- | --- | --- |
| cheap | `CHEAP_MODEL` | `sonnet` | `claude-sonnet-5-5` | The writer for small, tightly checked tasks |
| strong | `STRONG_MODEL` | `opus` | `claude-opus-5-5` | Re-review, patching, large tasks |
| top | `TOP_MODEL` | `fable` | `claude-fable-5-2` | The strongest and most expensive: planning and first review |

Values are Claude Code model aliases because the plugin hands them to the Agent tool's `model` input, which takes
aliases (`sonnet`, `opus`, `fable`, `haiku`); `claude --model` accepts the same aliases and full ids. Each
repo can override the three models and pick a preset in its Model policy panel (Repo tab). Those choices are stored
on this machine in `.runner.json`; they are inputs to the diff below, not a second source of truth.

### Presets (per repo; default Balanced)

| Role | Key | Balanced `$$` | Frugal `$` | Max quality `$$$` |
| --- | --- | --- | --- | --- |
| Planner chat, spec authoring, decompose | (Settings / session model) | top | strong | top |
| Implementer `size:S` | `MODEL_IMPLEMENT_S` | cheap | cheap | cheap |
| Implementer `size:M` | `MODEL_IMPLEMENT_M` | cheap | cheap | cheap |
| Implementer `size:L` | `MODEL_IMPLEMENT_L` | strong | strong | top |
| First review | `MODEL_REVIEW` | **top** | strong | top |
| Re-review after a patch | `MODEL_REREVIEW` | strong | strong | top |
| Patcher | `MODEL_PATCH` | strong | strong | top |
| Re-review scope | `REREVIEW_SCOPE` | narrow | narrow | narrow |

Why Balanced looks like this:

- **Planning on top.** An issue is the prompt every later agent runs from; a mistake there is paid for in every
  implementation, review and patch that follows. It is also the lowest-volume role, so the top model costs least
  here. `/delivery-loop:author-spec` and `decompose` have no model key in the plugin: they run on the model of the
  session you start them in, so run them with the top model (the planner chat does this by default).
- **First review on top.** The first review is the control that decides what reaches you, and the plugin has no
  way to tell a risky change from a safe one, so the only way to give risky changes the top model is to give it to
  every first review. That is the main cost of Balanced: one top-tier session per PR. Reviews read a diff and run
  commands, so they are much smaller than the implementation they check, but on a subscription the top model draws
  down usage limits fastest. If reviews stall on limits, switch that repo to Frugal.
- **Re-review on strong.** With `REREVIEW_SCOPE=narrow` it covers an incremental diff, the failing criteria and the
  gate. It is still at least the tier of every writer, including the patcher.
- **Patch on strong.** The closest the plugin gets to "escalate when the cheap writer fails" (see the gap below).
- **`size:L` on strong.** Mostly theoretical: `size:L` is never claimable and is split first.

The reviewer is a different model than the S/M implementer in all three presets, and never a lower tier than any
implementer. `MODEL_REREVIEW` equals `MODEL_IMPLEMENT_L` in Balanced and Frugal; that is the same tier, which is
allowed, and `size:L` is rarely implemented at all.

### What the panel and the server do

- Show, per role: the value now in `delivery.conf`, its tier chip (cheap / strong / top, or "no tier" for an empty
  or unknown value), the resolved model id, and the preset value.
- **Validate** (`loop/models.mjs`, `validate`): an error when `MODEL_REVIEW` or `MODEL_REREVIEW` is a lower tier than
  any `MODEL_IMPLEMENT_*`; warnings when a reviewer is empty (it inherits the session model, so its tier is unknown),
  is outside the tiers, or is the same model as an implementer. Both the file's current values and the preset (after
  tier overrides) are checked.
- Show the exact diff of `.claude/delivery.conf`. gh-board does not write the file or open a PR: you copy the diff,
  or click "Ask the planner to file a task", and the change arrives through a task, a PR and your merge.
- **Test models**: a button, never automatic. After a confirmation it sends one prompt per tier
  (`claude -p "Reply with the single word ok." --model <m> --max-turns 1 --tools ""`, no GitHub token, empty
  directory) and shows which model answered or the error. For a subscription sign-in this is the only way to know;
  an API key can list models for free.
  Checked once by hand on the user's Max-plan login while building this: `opus` answered as `claude-opus-5-5` and
  `claude-fable-5-2` answered as itself. `sonnet` was the session default in an earlier smoke run. No tier failed.
- The planner chat uses the tier the selected repo's preset gives the planner (top by default) unless
  Settings > Claude > Planner model is set. Loop sessions do not use that setting: the orchestrator inherits your
  Claude Code default, or `RUNNER_MODEL`.

### Risk-based review (designed; only the display is built)

Goal: review risky changes with the top model without paying for it on every PR (what Frugal would need).

What exists: a task labeled `risk:high`, or in a module you mark **sensitive** in the panel, is listed there with
the tier its first review will get under the current preset and the suggested tier (top). Under Balanced and Max
quality they are already covered; under Frugal the panel says they are not.

What cannot be done without a plugin change: choosing the review model **per task**. `delivery.conf` has one
`MODEL_REVIEW`; the orchestrator skill reads it from the file inside the session; and a tick decides which PR to
review only after it starts. The runner could rewrite the workspace's `delivery.conf` before a tick, or steer the
orchestrator through the system prompt, but both are fragile (a parallel tick reviews several PRs with one value;
prompt steering fights the skill's own rule to keep dispatch prompts to one line) and both put policy somewhere the
repo does not record. So gh-board does not select the tier per run.

### Proposed plugin changes (not made; the delivery-loop repo was not edited)

1. **Risk-based review.** New key `MODEL_REVIEW_HIGH_RISK` (default empty = `MODEL_REVIEW`) and
   `HIGH_RISK_MODULES` (space-separated). `delivery-tick` step 4 passes `MODEL_REVIEW_HIGH_RISK` when the linked
   issue carries `risk:high` or its `module:` is listed; `init` creates the `risk:high` label; the planner sets it.
   With this, Frugal plus top-tier review of risky tasks becomes the natural default.
2. **Escalate after two failed attempts.** `MODEL_PATCH` applies from the **first** patch round, and gate failures
   inside the implementer's own session are invisible to the orchestrator, so "escalate after two failed gate runs"
   cannot be expressed. New keys `MODEL_PATCH_ESCALATED` (default empty = `MODEL_PATCH`) and
   `PATCH_ESCALATE_AFTER` (default `2`): `delivery-tick` already reads the latest `Patch iteration: n/3` comment and
   would pass the escalated model when `n >= PATCH_ESCALATE_AFTER`. Then the presets could patch on cheap first.
3. Optionally `MODEL_IMPLEMENT_RETRY` for a task re-claimed after an implementer gave up (`RECLAIMED` in the
   claim ledger), the observable form of "the cheap writer could not pass the gate".

Each needs the plugin's six-place checklist (config.sh, init, delivery-config, README, spec, config-test). Until
then gh-board keeps `MODEL_PATCH` at strong or above and measures retries (Phase 4).

## 7. Phase plan

### Phase 2: correct once, enforce forever

- **Corrections ledger**: every reviewer finding and every human request-changes reason (found by the marker
  gh-board already writes) is recorded with repo, module, PR, and a category. Categories come from a small fixed
  taxonomy first (missing test, wrong layer, naming, error handling, security, scope creep, flaky check), assigned
  by a cheap model, then refined.
- **Trigger**: the same category twice in one repo (or the same finding text, fuzzy-matched) files a
  `module:infra` task "Add a check for <category>" through the planner path: a lint rule, a type, a test or a gate
  step, with the acceptance criterion that the new check fails on the offending commit and passes on the fix.
- **Never** extend `AGENT_RULES_FILE` automatically. A prose rule is the fallback only when the planner states why
  no check can express it, and it is flagged for review after N more occurrences.
- Ledger lives in GitHub (a pinned tracking issue per repo, one comment per correction) so it survives gh-board and
  is visible to agents; gh-board renders it.
- UI: a "Corrections" section in the Repo tab: repeated categories, the check that closed each one, recurrences
  after the check (a recurrence means the check is wrong).

### Phase 3: evidence standards

- Per repo type, a declared evidence standard in `AGENT_RULES_FILE` and enforced by the reviewer: web apps
  (screenshots or video from a headless browser run of the changed flow), APIs (recorded request/response of the new
  endpoint against a running server), libraries (property tests), stateful UI (a state chart checked against the
  implementation), data jobs (before/after counts).
- Evidence capture is a script in the repo run by the gate or by a dedicated `evidence` step, uploading artifacts
  to the PR; the reviewer requires them and re-runs the capture in its clean checkout.
- The review screen gains a required-evidence checklist next to the criteria; a PR without required evidence shows
  as unreviewable, not as "no evidence".
- Auto-merge gate becomes: evidence present and reviewer-reproduced + gate green + review approved + no
  `needs-human`. That check runs in gh-board before the plugin's own auto-merge is allowed for a repo.

### Phase 4: the outer loop

- **Release fuzz agent**: after merges, an agent uses the real app (browser or API) against a preview build,
  follows the specs as a user would, and files issues with reproduction steps and evidence. Its issues enter the
  planner's triage queue, not the ready queue.
- **Fix PRs** flow through the same loop; reverts are detected from history.
- **Metrics** (per repo, per week, computed from GitHub and `.runs/`): PRs per day, revert rate, escalation rate,
  cost per merged PR, time from ready to merge, patch rounds per PR, first-review pass rate, and **retries per task
  by implementer model** (patch rounds and re-claims, split by the `MODEL_IMPLEMENT_*` value in force and by task
  size). The last one answers whether a cheap writer is saving money: cheap-model cost per merged task including
  its retries and the strong patches it triggered, against the strong-model baseline.
- **Budgets per repo**: daily and monthly spend caps enforced by the runner, with the dial dropping to Supervised
  when a budget or an error-rate threshold is crossed.

### Phase 5: isolation, other engines, teams

- **Sandbox**: each tick in a container (Docker locally, cloud later) with the workspace mounted, no home
  directory, egress limited to GitHub and the model API. The runner already isolates everything a session needs
  (cwd, argv, env), so the change is in how the process is spawned. Only then is a permission-bypass mode
  defensible, and only inside the sandbox.
- **Per-repo Claude profile**: choose `CLAUDE_CONFIG_DIR` per repo (the user has a default profile and
  `claude-work`). This also gives the runner a clean profile with only the delivery-loop plugin enabled.
- **Multi-provider engine**: the plugin is Claude Code specific. Non-Claude implementers would need either a
  compatible agent harness that can run the skills, or a second engine behind the same GitHub conventions. The
  conventions (labels, comments, criteria) are the contract, so this is possible without changing the board.
- **Teams**: several humans on one board, review assignment, per-person inbox, audit trail of who merged what.

## 8. Out of scope (explicitly)

- Reimplementing the loop's logic in gh-board, or editing the plugin from gh-board.
- A database, or any local state the backlog depends on.
- Installing or updating Claude Code plugins.
- Pushing to a base branch, creating repositories or changing repository settings.
- Scoring repositories beyond the ok / partly / missing readiness view.
- Making untrusted repositories safe to run: slice 1 assumes you trust the repo and the people who can file issues.

## 9. What is not verified

- **A real end-to-end loop run from gh-board has not been done** (by instruction: no real loop, no writes to real
  GitHub). Everything is tested against a stub CLI, a mock GitHub and local bare repos.
- Whether the allowlist is sufficient in practice. The flags are accepted by Claude Code 2.1.331 and the plugin
  loads in such a session, but rule matching for the plugin's real commands (quoted Windows paths, compound
  commands, command substitution such as `path=$(bash ".../task-worktree.sh" 12)`) is untested. Expect denials on the
  first supervised tick; they are listed in the Run panel. Acceptance criteria that are not the gate, `test` or
  `git`/`gh`/`jq` need a rule in `RUNNER_EXTRA_ALLOWED_TOOLS`.
- `/delivery-loop:init` and the review skill ask the human questions when run interactively; under the runner they
  can only report them in the final message.
- That `acceptEdits` with `--permission-prompts none` confines reads to the workspace as documented by `--help`.
- The reviewer comment parser against real reviewer output (it is heuristic: status word plus quoted command).

## Chat skills and run_loop_skill

The planner chat loads a playbook per ask with `use_skill` (`loop/skills/*.md`): lookups, planning, audits, bug triage,
backlog grooming, specs, and one playbook per delivery-loop skill (`deliver-task`, `review-task`, `patch-task`,
`task-status`, `decompose`, `author-spec`, `author-styleguides`, `run-loop`). The chat itself has no code tools. To act
like the loop it calls `run_loop_skill`, which runs the plugin's real skill (`next-task`, `deliver-task`, `review-task`,
`patch-task`, `task-status`, `decompose`, `author-spec`, `author-styleguides`, `delivery-tick`, `init`) as one session in the
runner's sandbox: same workspace clone, scoped token, allowlist and caps as a tick, with merging denied.
Every run needs an approval card, and "Auto-approve writes" does not cover it. Arguments are validated against a
per-skill pattern before anything starts (`runner/command.mjs`, `RUNNABLE_SKILLS`). Progress streams into the chat; stopping
the chat stops the run.

## Remote access (Settings > Remote access)

`tunnel.mjs` publishes the board to your tailnet with `tailscale serve` on HTTPS port 8443. The server stays bound to
loopback. Turning it on creates an access key (`.tunnel.json`, git-ignored); every remote request needs it, requests
from this computer do not. A request counts as remote if it carries proxy headers, so a forwarded request cannot pass as
local by sending `Host: localhost`. Only this computer can turn it on or off or replace the key. It never uses Funnel,
and it refuses a port that already serves something else. Anyone holding the link can act with your GitHub accounts and
spend your Claude usage. The computer must stay on and awake.

## Hosted board (Vercel)

`vercel.json` sends every path to `api/index.mjs`, which runs the same request handler (`hosted.mjs` holds the
differences). Set in the Vercel project: `ACCESS_KEY` (12+ characters; until then every request gets 503),
optionally `GITHUB_TOKEN` and `AI_GATEWAY_API_KEY` (otherwise the deployment's OIDC token is offered to AI Gateway).
`NODEJS_HELPERS=0` keeps request bodies unread for the handler. Open the site once with `?key=<ACCESS_KEY>`.

Available: boards, issue view/create/update/close/comment, loop status and review pages, and a chat that reads the repo
through the GitHub API. Not available: the runner, local code search, the Claude sign-in settings. GitHub tokens and provider keys
added in the UI are saved, encrypted with a key derived from `ACCESS_KEY` (`vault.mjs`), in an Upstash Redis database
connected under the project's Storage tab (`KV_REST_API_URL`, `KV_REST_API_TOKEN`). Changing `ACCESS_KEY` discards them. Chat history and
pending approvals live in one server instance's memory, so a conversation can reset, and an approval can fail to arrive.
