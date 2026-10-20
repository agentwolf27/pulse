---
description: Write the brief for whoever picks this up next — what is true, what is in flight, what is blocked, what was tried and failed, and the one thing to do first. Use before stopping, before a long gap, or when handing work to somebody else.
argument-hint: "[anything the next person needs that is not on disk]"
allowed-tools: Read, Edit, Write, Bash(git *), Bash(~/.claude/pulse/bin/pulse-plan:*)
---

# Hand it over

Write the brief for whoever continues this work. Anything in `$ARGUMENTS` is context the next
person needs that is not already on disk — include it, and put the rest of the brief together
from the files.

Every session starts cold. The next one reads `PLAN.md`, `PROGRESS.md` and `TASKS.md` and
nothing else, so anything living only in this conversation is about to be lost — and the most
expensive part of resuming work is not the code, it is reconstructing what the last person
already knew and already ruled out.

Where Pulse thinks the project stands:

!`~/.claude/pulse/bin/pulse-plan show`

## What the brief contains

**Where the work actually is.** Not "in progress" — which outcome, which files, and what state
they are in. Half-finished is a legitimate answer and a much more useful one than a summary
that rounds it up.

**What is blocked, and on what.** Name the blocker. "Waiting on a decision about the storage
format" is actionable; "blocked" is not.

**What was tried and did not work.** The single highest-value paragraph in any handoff, because
it is the only part nobody can reconstruct from the repository. An approach abandoned for a
good reason will otherwise be attempted again by the next person, at full price.

**The one thing to do first.** Not a list. The next action.

## Where it goes

Append it to `PROGRESS.md` as a dated, signed entry — it is a record of where things stood,
which is exactly what that file is for, and it means the handoff is on disk rather than in a
message somebody has to still have open. Create the file from
`~/.claude/pulse/templates/PROGRESS.md` if it does not exist.

If the work is stopping mid-task, make sure `TASKS.md` says so too. A task sitting in
`## In progress` with nobody working on it is the file claiming somebody is at work when nobody is.

## Say what you did not check

If the tests were not run, say they were not run. A handoff that overstates how finished the
work is costs the next person the time it takes to discover otherwise, plus the time they spent
building on it first.
