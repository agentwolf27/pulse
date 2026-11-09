# Pulse — PLAN

<!-- pulse -->

> How progress on this project is tracked. Pulse reads this file: a `- [ ]` under a `##` heading
> is one item, a `## heading` is a phase, and the percentage is ticked ÷ total. Tick something
> when it is genuinely done, not merely attempted.

**Goal.** A 24/7 progress bar for every running Claude chat: what is being built, in plain words,
and how far along it is — in the statusline, the menu bar, and one dashboard.

## Plumbing

- [x] Hook dispatcher on all six events, never blocking Claude
- [x] Statusline renderer, one file read, under 20 ms
- [x] State file per session, written atomically
- [x] Installer that merges into settings.json without touching other keys, and a clean uninstall

## Brain

- [x] Transcript window with a byte cursor, so an 83k-line chat is never re-read
- [x] Turn compression: tool calls become one line each
- [x] Goal card from Haiku — goal, phases, now-line, mode
- [x] Sticky phase names and a monotonic guard, so the bar does not jitter
- [x] Two backends: direct API when a key exists, headless `claude -p` otherwise
- [x] Read the project's own plan file and score against it instead of inventing phases

## Dashboard

- [x] Zero-dependency local server on 127.0.0.1
- [x] One row per project, sorted by what needs attention
- [x] Expand a row for phases, next-up items and the chats underneath
- [x] Cost by project by day, booked to the day the spend happened

## Judgment

- [x] Needs-you, looping, context-pressure, subagent and done signals
- [x] Loop detection that ignores healthy iteration and only fires on repeated failure
- [x] Goal-card snapshot before compaction
- [x] macOS notifications with a per-state cooldown

## Project tracking

- [x] Resolve a chat's folder to its project, folding git worktrees into one repo
- [x] Parse PLAN.md into a percentage and phases
- [x] Refuse to count a file whose checkboxes are prose rather than a plan
- [x] Ignore placeholder items and nested category labels
- [x] Inject the plan into every session so Claude keeps it ticked
- [x] `pulse-plan init` to seed a plan for a project that has none
- [x] Seed plan files for the projects that still have none

## Autoplan

- [x] Read the house convention: `## Done looks like` outcomes, and house TASKS.md tables
- [x] Read OpenSpec, Spec Kit and GSD task files if a project uses one
- [x] Birth rule: seed PLAN.md on the first edited-file reply in a plan-less git repo, never on merely opening a folder
- [x] Decline to seed when the chat is not about the repository
- [x] Drift: flag a plan that is behind the work, and nudge once per half hour through the Stop hook
- [x] `pulse-plan draft` writes a reviewed plan from README, git log, docs and chat history, ticking what the evidence shows
- [x] `pulse-plan reconcile` proposes ticks with evidence; Pulse never ticks on its own
- [ ] Review the plans `pulse-plan draft` wrote for existing projects and fix what they got wrong — reviewed by eye

## Orchestration

- [x] `pulse-plan verify` runs each outcome's VERIFY, refuses destructive commands, ticks only on exit 0, flags regressions — `~/.claude/pulse/bin/pulse-plan verify --dry-run . | grep -q 'would run'`
- [x] Tick-guard: a PostToolUse hook contradicts a tick whose VERIFY fails, in-turn — `jq -e '.hooks.PostToolUse | length >= 2' ~/.claude/settings.json`
- [x] `plan-reviewer` subagent and `/pulse-review`: the reviewer is never the writer — `test -f ~/.claude/agents/plan-reviewer.md`
- [x] `pulse-plan next` prints a `/goal` that demands the VERIFY be shown — `~/.claude/pulse/bin/pulse-plan next . | grep -q '^/goal'`
- [x] The house workflow at user level: `/plan-md` `/verify` `/state` `/handoff` `/decision`, skills `house-files` and `plan-together` — `ls ~/.claude/commands/verify.md ~/.claude/skills/house-files/SKILL.md`
- [x] The eleven-line house rule in `~/.claude/CLAUDE.md` — `grep -q '^# House workflow' ~/.claude/CLAUDE.md`
- [x] Nudge uses Stop `additionalContext`, not `decision: block` — `grep -q 'hookEventName: "Stop"' ~/.claude/pulse/bin/pulse-hook`

