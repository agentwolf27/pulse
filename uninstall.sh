#!/bin/bash
# Pulse — uninstaller. Removes only what install.sh added. State files are kept.
set -euo pipefail
export PATH="/usr/bin:/bin:$PATH"

PULSE_HOME="$HOME/.claude/pulse"
SETTINGS="$HOME/.claude/settings.json"
HOOK='~/.claude/pulse/bin/pulse-hook'
STATUS='~/.claude/pulse/bin/pulse-status'

[ -f "$SETTINGS" ] || { echo "nothing to do: $SETTINGS missing"; exit 0; }
backup="$SETTINGS.pulse-backup.$(date +%Y%m%d-%H%M%S)"
cp "$SETTINGS" "$backup"

tmp=$(mktemp)
jq --arg h "$HOOK" --arg s "$STATUS" '
  (if .statusLine.command == $s then del(.statusLine) else . end)
  | .hooks = ((.hooks // {}) | with_entries(
        .value |= map(select(((.hooks // []) | any(.command == $h)) | not))
      ) | with_entries(select(.value | length > 0)))
  | (if .hooks == {} then del(.hooks) else . end)
' "$SETTINGS" > "$tmp"
mv -f "$tmp" "$SETTINGS"

[ -x "$PULSE_HOME/bin/pulse-dash" ] && "$PULSE_HOME/bin/pulse-dash" stop >/dev/null 2>&1
[ -L "$PULSE_HOME/bin" ] && rm -f "$PULSE_HOME/bin"
[ -L "$PULSE_HOME/menubar" ] && rm -f "$PULSE_HOME/menubar"
[ -L "$PULSE_HOME/templates" ] && rm -f "$PULSE_HOME/templates"
grep -q 'pulse-goal' "$HOME/.claude/commands/pulse.md" 2>/dev/null && rm -f "$HOME/.claude/commands/pulse.md"
grep -q 'plan-reviewer' "$HOME/.claude/commands/pulse-review.md" 2>/dev/null && rm -f "$HOME/.claude/commands/pulse-review.md"
grep -q 'Pulse' "$HOME/.claude/agents/plan-reviewer.md" 2>/dev/null && rm -f "$HOME/.claude/agents/plan-reviewer.md"
for c in plan-md verify state handoff decision; do grep -q 'pulse/templates\|pulse-plan' "$HOME/.claude/commands/$c.md" 2>/dev/null && rm -f "$HOME/.claude/commands/$c.md"; done
for s in house-files plan-together; do grep -q 'pulse' "$HOME/.claude/skills/$s/SKILL.md" 2>/dev/null && rm -rf "$HOME/.claude/skills/$s"; done
plugdir=""
[ -z "${PULSE_MENUBAR_OFF:-}" ] && plugdir=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)
[ -n "$plugdir" ] && [ -L "$plugdir/pulse.5s.sh" ] && rm -f "$plugdir/pulse.5s.sh"
echo "removed statusline + hooks, stopped the dashboard (backup: $backup). State kept in $PULSE_HOME/state — delete it if you want."
