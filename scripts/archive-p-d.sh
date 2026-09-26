#!/usr/bin/env bash
# Archive, push to git, then deploy — equivalent to running
# scripts/archive.sh, scripts/git-push.sh, and scripts/deploy.sh in order.
#
# Usage: scripts/archive-p-d.sh "commit message" [archive-label]
set -euo pipefail
cd "$(dirname "$0")/.."

message="${1:?Usage: scripts/archive-p-d.sh \"commit message\" [archive-label]}"
label="${2:-snapshot}"

scripts/archive.sh "$label"
scripts/git-push.sh "$message"
scripts/deploy.sh
