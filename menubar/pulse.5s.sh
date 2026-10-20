#!/bin/bash
# <swiftbar.title>Pulse</swiftbar.title>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
#
# Pulse — menu-bar readout for SwiftBar (or xbar). Refreshes every 5 s.
# Title: what needs a look. Dropdown: one line per project, its chats underneath.
export PATH="/usr/bin:/bin:$PATH"
PULSE_HOME="${PULSE_HOME:-$HOME/.claude/pulse}"
URL="http://127.0.0.1:${PULSE_PORT:-7788}"

json=$(curl -s -m 1 "$URL/api/sessions" 2>/dev/null)
if [ -z "$json" ]; then
  echo "◌"
  echo "---"
  echo "dashboard is not running | color=#78818F"
  echo "start it | bash='$PULSE_HOME/bin/pulse-dash' param1=start terminal=false refresh=true"
  exit 0
fi

# --- title: the worst state wins, otherwise a bar of the average --------------
read -r live needs looping context < <(printf '%s' "$json" | jq -r '.totals | "\(.live) \(.needs_you) \(.looping) \(.context)"')
if   [ "${needs:-0}" -gt 0 ];   then echo "⏸ $needs | color=#F0B44C"
elif [ "${looping:-0}" -gt 0 ]; then echo "↻ $looping | color=#F2646D"
elif [ "${context:-0}" -gt 0 ]; then echo "▮ $context | color=#F0B44C"
else
  avg=$(printf '%s' "$json" | jq -r '[.projects[] | select(.health == "active") | select(.mode != "explore" and .mode != "conversation") | .pct] | if length > 0 then (add / length | round) else 0 end')
  cells=$(( (avg + 10) / 20 )); bar=""
  for ((i = 0; i < 5; i++)); do if [ "$i" -lt "$cells" ]; then bar+="▰"; else bar+="▱"; fi; done
  echo "$bar ${live:-0}"
fi

# --- dropdown: projects, then their chats -------------------------------------
echo "---"
printf '%s' "$json" | jq -r --arg url "$URL" '
  def mark: if .health == "needs_you" then "⏸" elif .health == "looping" then "↻" elif .health == "context" then "▮" elif .health == "done" then "✓" elif .health == "idle" or .health == "ended" then "·" else "●" end;
  def col:  if .health == "needs_you" or .health == "context" then "#F0B44C" elif .health == "looping" then "#F2646D" elif .health == "done" then "#4FC98C" elif .health == "idle" or .health == "ended" then "#78818F" else "#4FC98C" end;
  def pct:  if .mode == "explore" or .mode == "conversation" then "  — " else ((.pct | tostring) | if length < 3 then (" " * (3 - length)) + . else . end) + "%" end;
  def clip(n): if length > n then .[0:n-1] + "…" else . end;
  .projects[] | select(.health != "ended") | select(.idle_s < 43200)
  | "\(mark) \(pct)  \(.name | clip(22)) | href=\($url) color=\(col) font=Menlo size=13",
    "--\(if .health == "needs_you" then "waiting on you" elif .health == "looping" then "stuck: " + (.health_detail | clip(48)) elif .now != "" then .now | clip(52) else "—" end) | font=Menlo size=11 color=#A8AEBB",
    (if (.phases | length) > 0 then "--" + ([.phases[] | "\(.name | clip(18)) \(if .pct >= 100 then "✓" else (.pct|tostring) + "%" end)"] | join("  ")) + " | font=Menlo size=11 color=#78818F" else empty end),
    (if .plan_source == "tasks" then "--\(.plan_name) tables: \(.plan_counts.done) done · \(.plan_counts.open) open · \(.session_count) chat\(if .session_count == 1 then "" else "s" end)\(if .plan_behind then " · ⚑ plan behind" else "" end) | font=Menlo size=11 color=#78818F"
     elif .plan_countable then "--\(.plan_name): \(.plan_counts.done)/\(.plan_counts.total) ticked · \(.session_count) chat\(if .session_count == 1 then "" else "s" end)\(if .plan_behind then " · ⚑ plan behind" else "" end) | font=Menlo size=11 color=#F0B44C"
     else "--\(.session_count) chat\(if .session_count == 1 then "" else "s" end) · estimated from the chat | font=Menlo size=11 color=#78818F" end),
    (.sessions[] | select(.ended | not) | "--\(if .health == "needs_you" then "⏸" elif .health == "looping" then "↻" else "·" end) \(.overall)%  \((.goal // .title // "—") | clip(46)) | font=Menlo size=11 color=#78818F")'
echo "---"
printf '%s' "$json" | jq -r '.totals | "\(.live) live · \(if .cost_estimated then "≈" else "" end)$\(.cost_today * 100 | round / 100) today | font=Menlo size=11 color=#78818F"'
echo "open dashboard | href=$URL"
