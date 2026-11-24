# gh-board

A local board for GitHub issues with a Claude Agent SDK chat that manages it. Works with repos you were **invited to**, because it uses your own GitHub account rather than Claude Desktop's GitHub connection.

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

**Claude (OAuth, no API key):** run `claude setup-token` and put the result in `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. Without it the SDK uses your existing `claude login` session. `ANTHROPIC_API_KEY` is ignored on purpose.

**GitHub:** connect in the UI. Click **Connect GitHub** (it opens by itself on first run) and either:

- paste a classic personal access token with `repo` and `read:org` scopes (the dialog links to GitHub's token page with those scopes ticked). If an org uses SSO, authorize the token for that org; or
- click **Sign in with GitHub**. This button appears only when `GITHUB_CLIENT_ID` is set: create an OAuth app at github.com/settings/developers, tick "Enable Device Flow", and put its Client ID in `.env`. An org may need to approve the OAuth app before its repos show up.

The token is stored in `.gh-token` next to the server (owner-readable only) and never sent to the browser. `GITHUB_TOKEN` in `.env` or a `gh auth login` session also work as fallbacks. **Disconnect** in the same dialog removes it.

## What you can do

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
| GitHub token | `.gh-token` / `.env` / `gh` CLI, as before | Never written into the checkout. |
| Chat sessions | The Claude Agent SDK's own session store, keyed by checkout folder | Switching repos starts a fresh agent session. |

**Security notes**

- The token is passed to `git` only through environment variables (`GIT_CONFIG_*` with an `http.https://github.com/.extraheader`). It is not in the remote URL, the command line, or `.git/config`, and the credential helper is turned off for these calls.
- `git` runs without a shell, with argument arrays. `owner/name` and `ref` are validated strictly, so they cannot escape the cache folder or be read as options. Repo hooks, submodules, symlinks and LFS downloads are disabled.
- The agent's only built-in tools are `Read`, `Glob` and `Grep`. There is no shell, no file writing, no web access and no subagents. A pre-tool hook resolves every path (following symlinks and junctions) and denies anything outside the selected repo's checkout, plus `.git`, `node_modules`, binaries and files over `ANALYSIS_MAX_FILE_MB`.
- No settings, `CLAUDE.md`, skills, hooks or MCP config are loaded from the checkout.
- Repo contents are untrusted input to the model. A hostile file could try to talk the agent into a write. With approvals on, you see and decide every write. **Leave "Auto-approve writes" off when analyzing a repo you do not fully trust.**
- `READ_ONLY=1` in `.env` blocks every write to GitHub in the server itself (board UI and chat). Use it to try an analysis with no chance of creating anything; the proposal still appears in the chat.
- Limits: repos over `ANALYSIS_MAX_MB` (default 300, as reported by GitHub) are refused, and a sync is killed after `ANALYSIS_SYNC_TIMEOUT_S` (default 180).

## On a phone

The layout adapts below 760 px: repos become a scrolling strip, columns swipe sideways, and Chat is its own tab. Touch has no drag and drop, so tap a card and change **Column** in the dialog.

The server is on your computer, so the phone has to reach it. In `.env` set `HOST=0.0.0.0`, an `ACCESS_KEY` of 12+ characters, and `ALLOWED_HOSTS` to the address you'll type (for example `192.168.1.20:3000`, or your Tailscale name with the port). Open `http://<address>:3000/?key=<ACCESS_KEY>` once on the phone; it stays unlocked for 30 days. The connection is plain HTTP, so use it on a network you trust or over Tailscale.

## Notes

- The server only listens on 127.0.0.1 and rejects requests from other sites.
- The agent has the GitHub tools in `server.mjs` plus read-only `Read` / `Glob` / `Grep` confined to `.repo-cache/<owner>/<name>` of the selected repo: no shell, no writes to disk, and no access to the rest of your disk.
- Shows up to about 300 open and 40 recently closed issues per repo. Files over 1 MB can't be read through the API.
