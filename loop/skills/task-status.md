---
name: task-status
description: The user wants the state of the delivery board - "what is the loop doing", "what is stuck", "what needs me". Renders ready / claimed / in-review / changes-requested / approved / blocked / needs-human from issues and PRs.
---
1. For a quick answer use list_issues with `compact: true` and group by the `status:*` labels plus `needs-human`; that needs no run and costs nothing. Lead with what needs the user: `needs-human` and approved PRs waiting to be merged.
2. Use run_loop_skill with skill `task-status` (add `--reclaim` only if the user wants stale claims released and labels reconciled, since that changes labels) when the labels look inconsistent or the user asks for the loop's own report.
3. Keep it short: counts per state, then the few items that need a decision.
