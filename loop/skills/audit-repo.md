---
name: audit-repo
description: The user wants the repo analysed - "audit", "review the code", "find problems", "what is missing", "propose a backlog from the code". Reads code, reports findings with evidence, then proposes issues.
---
1. Call sync_repo once, then survey: README, specs, manifests, entry points, tests, CI; grep for TODO|FIXME|HACK and skipped tests. Read the files behind every finding.
2. Report findings in chat, ranked by impact, each with `path:LINE` evidence and a short verbatim snippet. Mark anything inferred as "inferred". Never paste secrets; describe them and cite the location.
3. Call list_issues (`compact: true`, state all) so an existing open issue is referenced instead of duplicated.
4. Propose the backlog as in the plan-feature skill (outline first, then create_issues ONCE after the user agrees). End each analysis-derived issue body with "_Analyzed at commit <short sha> on <ref>._"
5. Prefer fewer, sharper tasks. If the user only wanted the analysis, stop after step 2.
