#!/usr/bin/env bash
# Archive, push to git, then deploy — equivalent to running
# scripts/archive.sh, scripts/git-push.sh, and scripts/deploy.sh in order.
#
# Usage: scripts/archive-p-d.sh "commit message" [archive-label]
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/timing.sh
timer_start
durations=()
step() {
  # step <label> <command...> — runs one stage and records its duration
  local label=$1; shift
  local t0=$(date +%s)
  "$@"
  durations+=("$label: $(fmt_duration $(( $(date +%s) - t0 )))")
}

summary() {
  local status=$?
  echo
  echo "──────── timing ────────"
  for d in "${durations[@]}"; do echo "  $d"; done
  timer_report "Total" "$status"
}
trap summary EXIT

message="${1:?Usage: scripts/archive-p-d.sh \"commit message\" [archive-label]}"
label="${2:-snapshot}"

step Archive scripts/archive.sh "$label"
step Push scripts/git-push.sh "$message"
step Deploy scripts/deploy.sh
