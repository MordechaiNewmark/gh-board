---
name: patch-task
description: The user wants review findings or failing CI on a pull request fixed - "fix the review comments on 17", "patch this PR". Runs the loop's bounded patcher (3 iterations, then escalates to a human).
---
1. Identify the PR number. Read the review findings or failing checks with get_issue so you can tell the user what will be fixed.
2. Call run_loop_skill with skill `patch-task`, args = the PR number. The patcher is bounded to 3 iterations and then escalates with `needs-human`; do not try to work around that limit.
3. Report what changed and whether the gate passes now. If it escalated, summarise why and what decision the user needs to make.
4. Offer review-task for a fresh independent review of the patched PR. Never merge.
