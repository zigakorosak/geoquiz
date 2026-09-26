#!/usr/bin/env bash
# Push to git, then trigger and wait for the deploy workflow — equivalent
# to running scripts/git-push.sh followed by scripts/deploy.sh.
#
# Usage: scripts/push-deploy.sh "commit message"
set -euo pipefail
cd "$(dirname "$0")/.."

message="${1:?Usage: scripts/push-deploy.sh \"commit message\"}"

scripts/git-push.sh "$message"
scripts/deploy.sh
