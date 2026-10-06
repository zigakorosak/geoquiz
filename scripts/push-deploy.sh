#!/usr/bin/env bash
# Push to git, then trigger and wait for the deploy workflow — equivalent
# to running scripts/git-push.sh followed by scripts/deploy.sh.
#
# Usage: scripts/push-deploy.sh "commit message"
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

message="${1:?Usage: scripts/push-deploy.sh \"commit message\"}"

step Push scripts/git-push.sh "$message"
step Deploy scripts/deploy.sh
