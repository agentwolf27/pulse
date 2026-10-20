# Pulse

A progress bar for every running Claude Code chat. Pulse reads each conversation, says in plain
words what is being built, and puts a 0–100% number on it. You see it in three places: the Claude
Code statusline, a macOS menu-bar item (through SwiftBar), and a local dashboard that lists every
session on one page.

```
⚡  62% ▰▰▰▰▰▰▱▱▱▱  Ship the login page            ⏱ 41m · $3.18 · Opus
Setup ✓ · Form ✓ · API route ◐ 60% · Tests ○   › now: running the tests
```

It also flags the sessions that need you: `⏸ needs you` when Claude asked a question,
`↻ looping` when the same call has failed three times, `▮ context` when the window is nearly full,
and `✓ done`.

## Requirements

- macOS. The scripts use `stat -f`, `osascript` and `defaults`.
- [Claude Code](https://docs.claude.com/en/docs/claude-code).
- `jq` and Node 18 or newer. Pulse has no npm dependencies.
- [SwiftBar](https://swiftbar.app), if you want the menu-bar item. It is optional.

## Install

```bash
git clone https://github.com/agentwolf27/pulse.git
cd pulse
./install.sh
```

`install.sh` does the following:

- backs up `~/.claude/settings.json`, then merges in the statusline and the hooks without touching
  your other keys;
- symlinks `~/.claude/pulse/bin`, `templates` and `menubar` to this checkout, so you can keep the
  clone anywhere;
- copies the slash commands, the two skills and the `plan-reviewer` agent into `~/.claude/`;
- starts the dashboard at `http://127.0.0.1:7788`.

Pulse appears in sessions you start after installing. `./uninstall.sh` removes exactly what the
installer added and leaves your session state in `~/.claude/pulse/state`.

### The menu bar (SwiftBar)

```bash
brew install --cask swiftbar
```

When SwiftBar first opens and asks for a plugin folder, choose `~/.claude/pulse/menubar`. Then run
`./install.sh` again so it notices SwiftBar. If SwiftBar already uses a different plugin folder,
the installer links `pulse.5s.sh` into that folder instead. Set `PULSE_MENUBAR_OFF=1` to make the
installer, the uninstaller and the hooks leave SwiftBar alone.

The title shows `⏸ 1` / `↻ 1` / `▮ 1` when something needs a look. Otherwise it shows a five-cell
bar of the average progress and the number of live sessions. The dropdown lists each project, with
its chats underneath. It refreshes every 5 seconds and reads the dashboard's JSON, so the
dashboard has to be running. Every new Claude session starts the dashboard if it is not running.

## What it costs to run

The statusline, hooks, health signals and dashboard are free: they are local shell and Node code
with no network calls. Only the analyser, which writes the goal card (goal, phases, now-line),
calls a model. It runs in the background after Claude replies, at most once every 15 seconds per
session and at most two at a time on the machine.

| Backend | When | Speed | Cost per analysis |
|---|---|---|---|
| Anthropic API, Haiku | `ANTHROPIC_API_KEY` is set in the environment Claude Code runs in | ~2 s | ~$0.006 |
| `claude -p --model haiku` | no API key: uses your Claude subscription | ~6 s | ~$0.015 at API prices, counted against your plan's usage rather than billed |

A busy day of about 100 replies costs about 60¢ through the API. The headless `claude -p` call runs
with no tools, plugins, hooks or MCP servers and with thinking turned off, so each call stays small.

Two commands use a model only when you run them: `pulse-plan draft` (Sonnet, a few cents per plan)
and `pulse-plan reconcile` (Haiku).

To turn things off: `touch ~/.claude/pulse/notify.off` stops notifications,
`touch ~/.claude/pulse/autoplan.off` stops automatic `PLAN.md` creation, and
`touch ~/.claude/pulse/nudge.off` stops the plan-behind reminder.

## Where the number comes from

In priority order:

1. **The project's own plan file** (`PLAN.md`, `ROADMAP.md`, `TASKS.md`, …): ticked items divided
   by all items. The number does not move when a chat ends, and every chat in the repo shares it.
2. **Claude's `TodoWrite` checklist**, when the session has one.
3. **Haiku's estimate** from the conversation.
4. **A capped heuristic** from edits, passing tests and commits, used until one of the above is
   available.

Pulse only counts a plan file that looks like a plan. A `- [ ]` under a `##` heading is one item,
and a `##` heading is a phase. If the checkboxes look like part of a longer document (under 8% of
the lines, fewer than 3 items, or all under one heading), Pulse does not count the file. Put
`<!-- pulse -->` in a file to count it anyway. Placeholder items (`- [ ] TBD`) are not counted.
When checkboxes are nested, only the outermost level counts.

Pulse also reads OpenSpec (`openspec/changes/*/tasks.md`), Spec Kit (`specs/*/tasks.md`) and GSD
(`.planning/ROADMAP.md`) task files. Checkbox states are `[x]` done, `[~]` half done, and `[-]`
skipped (not counted).

```bash
~/.claude/pulse/bin/pulse-plan               # this project's plan and progress
~/.claude/pulse/bin/pulse-plan init          # a blank PLAN.md from templates/
~/.claude/pulse/bin/pulse-plan draft         # a PLAN.md written from the README, git log, docs and past chats
~/.claude/pulse/bin/pulse-plan reconcile     # suggest which open items to tick, with evidence
~/.claude/pulse/bin/pulse-plan verify        # run each outcome's VERIFY command
```

You can run the same commands from a chat: `/pulse plan`, `/pulse plan draft`, `/pulse goal <text>`,
`/pulse phases A, B, C`, `/pulse reset`.

## Claims are checked

Each outcome in `PLAN.md` ends with the command that proves it:

```markdown
- [ ] Booking submissions survive a storage outage — `npm test -- booking`
```

- `pulse-plan verify [--apply]` runs every outcome's command from the repo root. It refuses
  commands that look destructive, ticks an outcome only when its command exits 0, and reports a
  ticked outcome whose command now fails.
- **Tick-guard** is a `PostToolUse` hook. When Claude ticks an outcome, it runs that outcome's
  command, and if the command fails it tells Claude straight away. Pulse never unticks anything
  itself.
- `/pulse-review` gives the diff to a separate `plan-reviewer` subagent that did not write the
  code. The reviewer runs each check and reports what passed and what did not.
- Pulse never ticks a box based on its own judgment.

Pulse also installs house-workflow commands that work in any repo: `/plan-md`, `/verify`, `/state`,
`/handoff` and `/decision`. It also installs the `house-files` and `plan-together` skills. The
templates for `PLAN.md`, `TASKS.md`, `PROGRESS.md` and `DECISIONS.md` are in `templates/`.

## How it works

- **Hooks** (`bin/pulse-hook`) run on `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`,
  `PreCompact` and `SessionEnd`. Each one reads the hook JSON, updates the session's state file and
  exits. The hooks never block Claude, make no network calls, and always exit 0. On `Stop`, the hook
  reads only the transcript bytes added since the last run and forks the analyser into the
  background.
- **State** is kept in `~/.claude/pulse/state/<session_id>.json` and written atomically. All runtime
  data (state, logs, the cost ledger) stays in `~/.claude/pulse` and never in this repo.
- **The statusline** (`bin/pulse-status`) reads that one file and prints two lines in about 20 ms.
- **The analyser** (`lib/analyze.js`) compresses the recent turns and asks Haiku for a goal card.
  Phase names stay fixed, a phase's percentage never goes down, and the overall number drops by at
  most 5 points unless the goal changed. The prompt is in `lib/prompt.md`, which you can edit.
- **The dashboard** (`lib/dash.js`) is a zero-dependency server that listens only on 127.0.0.1. It
  groups sessions by project, with git worktrees counted as part of their main repo, and keeps a
  cost-by-project-by-day ledger. Set `PULSE_PORT` to change the port.

## Check that it's working

```bash
tail -f ~/.claude/pulse/pulse.log
```

```bash
~/.claude/pulse/bin/pulse-dash open
```

```bash
~/.claude/pulse/bin/pulse-analyze --dry-run <session_id>
```

The last command prints the prompt the analyser would send, without calling a model.

## Layout

```
bin/pulse-hook      hook dispatcher (bash + jq)
bin/pulse-status    statusline renderer (bash + jq)
bin/pulse-dash      dashboard launcher (start / stop / open / status)
bin/pulse-analyze   analyser launcher
bin/pulse-notify    macOS notification with a per-key cooldown
bin/pulse-goal      show / set / lock / reset a session's goal card
bin/pulse-plan      read the plan; init, draft, verify, reconcile, or print a /goal
lib/analyze.js      transcript window → Haiku → goal card → state
lib/prompt.md       what Haiku is asked
lib/plan.js         project resolution (folds worktrees) and plan / task-table parsers
lib/draft.js        pulse-plan draft and reconcile
lib/verify.js       pulse-plan verify, and the tick-guard
lib/dash.js         dashboard server
lib/dash.html       dashboard page
menubar/pulse.5s.sh SwiftBar / xbar plugin
commands/           /pulse · /pulse-review · /plan-md · /verify · /state · /handoff · /decision
skills/             house-files · plan-together
agents/             plan-reviewer
templates/          PLAN.md · TASKS.md · PROGRESS.md · DECISIONS.md
install.sh          merge into ~/.claude/settings.json, start the dashboard
uninstall.sh        remove exactly what install.sh added
```

## License

MIT. See [LICENSE](LICENSE).
