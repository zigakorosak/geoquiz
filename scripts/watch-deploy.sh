#!/usr/bin/env bash
# Wait for the deploy that the last push started (the workflow runs on every
# push to main) and report pass/fail. Used by scripts/push-deploy.sh; run
# scripts/deploy.sh instead to start a deploy by hand.
#
# Docs-only pushes (*.md) don't deploy, so if no run for HEAD shows up,
# that's reported but isn't an error.
set -euo pipefail
cd "$(dirname "$0")/.."

workflow="Deploy to Namecheap"
sha=$(git rev-parse HEAD)

# The push's run takes a few seconds to register.
run_id=""
for _ in $(seq 1 15); do
  run_id=$(gh run list --workflow "$workflow" --commit "$sha" --event push --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
  [[ -n "$run_id" ]] && break
  sleep 2
done
if [[ -z "$run_id" ]]; then
  echo "No deploy started for $(git rev-parse --short HEAD) (docs-only push?)."
  echo "To deploy anyway: scripts/deploy.sh"
  exit 0
fi

echo "Watching deploy run $run_id..."
# `gh run watch` also exits non-zero on a GitHub API hiccup, not only when
# the deploy fails — so on a non-zero exit, ask for the run's real state.
for attempt in 1 2 3 4 5; do
  if gh run watch "$run_id" --exit-status; then
    exit 0
  fi
  state=$(gh run view "$run_id" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null || echo "unknown")
  case "$state" in
    "completed success") exit 0 ;;
    completed\ *) echo "Deploy run $run_id finished: ${state#completed }."; exit 1 ;;
  esac
  echo "Lost track of run $run_id (state: $state). Retrying ($attempt/5)..."
  sleep $((attempt * 5))
done
echo "Gave up watching run $run_id — check the Actions tab."
exit 1
