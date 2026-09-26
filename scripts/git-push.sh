#!/usr/bin/env bash
# Stages every tracked change (respecting .gitignore, so archive/,
# node_modules/, dist/ etc. are never touched), commits with the given
# message, and pushes to the current branch's upstream.
#
# Usage: scripts/git-push.sh "commit message"
#
# Exists so "push to git" is one command instead of a git add/commit/push
# sequence typed out by hand every time.
set -euo pipefail
cd "$(dirname "$0")/.."

message="${1:?Usage: scripts/git-push.sh \"commit message\"}"

git add -A

if git diff --cached --quiet; then
  echo "Nothing staged — working tree already matches HEAD. Skipping commit/push."
  exit 0
fi

# A cheap last-resort guard, not a substitute for actually looking at what
# got staged: refuse to commit anything that LOOKS like a credential file
# by name. Real review still matters for anything this doesn't catch.
suspicious=$(git diff --cached --name-only | grep -Ei '(^|/)\.env(\.|$)|secret|credential|\.pem$|id_rsa' || true)
if [ -n "$suspicious" ]; then
  echo "Refusing to commit — staged path(s) look sensitive:"
  echo "$suspicious"
  echo "Review with 'git diff --cached', then 'git restore --staged <path>' to unstage what shouldn't be committed."
  exit 1
fi

echo "Staged:"
git diff --cached --stat

commit_msg="$(printf '%s\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' "$message")"
git commit -m "$commit_msg"
git push

echo "Pushed $(git rev-parse --short HEAD) to $(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo 'origin')."
