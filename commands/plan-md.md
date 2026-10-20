---
description: Write or revise this project's PLAN.md — five house sections, and a "Done looks like" whose every line is checkable by a command. Use when starting a project, or when the plan no longer matches what is being built.
argument-hint: "<what we are building, in a sentence>"
allowed-tools: Read, Edit, Write, Bash(~/.claude/pulse/bin/pulse-plan:*), Bash(git *)
---

# Write the plan

Write or revise `PLAN.md` at the repository root, for: `$ARGUMENTS`

`PLAN.md` is the one convention file nothing else maintains for you — `PROGRESS.md` has `/handoff`
and `/verify` appending to it, `TASKS.md` has the house-files skill — and a plan written once and
never revisited is how the other two end up describing work nobody agreed to.

Current state of this project's plan, from Pulse:

!`~/.claude/pulse/bin/pulse-plan show`

## The sections, and the only difficult one

Follow `~/.claude/pulse/templates/PLAN.md`. Five sections, and four of them are easy.

**"Done looks like" is the hard one.** Every line is an outcome that can be checked, by a command
where possible, written as `- [ ] <outcome> — `<command>``:

- Good: `- [ ] The retry path is covered and passes — `npm test``
- Good: `- [ ] Opening the app with no claude on PATH names where it looked — `npm run smoke``
- Not good: "authentication is robust".
- Not good: "the UI feels responsive".

If an outcome cannot be checked, it is a hope. Either sharpen it until it can be, or move it to
**Why** — which is where motivation belongs and where nobody will later mistake it for a
deliverable. An outcome that genuinely cannot be checked by a command may stay, with no
backticks, and Pulse reports it as uncheckable.

**Never tick a line here.** `/verify` ticks, when the command exits 0. Pulse watches this file and
will contradict a tick whose command fails.

## Out of scope earns its section

Write down what this project is deliberately not doing. It is the cheapest section to write and
the one that saves the most, because drift is easier to refuse when somebody already refused it
in writing.

## Revising rather than starting again

If `PLAN.md` exists, edit it in place and keep the `<!-- pulse -->` marker. Say in your report
which outcomes changed and why — a plan quietly rewritten to match what got built is a plan that
can no longer disagree with anything, and its whole value is that it can.

Ask before rewriting a plan that clearly still holds. Adding to it needs no permission.
