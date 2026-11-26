---
name: review-task
description: The user wants a pull request reviewed against its issue - "review PR 17", "is this one good", "check the agent's work". Runs the loop's independent adversarial reviewer, which executes every acceptance criterion.
---
1. Identify the PR number (ask if it is not clear). get_issue on the linked task to read its acceptance criteria.
2. Call run_loop_skill with skill `review-task`, args = the PR number. The user approves the run; it is a separate agent session, so the review is independent of whoever wrote the code.
3. Report the per-criterion verdict from the result: which criteria passed when executed, which failed, and the reviewer's findings. Quote evidence, not impressions.
4. If changes are requested, offer patch-task. If approved, say the PR is ready for the human to merge. Never merge yourself.
