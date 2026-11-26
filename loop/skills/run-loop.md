---
name: run-loop
description: The user wants the loop to run or the repo prepared for it - "start the loop", "run a tick", "set up this repo", "why is nothing happening". Runs one orchestrator tick or the one-time init.
---
1. Check the state first: list_labels (do the loop's `status:*` labels exist?) and list_issues with `compact: true` (are any tasks `status:ready`?). If the repo is not set up (no labels, no `.claude/delivery.conf`), the right action is init, not a tick.
2. For setup call run_loop_skill with skill `init`. It creates the labels, scaffolds `.claude/delivery.conf`, `scripts/check.sh` and styleguides, and opens a pull request. Tell the user to review the gate in that PR and merge it before ticking.
3. For work call run_loop_skill with skill `delivery-tick`: one tick patches a rejected PR, reviews an unreviewed one, or starts the next ready task, exactly one action. For continuous running or parallelism send the user to the Run panel; this tool runs one tick at a time.
4. Report which single action the tick took and what is waiting on the user. Never merge.
