---
name: answer-questions
description: The user asks about issues that already exist - "list the bugs", "what is blocked", "what is in review", "what did we decide about X". Read-only; creates nothing.
---
This is a lookup, not planning. Answer from the issues themselves and do not create or change anything.

1. Fetch with ONE list_issues call, passing `compact: true`. Use `label` to narrow ("bug"), and `state: "all"` only if the user wants closed ones too. Do NOT call list_issues once per label, and do NOT try to search saved tool-result files: compact output is small enough to read directly.
2. If you are unsure which label the user's words map to, call list_labels once first.
3. Answer with a short table or list: `#number title (labels, column)`, grouped the way the user asked (by label, module, status). Say how many matched and whether the list may be cut off (the tool returns at most the 3 newest pages of open issues and 40 closed ones).
4. Open get_issue only for the few issues the user wants detail on. Loop state is in labels: `status:*`, `needs-human`, `claim:agent`, `size:*`, `module:*`.
5. If the answer suggests follow-up work, offer it in one line and stop; load another skill only when the user says yes.
