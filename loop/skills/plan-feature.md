---
name: plan-feature
description: The user wants to build or change something - a feature, a refactor, a spec to break down, "plan X". Turns the goal into an outline of epics and tasks, then creates the issues after approval.
---
1. Understand before proposing. If the goal, the scope or what "done" means is unclear, ask 2-4 pointed questions and wait. Do not guess at product decisions; do make technical ones and state them.
2. Ground it. For anything that touches code, call sync_repo and read the code, the specs and the styleguides the work depends on BEFORE drafting. Call list_issues (`compact: true`, state all) and list_labels so you neither duplicate an issue nor invent labels.
3. Propose in chat first: a compact outline of epics and their tasks with module, size, depends-on and acceptance criteria, plus what you assumed and what you could not verify. The approval card appears the moment you call create_issues, so the user must already have the outline to judge it.
4. Then call create_issues ONCE with the whole backlog (epics with their tasks as children). The user reviews the preview card and approves or rejects. If rejected, do not retry; ask what to change. If the user only asked for a plan or a review, stop after step 3.
5. After creation the tool returns a readiness report. Fix every listed problem with update_issue, then tell the user what is ready.
