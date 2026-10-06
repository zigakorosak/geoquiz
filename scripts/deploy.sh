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
gh run watch "$run_id" --exit-status
