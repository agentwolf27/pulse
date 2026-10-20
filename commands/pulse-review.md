---
description: Fresh-context review of the current diff against PLAN.md's outcomes, running each VERIFY — the reviewer is not the writer
allowed-tools: Agent, Bash(git *), Bash(~/.claude/pulse/bin/pulse-plan:*)
---

Review this project's work against its plan with a reviewer that did not write it.

Use the Agent tool with `subagent_type: plan-reviewer`. Give it: the repository root, the plan file path from `~/.claude/pulse/bin/pulse-plan json` (field `plan.file`), the base to diff against ($ARGUMENTS if given, otherwise the merge-base with `dev`, else `main`), and this instruction: "Review the diff against the plan's Done-looks-like outcomes; run each outcome's VERIFY; report proven / not proven / uncheckable / out of scope with evidence; recommend which lines to tick or untick."

When it returns, relay its findings in full, then — only if it proposed ticks — apply them with `~/.claude/pulse/bin/pulse-plan verify --apply` (which ticks only outcomes whose VERIFY exits 0) and show the result. Never tick an outcome the reviewer marked not proven or uncheckable.
