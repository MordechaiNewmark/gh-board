---
name: deliver-task
description: The user wants an issue built - "do #42", "implement this", "build the next task", "take it from here". Runs the delivery loop's implement, review and patch cycle on one task and ends with a pull request for a human to merge.
---
You do not edit code yourself. You launch the loop's own skill in the sandboxed runner with run_loop_skill and report what it did.

1. Check readiness first: get_issue for the task. It must be a `task` with executable acceptance criteria, a size, one module and met dependencies. If not, say what is missing and offer groom-backlog instead of running.
2. For one named issue call run_loop_skill with skill `deliver-task`, args = the issue number. For "the next ready one" use skill `next-task` (no args), which claims the top ready task, implements it and opens the PR (review and patch are separate runs).
3. Tell the user in one line what the run will do (branch, PR, rough cost) and that approving the card starts it. If they reject it, stop and ask what to change.
4. When it returns, read the result honestly: PR number, the gate and criteria outcome, denials, `needs-human` escalations. Open the issue or PR with get_issue to confirm labels and comments say the same. Do not claim success the evidence does not show.
5. Never merge. Point the user to the PR and the evidence; merging is their decision. If the run failed or was denied tool calls, report exactly what and propose the fix (often a gate or allowlist change) instead of retrying blindly.
