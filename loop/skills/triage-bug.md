---
name: triage-bug
description: The user reports a bug or unexpected behaviour and wants it understood and filed. Locates it in the code and writes a task whose first criterion is a regression test.
---
1. Dedupe: list_issues (`compact: true`, label "bug", state all) and look for the same symptom. If one exists, point to it instead of filing again.
2. Locate it: sync_repo, find the code path from the symptom, read it, and state the likely cause with `path:LINE` evidence. Say plainly if you could not find it.
3. Propose ONE task (two only if there are clearly separate causes): Context = symptom, how to reproduce, suspected cause with evidence. Acceptance criteria = a regression test command that fails before the fix and passes after, plus the repo gate. Label it `task`, one `module:`, size S or M, and `bug`.
4. Show it in chat, then create it with create_issues after the user agrees. Do not propose the fix as code; the delivery loop writes it.
