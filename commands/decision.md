---
description: Record a decision in DECISIONS.md with the alternative it beat and why — or, with "gotcha", something that bit us and how to recognise it next time. Use the moment a choice settles, or right after losing time to a surprise.
argument-hint: "<what was decided, and why>  ·  or  gotcha <what bit us>"
allowed-tools: Read, Edit, Write, Bash(git log *)
---

# Record it

Write down: `$ARGUMENTS`

Decisions are the thing transcripts are worst at keeping. The reasoning happens across twenty
messages, the conclusion lands in one, and six weeks later somebody re-opens the question
because the only surviving artifact is the code, which says what was decided and never why.

## Where it goes

`DECISIONS.md` at the repository root, **append-only**, newest at the bottom. Create it from
`~/.claude/pulse/templates/DECISIONS.md` if it does not exist. Each entry:

```markdown
## D7 — Sessions are per project, not per agent · settled · claude · 2026-09-03

Each project tab owns one session, and every agent in that project runs inside it.

*Reason:* the alternative was a session per agent, which reads better on paper and loses the
shared context that makes verification possible — a checker would have to re-read everything
a worker did in order to check it.

*What this gives up:* per-agent isolation. *Revisit if:* a single session's context becomes
the bottleneck.
```

Status is one of `settled` (argued and stands) · `taken` (decided by one person, contestable) ·
`contested` (a challenge is open) · `open` (nobody has decided). Number it after the last entry.

**The alternative you rejected, and why.** A decision recorded without its discarded option is
a preference; with it, it is an argument somebody can re-examine when the constraints change.
A decision with no revisit trigger becomes dogma.

Never edit an earlier entry. Supersede it: a new entry `## D7 — SUPERSEDED by D12 · <who> · <date>`.
To contest one, append `### Challenge — D<n> — <who>` with the reason and, where possible, the
command that shows the problem, and flip that decision's status to `contested`. A contested
decision does not block work that does not depend on it; it blocks work that does.

## `gotcha` — something that bit us

Same file, same shape, named for the **symptom** rather than the cause — that is what the next
person will be searching for, because the cause is precisely the part they do not know yet.
Three things, and the last one is the point:

1. **What happened**, including the misleading part — what it looked like before you understood it.
2. **How to recognise it next time.** The symptom, not the diagnosis.
3. **What to do instead**, with a path to the code that does it.

A gotcha without the third is a war story. With it, it is the fix. Worth recording even when it
was your own mistake — especially then.

## What does not belong

- Anything still being argued. Record it when it is settled.
- The conversation around the decision. The decision, and its reason.
- Relative dates. `2026-09-03`, never "today" — these entries outlive the day.
