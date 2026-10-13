#!/usr/bin/env bash
# Triggers the "Deploy to Namecheap" GitHub Actions workflow (manual-only
# by design — see .github/workflows/deploy.yml — it never runs on push)
# against the current branch, waits for it to finish, and reports
# pass/fail. Requires `gh` to already be authenticated.
#
# Usage: scripts/deploy.sh
#
# Deploys whatever is currently on the remote branch — run
# scripts/git-push.sh (or scripts/push-deploy.sh, which does both) first
# if there are local commits that haven't been pushed yet.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/timing.sh
timer_start
trap 'timer_report "Deploy" $?' EXIT

branch="$(git branch --show-current)"
workflow="Deploy to Namecheap"

# Remember the newest existing run BEFORE triggering: the old version
# polled for "the latest run" and accepted the first answer, which was
# usually the *previous* deploy (the new run takes a few seconds to
# register), so it watched an already-finished run and returned
# immediately while the real deploy was still going.
prev_id=$(gh run list --workflow="$workflow" --branch="$branch" --limit 1 --json databaseId --jq '.[0].databaseId // empty')

trigger_out=$(gh workflow run "$workflow" --ref "$branch" 2>&1)
echo "$trigger_out"

# Newer gh prints the created run's URL — take the id straight from it.
run_id=$(grep -oE 'actions/runs/[0-9]+' <<<"$trigger_out" | grep -oE '[0-9]+$' | head -1 || true)

# Older gh prints no URL: poll until a run newer than prev_id shows up.
if [ -z "$run_id" ]; then
  for _ in $(seq 1 30); do
    sleep 2
    latest=$(gh run list --workflow="$workflow" --branch="$branch" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
    if [ -n "$latest" ] && [ "$latest" != "$prev_id" ]; then
      run_id="$latest"
      break
    fi
  done
fi

if [ -z "$run_id" ]; then
  echo "Could not find the triggered run — check the Actions tab manually."
  exit 1
fi

echo "Watching run $run_id..."
# `gh run watch` also exits non-zero when GitHub's API has a hiccup (an
# HTTP 500 from api.github.com right after triggering was seen twice), not
# only when the deploy itself fails. So on a non-zero exit, ask for the
# run's real state: finished -> report its actual conclusion; still
# running (or the status query failed too) -> wait and watch again.
for attempt in 1 2 3 4 5; do
  if gh run watch "$run_id" --exit-status; then
    exit 0
  fi
  state=$(gh run view "$run_id" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null || echo "unknown")
  case "$state" in
    "completed success")
      exit 0 ;;
    completed\ *)
      echo "Deploy run $run_id finished: ${state#completed }."
      exit 1 ;;
  esac
  echo "Lost track of run $run_id (state: $state) — likely a temporary GitHub API error. Retrying watch ($attempt/5)..."
  sleep $((attempt * 5))
done
echo "Gave up watching run $run_id — check https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)/actions/runs/$run_id"
exit 1
