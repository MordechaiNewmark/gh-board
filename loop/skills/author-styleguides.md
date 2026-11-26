---
name: author-styleguides
description: The user wants the repo's conventions written down for the agents - "add styleguides", "document our conventions", "set up lint rules for the loop". Uses the loop's author-styleguides flow and lands nothing until the user ratifies.
---
1. Explain that styleguides are the conventions decompose fits tasks to, implementers follow and reviewers enforce, so contested choices need the user's decision.
2. Run run_loop_skill with skill `author-styleguides`, optionally args = a stack (`python`). It detects the stack, observes existing conventions and proposes them in a pull request.
3. Report the PR and list the decisions the user must make. Remind them that repeated corrections belong in the gate (a lint rule, a type, a test) more than in prose.
