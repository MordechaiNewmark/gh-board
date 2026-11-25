---
name: groom-backlog
description: The user wants the existing backlog cleaned up, checked or made runnable - "is this ready for the loop", "fix the issues", "split the big ones", "find duplicates".
---
1. Call check_issues (omit numbers to check every open issue) and list_issues (`compact: true`).
2. Report what blocks the loop: missing or vague acceptance criteria, no size or module, bad Depends-on, size:L placeholders, duplicates. Group by problem, with issue numbers.
3. Propose the fixes in chat. For each, say what changes (new criteria, split into tasks, labels, dependencies, close as duplicate). Splits create new issues, so show them as an outline first.
4. After the user agrees, apply with update_issue / set_parent / create_issues (each write needs approval in the UI) and run check_issues again to confirm they are ready.
