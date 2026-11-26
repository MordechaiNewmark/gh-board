---
name: decompose
description: The user has specs in the repo and wants them turned into a dependency-ordered backlog of epics and tasks - "break the specs down", "decompose". Uses the loop's own decompose skill: dry run first, create only after approval.
---
1. Run run_loop_skill with skill `decompose` and no `--create` (a dry run that only prints the backlog). Add module names as args to limit scope, for example `backend api`.
2. Show the user the printed backlog in chat and call out what you would change. Do not create anything yet.
3. When the user approves, run it again with args `--create` (plus the same scope). That run writes the issues, so the approval card matters.
4. Afterwards call check_issues and report which issues are ready for the loop. If the specs are thin, offer write-spec or author-spec first.
