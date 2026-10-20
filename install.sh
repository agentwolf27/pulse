#!/bin/bash
# Pulse — installer.
# Backs up ~/.claude/settings.json, merges in the statusline + six hooks (never
# touching your other keys), and symlinks ~/.claude/pulse/bin to this folder so
# a checkout path with spaces or colons never appears in a config string.
set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULSE_HOME="$HOME/.claude/pulse"
SETTINGS="$HOME/.claude/settings.json"
HOOK='~/.claude/pulse/bin/pulse-hook'
STATUS='~/.claude/pulse/bin/pulse-status'

mkdir -p "$PULSE_HOME/state"
chmod +x "$HERE"/bin/*
ln -sfn "$HERE/bin" "$PULSE_HOME/bin"

[ -f "$SETTINGS" ] || printf '{}\n' > "$SETTINGS"
backup="$SETTINGS.pulse-backup.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$backup"

prev_status=$(jq -r '.statusLine.command // empty' "$SETTINGS")
if [ -n "$prev_status" ] && [ "$prev_status" != "$STATUS" ]; then
  echo "note: replacing an existing statusLine command ($prev_status) — it is kept in the backup"
fi

tmp=$(mktemp)
jq --arg h "$HOOK" --arg s "$STATUS" '
  # add our entry for an event+matcher unless one with our command is already there
  def ensure(ev; m):
    .hooks[ev] = ((.hooks[ev] // []) as $arr
      | if any($arr[]; ((.matcher // null) == m) and ((.hooks // []) | any(.command == $h))) then $arr
        else $arr + [ ({ hooks: [ { type: "command", command: $h } ] } + (if m == null then {} else { matcher: m } end)) ]
        end);
  .statusLine = { type: "command", command: $s }
  | .hooks = (.hooks // {})
  | ensure("SessionStart"; null)
  | ensure("UserPromptSubmit"; null)
  | ensure("PostToolUse"; "TodoWrite")
  | ensure("PostToolUse"; "Edit|Write|MultiEdit")
  | ensure("Stop"; null)
  | ensure("PreCompact"; null)
  | ensure("SessionEnd"; null)
' "$SETTINGS" > "$tmp"
mv -f "$tmp" "$SETTINGS"

dash_url=$("$HERE/bin/pulse-dash" start 2>&1 | sed 's/^pulse dashboard: //')

# /pulse and /pulse-review commands, and the plan-reviewer subagent (copies — Claude Code reads
# these folders directly)
mkdir -p "$HOME/.claude/commands" "$HOME/.claude/agents" "$HOME/.claude/skills"
for c in "$HERE"/commands/*.md; do cp "$c" "$HOME/.claude/commands/$(basename "$c")"; done
cp "$HERE/agents/plan-reviewer.md" "$HOME/.claude/agents/plan-reviewer.md"
# the house workflow skills (file contracts; plan-together)
for s in "$HERE"/skills/*/; do n=$(basename "$s"); mkdir -p "$HOME/.claude/skills/$n"; cp "$s/SKILL.md" "$HOME/.claude/skills/$n/SKILL.md"; done

# the PLAN.md template every new project is seeded from — edit it in the repo, it is yours
ln -sfn "$HERE/templates" "$PULSE_HOME/templates"

# menu bar: the SwiftBar/xbar plugin folder is ~/.claude/pulse/menubar
ln -sfn "$HERE/menubar" "$PULSE_HOME/menubar"
chmod +x "$HERE"/menubar/*.sh
menubar_note="not installed — brew install --cask swiftbar, then pick $PULSE_HOME/menubar as its plugin folder"
# PULSE_MENUBAR_OFF=1 skips SwiftBar entirely (its preferences are per-user, not per-$HOME).
plugdir=""
[ -z "${PULSE_MENUBAR_OFF:-}" ] && plugdir=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)
if [ -n "${PULSE_MENUBAR_OFF:-}" ]; then
  menubar_note="skipped (PULSE_MENUBAR_OFF is set)"
elif [ -n "$plugdir" ] && [ "$(cd "$plugdir" 2>/dev/null && pwd -P)" = "$HERE/menubar" ]; then
  menubar_note="SwiftBar is using $PULSE_HOME/menubar"
  # Keep it in the menu bar across logouts, and start it now if it is not running. All of this
  # is best-effort: adding a login item needs macOS Automation permission, and being refused
  # must never abort the install.
  swiftbar_app=$(ls -d /Applications/SwiftBar.app "$HOME/Applications/SwiftBar.app" 2>/dev/null | head -1 || true)
  if [ -n "$swiftbar_app" ]; then
    items=$(osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null || true)
    if printf '%s' "$items" | grep -q SwiftBar; then
      menubar_note="$menubar_note, starts at login"
    elif osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$swiftbar_app\", hidden:false}" >/dev/null 2>&1; then
      menubar_note="$menubar_note, starts at login"
    else
      menubar_note="$menubar_note (allow Automation for this app to add it as a login item)"
    fi
    pgrep -x SwiftBar >/dev/null 2>&1 || open -g "$swiftbar_app" >/dev/null 2>&1 || true
  fi
elif [ -n "$plugdir" ] && [ -d "$plugdir" ]; then
  ln -sfn "$HERE/menubar/pulse.5s.sh" "$plugdir/pulse.5s.sh"; menubar_note="linked into SwiftBar ($plugdir)"
elif [ -d /Applications/SwiftBar.app ] || [ -d "$HOME/Applications/SwiftBar.app" ]; then
  menubar_note="SwiftBar found — set its plugin folder to $PULSE_HOME/menubar"
fi

echo "installed"
echo "  statusline : $STATUS"
echo "  hooks      : SessionStart · UserPromptSubmit · PostToolUse(TodoWrite) · Stop · PreCompact · SessionEnd → $HOOK"
echo "  dashboard  : $dash_url   (pulse-dash open · pulse-dash stop)"
echo "  commands   : /pulse · /pulse-review · /plan-md · /verify · /state · /handoff · /decision   (~/.claude/commands)"
echo "  skills     : house-files · plan-together   (~/.claude/skills)"
echo "  agent      : plan-reviewer   (~/.claude/agents)"
echo "  notify     : macOS notifications on needs-you / looping / done — touch $PULSE_HOME/notify.off to silence"
echo "  menu bar   : $menubar_note"
echo "  state      : $PULSE_HOME/state/<session_id>.json"
echo "  log        : $PULSE_HOME/pulse.log · $PULSE_HOME/dash.log"
echo "  backup     : $backup"
echo
echo "Takes effect in sessions started from now on. To remove: ./uninstall.sh"