## AI quality (draft)

> **Draft, 2026-11-09. Items 0–2 built 2026-11-09 (branch `ai-health-needs-you`); 3–4 built 2026-11-09 (branch `ai-number-goal`); 5–6 built 2026-11-09 (branch `ai-phases-cost`).** On the 40% target: the new gate skips read-only replies and waits instead of dropping work, but that saves only ~3% of calls on the demo replay set and ~10.6% on two months of real use (same median lag). Replies are ~6 min apart and most change something, so 40% fewer calls would need longer waits between updates or fewer updates per reply. The target needs a decision; until then line 6 stays unticked. Proposed after reading two months of the analyser's own log and state files. Findings: 17% of analyser runs failed on an expired sign-in with nothing shown; "needs you" fires only on AskUserQuestion; goals stop following long chats; 25 of 35 chats at 100% got there on Claude's word alone; plan-tracked chats show "Done looks like" as their only phase; blockers are found but never displayed. Numbers match the mockup; the replay harness is step 0. The number still comes from PLAN.md ticks first, and `/verify` is unchanged.

- [x] 0 · A replay harness runs saved chats through compress, prompt and merge with recorded model answers, with no network calls — `node lib/eval.js --baseline`
- [x] 1 · When the analyser's sign-in expires or it hits a limit, it backs off 10 minutes, all three views say "AI paused" with the fix, and a card older than the latest reply is marked stale — `node lib/eval.js --suite health`
- [x] 2 · A permission prompt or a closing question in Claude's reply flags the chat as waiting on you, and the question text is shown — `node lib/eval.js --suite needs-you`
- [x] 2 · Blockers the analyser already finds are shown on the dashboard — `grep -q 'class="blockers"' lib/dash.html`
- [x] 3 · Every % names its source; an AI estimate rises at most 25 points per update and reaches 100% only with evidence (a test run, a commit, or all todos done) — `node lib/eval.js --suite number`
- [x] 3 · Talk-only chats show no % anywhere, the menu bar's chat lines included — `node lib/eval.js --suite modes`
- [x] 4 · The goal follows the chat: a scope change updates it, the old goal is kept as history, and it stays at 12 words or fewer — `node lib/eval.js --suite goal`
- [x] 5 · Plan headings with no checkboxes stop showing as phases, and a single "Done looks like" list is grouped into 3–5 display-only stages; the % stays ticked ÷ total — `node lib/eval.js --suite phases`
- [ ] 6 · At least 40% fewer analyser calls on the replay set, with the median update lag no worse than today's — `node lib/eval.js --suite cost`
- [x] 6 · The dashboard shows the analyser's own spend apart from the chats' spend — `grep -q 'data-ai-spend' lib/dash.html`
- [ ] Decide whether the API path moves from Haiku 4.5 to Haiku 5.5, once the replay shows how they compare
- [ ] Bring the installed copy in line with this repo before building: six files differ in wording, the analyser files match

## Still open

- [ ] Decide whether a chat should show its own progress or its project's when they differ
- [ ] Live with it for a week and cut whatever is not being read

---

Non-goals and anything Pulse should ignore can live under a `## Non-goals` heading.

## Non-goals

- Ticking a box on Pulse's own judgment — Pulse runs VERIFY commands and refuses to believe a tick they contradict, but only `/verify --apply` and a person tick
- A manager session dispatching worker agents — the desktop app's worktree-per-session and `/pulse-review` cover a solo developer without the coordination cost
- A per-turn LLM judge on every Stop in every session — `reconcile` on demand and `/goal` per session are the two places a model's judgment earns its cost
- Replacing the plan file with a database; the markdown is the source of truth
