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
| Code | Code tab: browse and read files, start an issue from a file | Read and search code to ground issues in real paths |
| Files in | Attach or drop files on the chat | Text and images are read; any file can be attached to an issue or committed |
| Files out | Download card in the chat | Specs, CSV exports, reports via `generate_file` |

Columns are labels named `status:<Column>`; the last column closes the issue. Hierarchy uses GitHub sub-issues. Change columns with `COLUMNS` / `STATUS_PREFIX` in `.env`.

**Attachments:** GitHub has no public API for uploading issue attachments. Small text files are embedded in a comment; everything else is committed to a `board-attachments` branch and linked from a comment.

**Approvals:** the agent reads freely. Every write (issues, labels, commits) shows an Approve / Reject card unless you tick "Auto-approve writes".

## On a phone

The layout adapts below 760 px: repos become a scrolling strip, columns swipe sideways, and Chat is its own tab. Touch has no drag and drop, so tap a card and change **Column** in the dialog.

The server is on your computer, so the phone has to reach it. In `.env` set `HOST=0.0.0.0`, an `ACCESS_KEY` of 12+ characters, and `ALLOWED_HOSTS` to the address you'll type (for example `192.168.1.20:3000`, or your Tailscale name with the port). Open `http://<address>:3000/?key=<ACCESS_KEY>` once on the phone; it stays unlocked for 30 days. The connection is plain HTTP, so use it on a network you trust or over Tailscale.

## Notes

- The server only listens on 127.0.0.1 and rejects requests from other sites.
- The agent has only the GitHub tools in `server.mjs`: no shell and no access to your disk.
- Shows up to about 300 open and 40 recently closed issues per repo. Files over 1 MB can't be read through the API.
