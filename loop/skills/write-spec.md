---
name: write-spec
description: The user wants a design or spec written - "spec out X", "design the approach", "write up the requirements" - before it becomes tasks.
---
1. Ground it: sync_repo, read the code and any existing specs/styleguides the design touches, and list_issues (`compact: true`) for related work.
2. Ask the 2-4 questions that change the design, then draft the spec in chat: goal, non-goals, design, interfaces, failure modes, open questions, and how each part will be verified.
3. Deliver it as an issue labelled `spec` (create_issue, after the user agrees) or as a download with generate_file. You cannot commit it to the repo; getting a spec into the repo is a docs task for the loop.
4. Offer to continue with the plan-feature skill to break the spec into epics and tasks.
