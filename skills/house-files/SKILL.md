---
name: house-files
description: The contracts for a project's PLAN.md, TASKS.md, PROGRESS.md and DECISIONS.md — how an outcome, a task, a progress entry and a decision are written so they can be checked. Use whenever adding a task, marking something done, recording progress, or writing an outcome.
---

# The house files

Every project keeps the same files at its root. Pulse reads them; `/verify`, `/state`,
`/handoff` and `/decision` write them. Create a missing one from `~/.claude/pulse/templates/`.

| File | What it is | Who writes it |
|---|---|---|
| `PLAN.md` | What we are building and why, and what done looks like — as checkable outcomes | `/plan-md`; ticks only by `/verify` |
| `TASKS.md` | The live task list, with an owner and a VERIFY per task | anyone dispatching or picking up work |
| `PROGRESS.md` | Append-only. What happened, when, by whom, with evidence | `/verify`, `/handoff`, anyone finishing work |
| `DECISIONS.md` | Append-only. Each choice, its rejected alternative, its status | `/decision` |

## An outcome (PLAN.md, under `## Done looks like`)

```markdown
- [ ] Booking submissions survive a storage outage — `npm test -- booking`
```

One line: the outcome, an em dash, the command in backticks. It is ticked `[x]` only when that
command exits 0 — by `/verify`, never by hand because it seems done. Pulse watches this file and
will contradict a tick whose command fails. `[~]` means half done; `[-]` means dropped and not
counted. An outcome nobody can check by a command may stay with no backticks; it counts as
uncheckable. Placeholders (`TBD`, `_first step_`) are not outcomes and are not counted.

## A task (TASKS.md)

```markdown
| # | Task | Owner | VERIFY |
|---|------|-------|--------|
| 7 | Cap the token refresh retry | claude | `npm test` exits 0 |
```

Under `## In progress`, `## Queued` or `## Done` (Done adds a `Completed` column with the date).

**The VERIFY column is a command, not a verdict.** Write what should be run, in backticks; the
first backticked span is the runnable part:

- `` `npm test` exits 0 `` · `` `npm run typecheck` is clean `` · `` `grep -q "coming soon" site/index.html` ``

Do **not** write the outcome — ~~PASS, I read the file and it looks right~~ — that replaces the
check with a claim, which is the thing the rule exists to refuse. An agent writing "PASS" into
the column that was supposed to settle whether it passed is marking its own homework.

When it genuinely cannot be a command, say so in plain words with **no backticks** — *reviewed
by eye*, *somebody opens it in a browser* — so it is reported as **uncheckable** rather than
run. Give a task like that an owner who is a person: `user` is a valid owner.

The command has to **fail when the work is wrong**. `ls the-file-i-made` proves the file exists
and nothing about whether it is right; `grep -q "what it must say" the-file` proves something.
One command per VERIFY — no `;`, `&&` or `|`.

Owner is `claude`, `user`, or the name of a subagent or teammate. A task moves
`## In progress` → `## Done` **only when its VERIFY has passed.** Nothing moves because it
feels finished.

## A progress entry (PROGRESS.md)

```markdown
## 2026-09-03 — claude

Capped the token refresh retry at five attempts and made an expired token report as a failure
rather than a successful run.

Evidence: `npm test` — 318 passing, including two new cases for the expiry path.
```

Append-only, newest at the bottom, never rewritten — a correction is a new entry naming what it
corrects. Three things in order: **who and when**, **what actually happened**, **what the
evidence was**. Belongs here: a decision and why; something that turned out to be true and was
not obvious; work finishing, with the check; work **not** finishing, and what blocked it.
Not here: narration of the work as it happens (that is the transcript's job), anything you did
not do, relative dates.

An entry that says work is done and does not say how that was established is a claim. Paste
the command and the real result:

- Good: `Evidence: \`npm run typecheck\` — clean on both configs.`
- Good: `Evidence: none. The check could not run because Bash was refused.`
- Not good: "Verified and working."

The second is a perfectly good entry. Saying you could not establish something is information.
Saying you established it when you did not is the one thing that makes the whole log worthless.

## A decision (DECISIONS.md)

`## D<n> — <title> · <status> · <who> · <date>`, the decision, `*Reason:*` with the alternative
it beat, `*Revisit if:*`. Status `settled` · `taken` · `contested` · `open`. Append-only;
supersede, never edit; contest by appending `### Challenge — D<n> — <who>`. See `/decision`.

## Two standing rules

**Claims are verified, not believed.** An agent saying "done" does not make it done; the VERIFY
exiting zero does. "Uncheckable" is a respectable answer. "PASS" written by the agent whose work
is being checked is not.

**Absent is not empty.** A file you could not read is not an empty file. A missing directory is
not "nothing to do". When you cannot read something, say you could not read it.
