---
name: plan-together
description: Argue a plan out before anybody builds — first generate genuinely different options blind, then critique them one voice at a time in PLAN.md, then freeze. Use when the shape of the answer is not obvious, or before dividing work on anything bigger than a day. Pass the question or the frames — `plan-together how should sessions be stored` or `plan-together frontend backend tester`.
---

# Planning together

A plan one person wrote and everybody agreed to is a plan nobody checked. This is how a plan
gets **disagreed with** before it costs anything. Two phases, and they are opposites.

```
DIVERGE   one Agent per frame, each blind to the others      → options that cannot anchor on each other
CONVERGE  one critic reads all of them at once               → scores, names traps, clusters
SEED      the survivors become the opening draft of PLAN.md
ARGUE     round 1  frontend → backend → tester, each reads what came before, then appends
          round 2  …                                          until a full round adds nothing
FREEZE    you veto, or you sign                              → PLAN FROZEN. Only then divide work.
```

| | reading the others is | because |
|---|---|---|
| diverge | **fatal** | you are *generating*, and a second idea that has read the first is a variation of the first |
| argue | **required** | you are *arguing*, and an argument needs the previous turn |

Getting these the wrong way round gives you three first impressions and one anchored plan — the
worst of both. Generate blind, then argue in sequence.

## Diverging — when the answer is not obvious

The first idea a model has is the one every later idea gets anchored to. Ask for five approaches
in one turn and you get one approach and four variations of it wearing different words. The fix
is mechanical: dispatch **one `Agent` per frame, all in one turn**, giving each *only* its own
frame. Do not tell a branch what the others were asked. Do not run them in sequence to save
tokens — sequence is the thing being avoided. Ask each for two or three sketches, not one.

A frame is a vantage point, not a topic:

**frontend** — what a stranger tries first · what this feels like at 300 ms · what it looks like
when the data is empty, enormous, or broken · what somebody does by accident
**backend** — the data shape this implies · how it fails · what is irreversible · what happens at
100× · what two of these racing looks like
**tester** — how would this lie · what passes once and is still broken · what cannot be checked
by any command · what somebody would fake to make it green
**reviewer** — what will be expensive to change later · what nobody will read again · what this
makes impossible
**manager** — who is not in the room · what we are choosing not to build · what this costs on
every turn, forever

Five sharp frames beat fifteen generic ones. Then one critic pass, reading everything at once —
its job is **not** to pick a winner: score each sketch on how different, buildable and on-brief it
is; **name the traps** and why each is seductive; **cluster** sketches that are one idea in
different clothes; deepen the survivors into something concrete enough to argue with.

Write the clusters, the traps and the rejected options — one line each on why not — into
`PLAN.md` under `## Options considered`, as bullets, never checkboxes. The rejected options are
the point: a plan that lists only what was chosen is indistinguishable from one where nothing
else was thought of. Skip this phase when the answer is obvious; a critic asked to find traps in
a decision that has none will invent some.

## Arguing — one at a time, never fan out

You will be tempted to dispatch all three critics at once — it is three times faster and it is
wrong. **An agent that cannot read the previous critique cannot disagree with it**, and
disagreement is the entire feature. Three parallel reviews give you three first impressions;
three sequential ones give you an argument, where the tester gets to say *"the thing backend just
proposed cannot be verified by any command I can write."* That sentence is the whole value and it
is unreachable in parallel.

Subagents cannot see each other's context, so they talk **through the file**. That is not a
workaround; an argument conducted in a file is one somebody can read afterwards and check. Give
every dispatch the path and nothing pasted:

```
OBJECTIVE  — read PLAN.md including every critique already appended, then append yours as
             `### <frame> · round N`
OUTPUT     — that section, in that file. Nothing else in the file changes.
TOOLS      — Read, Edit
BOUNDARIES — argue only your own field. Do not rewrite anybody else's section. Do not implement
             anything. End with `TURN: <the next frame>`.
VERIFY     — `grep -c '### <frame> · round N' PLAN.md` returns 1
```

**The tester is the most valuable seat and the easiest to leave empty.** Every outcome has to be
checkable by a command; the tester is the only one who will tell you which of yours is not, and
will tell you now rather than after somebody builds it.

Stop **when a full round adds no new objection** — not after a fixed count, which manufactures
disagreement in the last round. Cap it at four. If it is still moving after four, the plan is too
big to agree on; split it.

## You sign it

Everyone agreeing is the ordinary outcome, not the rule. **You hold the veto**, and should use it
when the room converges on something you think is wrong — a consensus you disagreed with and
approved anyway is worse than a decision you made alone, because it has more names on it.

When you sign, mark it in `PLAN.md`:

```
PLAN FROZEN: 2026-09-03 — agreed by frontend, backend, tester. Signed <who>.
```

**Do not divide work until that line exists.** Dispatching against an unfrozen plan is how you
get three people building against three different readings of the same paragraph.

## What this skill does not do

- **It does not build anything.** Not one line. The plan is the output.
- **It does not summarise the argument away.** The rounds stay in the file underneath the plan.
  They are the record of how it was reached, and the first thing worth reading when somebody
  later asks *"why is it like this?"* Pulse ignores them when counting.
