---
description: Run a task's or outcome's VERIFY command and report what actually happened. Ticks the outcome or moves the task to Done only if the command exits zero. Use before claiming any piece of work is finished.
argument-hint: "<task number, outcome number, or part of its title — omit for everything open>"
allowed-tools: Read, Edit, Bash(~/.claude/pulse/bin/pulse-plan:*), Bash(*)
---

# Check the claim

Run the VERIFY for `$ARGUMENTS`. With nothing there, run every open outcome in `PLAN.md` and
every task under `## In progress` in `TASKS.md`.

Claims are verified, not believed, and this is the verb for it. An agent saying "done" does not
make a task done; the command in the VERIFY exiting zero does.

## PLAN.md outcomes — Pulse runs these deterministically

!`~/.claude/pulse/bin/pulse-plan verify`

That ran every outcome's backticked command from the repository root and refused anything that
looked destructive. If it shows failures, those outcomes are not done, whatever the code looks
like. To tick the ones that passed:

```
~/.claude/pulse/bin/pulse-plan verify --apply
```

## TASKS.md rows — you run these

1. **Find the task** and read its VERIFY column verbatim.
2. **Take the first backticked command** — that is the runnable part. If there is no backticked
   command, stop: this task is **uncheckable**, say so plainly, and leave it where it is.
3. **Run it, from the repository root.** Do not adapt it, do not run something similar, do not
   substitute a narrower test because the real one is slow.
4. **Report the exit code and the output**, both, whether it passed or not.

| Outcome | What to do |
|---|---|
| Exit zero | The task may move to `## Done`, with today's date in the Completed column. |
| Non-zero exit | It stays in `## In progress`. Paste the failure. Do not describe it. |
| Refused or not permitted | Report it as **not checked** and name the command. A refusal is a fact about the workspace, not about the work. |
| No command in the VERIFY | Report it as **uncheckable**. That is a respectable answer. |

Nothing here is a judgement call. If you find yourself weighing whether a failure "really"
counts, the answer is that it counts.

## Afterwards

Append what happened to `PROGRESS.md` as a dated, signed entry, with the command and its real
result — including failures. An entry recording that a check failed is worth more than one
recording that it passed, because it is the one somebody would otherwise have to rediscover.
If `PROGRESS.md` does not exist, create it from `~/.claude/pulse/templates/PROGRESS.md` first.
