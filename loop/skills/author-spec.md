---
name: author-spec
description: The user wants a spec for a subsystem landed in the repo as a reviewed document - "write the spec for object storage into the repo". Uses the loop's author-spec flow (pins, grounding, docs review, a PR). For a draft kept in chat or an issue use write-spec.
---
1. Gather the pins the spec depends on by asking the 2-4 questions that change the design. Name the subsystem exactly.
2. Run run_loop_skill with skill `author-spec` and args = the subsystem (for example `object storage`). It opens a pull request with the spec; the human gates are the draft nod and the backlog approval, which are the user's.
3. Report the PR and the spec's open questions. Offer decompose once the spec PR is merged.
