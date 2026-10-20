---
description: Reconcile PLAN.md, TASKS.md and PROGRESS.md against what is actually true on disk and in git, and fix the files rather than the story. Use on resume, when you have lost the thread, or before telling anybody the work is finished.
allowed-tools: Read, Edit, Bash(~/.claude/pulse/bin/pulse-plan:*), Bash(git *), Bash(*)
---

# What is actually true right now

Reconcile `PLAN.md`, `TASKS.md` and `PROGRESS.md` at the repository root against the repository
itself, and correct the files.

A plan is a claim about the world, and claims drift. Pulse reads these files and shows their
numbers in the statusline, the menu bar and the dashboard — so a stale plan is not untidy
bookkeeping, it is a UI telling you something that is not so.

## Establish, then write

1. **Read the three files.** `PLAN.md` for what done looks like, `TASKS.md` for what is
   outstanding, `PROGRESS.md` for what has already been established and when.
2. **Run every VERIFY, including the ticked ones.** Pulse just did that for `PLAN.md`:

!`~/.claude/pulse/bin/pulse-plan verify`

   A ticked outcome whose VERIFY does not pass now is the most important thing this command
   finds. Untick it, and say why on the line. Do the same by hand for every task in `## Done`
   in `TASKS.md`: run its first backticked command; if it fails, move it back to `## In progress`
   with a note.
3. **Look for work that happened and was never written down.** `git status`, `git diff` and
   `git log` since the plan was last edited show changes no outcome or task claims. That is as
   much a discrepancy as a claim of work that never happened. Pulse's reading of the same
   evidence:

!`~/.claude/pulse/bin/pulse-plan reconcile`

Then correct the files:

- Tick the outcomes whose VERIFY passed: `~/.claude/pulse/bin/pulse-plan verify --apply`.
- Add the outcomes and tasks that the working tree implies and nobody wrote.
- Append one dated entry to `PROGRESS.md` recording what the reconciliation found — including
  "nothing had drifted", which is a real and useful finding.

## What must not happen

Do not tick an outcome or move a task to `## Done` because the code looks right. Run the
VERIFY. If it cannot be run — the command is not permitted, the check needs a person — say
exactly that, and leave it where it is.

Report a count, not a narrative: how many checks ran, how many passed, how many lines changed,
and what could not be checked at all.
