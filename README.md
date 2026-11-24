# gh-board

**Issues are the product.** gh-board is the front end of an autonomous development loop: you think, plan and design in a chat and on a board, and what comes out is GitHub issues (epics, tasks, specs). Agents then do the development work on their own, running the [delivery-loop](https://github.com/MordechaiNewmark/delivery-loop/tree/cost-aware-defaults) plugin for Claude Code, and you supervise: you read evidence, merge, and answer escalations. The chat never edits code.

- **Planner chat.** Plans with you, reads the repo, and creates issues the loop can run: one module, size S or M, `Depends-on`, acceptance criteria that are commands. Every write shows a preview you approve. Works with Claude, OpenAI, Gemini and OpenAI-compatible models.
- **Run control.** Start one tick or run continuously, pause, stop. Each tick is one Claude Code session running the plugin's own `/delivery-loop:delivery-tick` in a working clone on this machine.
- **Loop board.** The plugin's real states (blocked, ready, claimed, in review, changes requested, approved, needs human, done), with the PR, CI, patch round and blockers on each card. The classic `status:<Column>` board is one click away.
- **Inbox.** What needs you: escalations, approved PRs to merge, failing checks, stale claims. Review is evidence first: per-criterion results, gate and CI, attached screenshots and video, findings; the diff comes last.
- **Repo tab.** Whether the repo is ready (gate, styleguides, specs, rules) as a trust pyramid, and the model policy.

It works with repos you were **invited to**, because it uses your own GitHub accounts, and you can connect several identities at once. The design, the safety model and the roadmap are in [docs/PLATFORM.md](docs/PLATFORM.md).

## Quick start: planner and loop

1. Set up and start gh-board (next section), connect GitHub, pick a repository.
2. Install the engine yourself, once (gh-board checks for it and never installs anything):
   ```bash
   claude plugin marketplace add "MordechaiNewmark/delivery-loop#cost-aware-defaults"
   claude plugin install delivery-loop@delivery-loop
   ```
   The loop also needs `git`, `gh`, `jq` and `bash` on PATH.
3. Open the **Repo** tab. If the repo is not set up, click **Set up this repo**: after a confirmation it runs `/delivery-loop:init`, which creates the loop's labels and opens a pull request with `.claude/delivery.conf` and a starter gate (`scripts/check.sh`). Review the gate and merge that PR yourself. **The loop refuses to run without a gate that checks something.**
4. Plan in the chat: "Plan a feature into loop-ready tasks". Approve the preview card. Cards on the Loop board show whether each task is ready for the loop.
5. On the **Board**, click **Run one tick**, read the confirmation, start. Watch the tick in the Run panel. When a PR is approved it appears in the **Inbox**; review the evidence and merge.
6. When single ticks are boringly reliable, use **Run continuously**. Autonomy stays at **Supervised** (you merge every PR) until you raise it.

### Safety notes (read before the first run)

- **Agents run on your machine as you.** The session gets an allowlist (git, gh, jq, the repo's gate and setup command, the plugin's scripts; edits inside the workspace only), no network tools, no MCP servers, and it cannot run `gh pr merge` unless you chose Auto-merge. That is a seatbelt, not a sandbox: the gate executes the repository's code. Run the loop only on repos, and with issue authors, you trust.
- **Use a fine-grained GitHub token limited to the repo** (contents, issues, pull requests: read and write) for the account that owns it. The session receives only that account's token, never the other accounts', never provider keys. gh-board warns when the token is a broad classic PAT or OAuth token.
- **Protect the base branch** on GitHub (required checks or review). On a single account that is what makes "the human merges" true; a separate bot account for the agents is better still.
- **Issues, PR text and repo files are untrusted input** to the agents. The gate and your merge are the controls.
- **Limits**: 40 ticks per repo per day, 60 minutes and 200 turns per tick, one run per repo, stop on the first failed tick. **Stop** kills the session and everything it started. `READ_ONLY=1` disables the runner and every write.
- Every tick is logged, with tokens scrubbed, in `.runs/`. Denied actions are listed in the Run panel.
- Not yet proven by a real end-to-end run from gh-board: see "What is not verified" in docs/PLATFORM.md. Start with one supervised tick.

### Models

The review side is strongest. Three tiers, set in `.env` and overridable per repo: `CHEAP_MODEL` (default `sonnet`), `STRONG_MODEL` (`opus`) and `TOP_MODEL` (`fable`, the strongest and most expensive). The **Repo** tab's Model policy panel offers three presets per repo:

| Preset | Planner | Implement S/M | Implement L | First review | Re-review | Patch |
| --- | --- | --- | --- | --- | --- | --- |
| **Balanced** (default, `$$`) | top | cheap | strong | top | strong | strong |
| Frugal (`$`) | strong | cheap | strong | strong | strong | strong |
| Max quality (`$$$`) | top | cheap | top | top | top | top |

The panel shows the tier and resolved model id of every role, warns when a reviewer is a lower tier than an implementer, lists tasks labeled `risk:high` or in modules you mark sensitive, and gives you the diff of `.claude/delivery.conf` to apply through a task and a PR (gh-board does not write it). **Test models** sends one tiny prompt per tier, only when you click it, to check that your sign-in can use each model. The planner chat uses the preset's planner tier unless you set Settings > Claude > Planner model. Reasoning, caveats and the plugin gaps: docs/PLATFORM.md, "Model allocation".

## Setup

```bash
cd gh-board
npm run setup            # installs everything and generates the shadcn + assistant-ui components
npm run build            # builds the React UI into web/dist
cp .env.example .env     # optional, see below
npm start                # then open http://localhost:3000
```

The UI lives in `web/`: React, Tailwind, shadcn/ui components and assistant-ui for the chat. `npm run setup` runs the shadcn CLI, which writes `web/src/components/ui/*` and `web/src/components/assistant-ui/*`; those files are generated, not shipped. If you skip the build, the server falls back to the older single-file UI in `public/index.html`.

If the build can't find the chat component, the assistant-ui registry put it somewhere else: fix the one import in `web/src/chat/thread.ts`. For UI work, run `npm start` and `npm run dev:web` together and open http://localhost:5173.

**Claude:** nothing to configure if you have run `claude login` on this computer. To change how the chat signs in, click the gear icon in the header (**Settings > Claude**) and pick one of:

| Method | What you provide | Who pays |
| --- | --- | --- |
| Claude login session (default) | Nothing. Uses the `claude login` session on this computer. | Your Claude subscription |
| OAuth token | The token printed by `claude setup-token` | Your Claude subscription |
| Anthropic API key | A key from console.anthropic.com | Your Anthropic API account, per token |

The billing difference matters: with an API key, every chat message and repo analysis is charged to the API account, while the other two methods use your Claude subscription. The chat header always shows the active method.

- **Save** stores the key or token on the server only, in `.claude-auth.json` next to the server (owner-readable, git-ignored). It is never sent back to the browser: the UI shows the method and a masked tail such as `••••abcd`. The agent process receives it only as the one environment variable the SDK expects for that method (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`).
- **Test connection** checks the active method. An API key is validated with a free request that lists models. The login session and the OAuth token have no free check, so the test sends one very short prompt through the Agent SDK.
- **Remove** forgets a saved key or token.
- **Model** (same dialog) picks the model for the chat; leave it empty for your account's default.
- Order of precedence: what you saved in Settings, then `.env` (`CLAUDE_CODE_OAUTH_TOKEN` first, then `ANTHROPIC_API_KEY`), then the login session. An `ANTHROPIC_API_KEY` that is only exported in your shell, and not written in `.env` or saved in Settings, is ignored, so starting the server never moves you onto API billing by accident.

**GitHub:** connect in the UI. Click **Connect GitHub** (it opens by itself on first run) and either:

- paste a classic personal access token with `repo` and `read:org` scopes (the dialog links to GitHub's token page with those scopes ticked). If an org uses SSO, authorize the token for that org; or
- click **Sign in with GitHub**. This button appears only when `GITHUB_CLIENT_ID` is set: create an OAuth app at github.com/settings/developers, tick "Enable Device Flow", and put its Client ID in `.env`. An org may need to approve the OAuth app before its repos show up.

### Several GitHub accounts

The account button in the header opens the account manager. **Add account** connects another identity next to the ones you have; nothing is replaced. To add a second identity with a token, create the token while signed in to github.com as that account. With **Sign in with GitHub**, switch accounts on github.com first, because GitHub authorizes whichever account the browser is signed in to.

- **Repository list.** It is the merged list of every connected account. With more than one account, each repo shows the avatar of the account used for it, and a filter (**All accounts** / one login) appears under the search box.
- **Which account is used.** Every request for a repo (issues, labels, milestones, files, board moves, comments, commits, the local checkout for analysis, and the chat's tools) uses the token of the account that can access that repo. If two accounts can open the same repo, the one with the higher permission wins (admin, then write, then read); on a tie, the **default** account. Change the default with **Set as default**.
- **Attribution.** Whatever you create or change is attributed on GitHub to that account. The issue dialog and the chat header show it as **as @login**. When more than one account can open the repo, that label is a picker, and your choice is remembered for that repo.
- **Disconnect** removes one account: its token is deleted, its repos leave the list, and local checkouts of repos only it could reach are deleted from `.repo-cache`. The other accounts are not affected.
- **Adding the same login again** replaces its token (use this to rotate a token).
- **Expired or revoked token.** That account is marked **Needs attention** (an amber dot on the header button). The other accounts keep working. Add a new token for it to fix it.
- **SSO.** If an organization requires SSO and the token is not authorized for it, the error names the account and links to GitHub's authorization page.
- `READ_ONLY=1` blocks writes for every account.

**Where tokens are stored.** Connected accounts live in `.gh-accounts.json` next to the server (owner-readable only, git-ignored): login, avatar URL, token, how it was added, the default account, and your per-repo choices. Tokens are never sent to the browser and never logged. `GITHUB_TOKEN` in `.env` and a `gh auth login` session are picked up as extra accounts when present. They are not copied into the file, and an account with the same login that you added in the app takes their place. If you disconnect one of these, it stays disconnected (with a **Reconnect** button) until you bring it back.

**Upgrading from the single-account version.** Nothing to do. On first start, an existing `.gh-token` is checked with GitHub, moved into `.gh-accounts.json` as your default account, and deleted. If GitHub rejects it, the file is left alone and the dialog tells you. If you were using `GITHUB_TOKEN` or the GitHub CLI, that keeps working as before.

## What you can do

_The chat is in planner mode by default: it has no tool that commits files. `CHAT_MODE=classic` restores the older chat described in the "Through chat" column, including commits._

| Area | In the UI | Through chat |
| --- | --- | --- |
| Issues | Create, edit, close/reopen, comment, drag between columns | All of that, in bulk, plus delete (admin only) |
| Labels | Toggle on an issue, create with a color | Create, rename, recolor, delete |
| Hierarchy | Hierarchy tab, set a parent, add sub-issues | Create epics with children in one go, re-parent |
| Milestones, assignees | Pick on an issue | Create/close milestones, assign |
| Code | Code tab: browse and read files, start an issue from a file | Analyze the whole repo from a local checkout and file grounded issues (see Repo analysis) |
| Files in | Attach or drop files on the chat | Text and images are read; any file can be attached to an issue or committed |
| Files out | Download card in the chat | Specs, CSV exports, reports via `generate_file` |

Columns are labels named `status:<Column>`; the last column closes the issue. Hierarchy uses GitHub sub-issues. Change columns with `COLUMNS` / `STATUS_PREFIX` in `.env`.

**Attachments:** GitHub has no public API for uploading issue attachments. Small text files are embedded in a comment; everything else is committed to a `board-attachments` branch and linked from a comment.

**Approvals:** the agent reads freely (GitHub data and its local checkout of the selected repo). Every write (issues, labels, commits) shows an Approve / Reject card unless you tick "Auto-approve writes".

## Repo analysis

Click **Analyze repo** in the chat header (or pick a starting point in the empty chat: audit and backlog, TODOs to issues, README/specs vs. code, test coverage gaps). Claude then works the way Claude Code does on a local project:

1. **Sync.** `sync_repo` shallow-clones the selected repo (depth 1, default branch, or a `ref` you name) into `.repo-cache/<owner>/<name>`, or fast-updates it if it is already there.
2. **Explore.** It reads the whole tree with `Read`, `Glob` and `Grep`: structure, README and specs, config, tests, CI, TODO/FIXME, risky spots.
3. **Check the board.** It lists open issues and labels first, so it does not file duplicates.
4. **Report.** It writes a findings summary in the chat, with `path:line` evidence.
5. **Propose.** It calls `create_issues` once with epics and child issues. The approval card shows a readable preview (titles, labels, hierarchy; open an issue to read its full body). Nothing is created until you click **Create N issues**.

Every issue body follows one template: Context (with `path:line` references and short verbatim snippets), Problem / Opportunity, Proposed approach, Acceptance criteria (checklist), Out of scope, Related (parent epic, dependencies), and the commit it was analyzed at. The agent is told to cite only code it actually opened.

**What is stored where**

| What | Where | Notes |
| --- | --- | --- |
| Checkouts | `.repo-cache/<owner>/<name>` (git-ignored) | One commit, no history. Delete the folder any time; it is re-created on the next sync. |
| GitHub tokens | `.gh-accounts.json` / `.env` / `gh` CLI | Never written into a checkout, sent to the browser, or logged. |
| Claude key or token | `.claude-auth.json` / `.env` | Only if you choose a method that needs one. Never sent to the browser or logged. |
| Chat sessions | The Claude Agent SDK's own session store, keyed by checkout folder | Switching repos starts a fresh agent session. |

**Security notes**

- A sync uses the token of the account that owns the repo. It is passed to `git` only through environment variables (`GIT_CONFIG_*` with an `http.https://github.com/.extraheader`). It is not in the remote URL, the command line, or `.git/config`, and the credential helper is turned off for these calls.
- `git` runs without a shell, with argument arrays. `owner/name` and `ref` are validated strictly, so they cannot escape the cache folder or be read as options. Repo hooks, submodules, symlinks and LFS downloads are disabled.
- The agent's only built-in tools are `Read`, `Glob` and `Grep`. There is no shell, no file writing, no web access and no subagents. A pre-tool hook resolves every path (following symlinks and junctions) and denies anything outside the selected repo's checkout, plus `.git`, `node_modules`, binaries and files over `ANALYSIS_MAX_FILE_MB`.
- No settings, `CLAUDE.md`, skills, hooks or MCP config are loaded from the checkout.
- Repo contents are untrusted input to the model. A hostile file could try to talk the agent into a write. With approvals on, you see and decide every write. **Leave "Auto-approve writes" off when analyzing a repo you do not fully trust.**
- `READ_ONLY=1` in `.env` blocks every write to GitHub in the server itself (board UI and chat), for every connected account. Use it to try an analysis with no chance of creating anything; the proposal still appears in the chat.
- The agent process never receives a GitHub token. GitHub calls run in the server. The only credential the agent gets is the Claude one for the method you chose.
- `.gh-accounts.json` and `.claude-auth.json` are written with owner-only permissions (mode 600). On Windows that mode has no effect; the files are protected by the access rules of the folder they are in, so keep gh-board inside your user profile. The secrets are not encrypted on disk.
- Anyone who can open the board can use every connected account and can replace the Claude key. If you expose it beyond localhost (see On a phone), the `ACCESS_KEY` is the only barrier, and a key you paste travels over plain HTTP. Paste secrets from the computer that runs the server.
- Limits: repos over `ANALYSIS_MAX_MB` (default 300, as reported by GitHub) are refused, and a sync is killed after `ANALYSIS_SYNC_TIMEOUT_S` (default 180).

## Providers

The chat runs on Claude by default (the Claude Agent SDK path described above, unchanged). It can also run on other models. Pick the provider and model in the chat header; the choice is remembered in your browser. Set providers up under the gear icon, **Settings > Providers**.

| Provider | Kind | Key | Notes |
| --- | --- | --- | --- |
| Claude | Claude Agent SDK | Your Claude sign-in | Default. The most reliable at long, multi-step analysis. |
| OpenAI | Chat Completions API | `OPENAI_API_KEY` or the UI | |
| Google Gemini | `generateContent` API | `GEMINI_API_KEY` / `GOOGLE_API_KEY` or the UI | |
| Custom (any number) | OpenAI-compatible | Optional | OpenRouter, Groq, Mistral, Ollama, LM Studio and anything else that speaks `/v1/chat/completions`. Give it a name, a base URL and model ids. |

For each provider you can paste a key, edit the model list (ids are free text; **Test connection** also loads the ids the provider offers), change the base URL, turn it off, and remove it. **Test connection** lists the provider's models, which spends no tokens; for a custom endpoint it also sends a one-token request, because some of them list models without checking the key.

**What every provider gets.** The same GitHub tools (one list of definitions in `server.mjs` feeds both paths), the same system prompt and issue template, and read-only access to the local checkout through `read_file_local`, `glob` and `grep`, which stand in for Claude Code's `Read` / `Glob` / `Grep` and go through the same path guard: nothing outside the checkout, no `.git`, no `node_modules`, no binaries, nothing over `ANALYSIS_MAX_FILE_MB`, symlinks resolved. There is still no shell and no writing to disk. Every write to GitHub shows the same Approve / Reject card, "Auto-approve writes" works the same way, and `READ_ONLY=1` blocks writes on every path.

**Where keys live**

- Keys saved in the UI go to `.providers.json` next to the server: git-ignored, created with owner-only permissions (`0600`), written atomically. On Windows the file relies on your user profile's permissions, like `.gh-token`.
- Keys in `.env` work as a fallback when nothing is saved in the UI: `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, and for a custom provider any variable ending in `_API_KEY` that you name when adding it (for example `GROQ_API_KEY`). `OPENAI_BASE_URL` / `GEMINI_BASE_URL` override the endpoints.
- A key is never sent to the browser. The UI shows where it came from and at most its last four characters. Keys are not logged, are scrubbed from error messages, and are removed from the server's environment at startup, so `git`, `gh` and the Claude Code process never inherit them.
- A key is sent only to its own provider's base URL, in a header, and redirects are refused. Base URLs must be `http://` or `https://`; a plain-http address that is not this computer gets a warning, because the key and the repo content would travel unencrypted.

**Limits**, all optional in `.env`: `PROVIDER_MAX_STEPS` (model turns per message, default 60), `PROVIDER_TIMEOUT_S` (default 1200, not counting time spent waiting for your approval), `PROVIDER_TOOL_OUTPUT_CHARS` (cap on one tool result, default 30000) and `PROVIDER_HISTORY_CHARS` (cap on tool output kept in a conversation, default 300000; the oldest results are dropped first).

**Know before you switch**

- Models other than Claude are often weaker at long tool-using work. A whole-repo audit can stop early, skip steps, repeat itself or cite less carefully. Check the findings before approving a backlog. Small local models are the weakest here.
- The model must support tool (function) calling. If it does not, the chat says so and names the model.
- With a non-Claude provider, your prompts, issue text and every repo file the model reads are sent to that provider. Use a local server (Ollama, LM Studio) if the code must not leave your machine.
- Conversation history for these providers is kept in the server's memory per chat and is lost on restart. Switching between Claude and another provider, or switching repos, starts a fresh conversation.
- Wrong key, rate limit, quota, unknown model and unreachable server each produce a message that names the provider.
- Not supported on these providers: extended thinking output, prompt caching controls, and resuming a session after a server restart.

`npm test` runs the provider tests against a scripted mock model (no network, no keys). `node test/e2e-providers.mjs` runs a full chat against a `READ_ONLY=1` server and your GitHub read access.

## On a phone

The layout adapts below 760 px: repos become a scrolling strip, columns swipe sideways, and Chat is its own tab. Touch has no drag and drop, so tap a card and change **Column** in the dialog.

The server is on your computer, so the phone has to reach it. In `.env` set `HOST=0.0.0.0`, an `ACCESS_KEY` of 12+ characters, and `ALLOWED_HOSTS` to the address you'll type (for example `192.168.1.20:3000`, or your Tailscale name with the port). Open `http://<address>:3000/?key=<ACCESS_KEY>` once on the phone; it stays unlocked for 30 days. The connection is plain HTTP, so use it on a network you trust or over Tailscale.

## Notes

- The server only listens on 127.0.0.1 and rejects requests from other sites.
- The agent has the GitHub tools in `server.mjs` plus read-only `Read` / `Glob` / `Grep` confined to `.repo-cache/<owner>/<name>` of the selected repo: no shell, no writes to disk, and no access to the rest of your disk.
- `npm test` runs the account and settings tests against a local mock of the GitHub and Anthropic APIs, with fake tokens. It needs no network and writes nothing to GitHub. (`GITHUB_API_URL` and `GH_BOARD_DATA_DIR` exist for these tests; leave them unset otherwise.)
- Other providers (OpenAI, Gemini, OpenAI-compatible) get the same tools and limits; see Providers.
- Shows up to about 300 open and 40 recently closed issues per repo. Files over 1 MB can't be read through the API.
