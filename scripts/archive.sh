#!/usr/bin/env bash
# Snapshots the project into archive/ as a timestamped tarball, then prunes
# down to the 10 most recent archives (oldest deleted first).
#
# Usage: scripts/archive.sh [short-label]
set -euo pipefail
cd "$(dirname "$0")/.."

label="${1:-snapshot}"
timestamp=$(date +%Y-%m-%d_%H%M%S)
name="${timestamp}_${label}"

mkdir -p archive

tar \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./archive' \
  -czf "archive/${name}.tar.gz" .

echo "Archived to archive/${name}.tar.gz"

mapfile -t archives < <(ls -1t archive/*.tar.gz)
max=10
if [ "${#archives[@]}" -gt "$max" ]; then
  for old in "${archives[@]:$max}"; do
    echo "Pruning old archive: $old"
    rm -f "$old"
  done
fi
