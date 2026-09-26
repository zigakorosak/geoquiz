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

branch="$(git branch --show-current)"
workflow="Deploy to Namecheap"

gh workflow run "$workflow" --ref "$branch"

# workflow_dispatch doesn't hand back a run id directly, so poll briefly
# for the run it just created rather than parsing run-triggering output.
run_id=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  run_id=$(gh run list --workflow="$workflow" --branch="$branch" --limit 1 --json databaseId,createdAt --jq '.[0].databaseId')
  [ -n "$run_id" ] && break
done

if [ -z "$run_id" ]; then
  echo "Could not find the triggered run — check the Actions tab manually."
  exit 1
fi

echo "Watching run $run_id..."
gh run watch "$run_id" --exit-status
