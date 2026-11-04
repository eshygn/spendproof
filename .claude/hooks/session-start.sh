#!/bin/bash
# Runs at the start of every Claude Code session in this repository.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

# 1. Every commit is authored and committed by the repository owner, never by Claude.
#    Repo-local config overrides the session's global "Claude" identity.
git config user.name "Nisaar"
git config user.email "120457154+eshygn@users.noreply.github.com"
# The session's signing key belongs to Claude; a commit signed with it under
# this identity would show as "Unverified" on GitHub, so don't sign.
git config commit.gpgsign false
git config tag.gpgsign false

# 2. Dependencies (cloud sessions only), skipped when nothing changed.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  hashes=node_modules/.session-start.sha256
  if ! sha256sum --check --status "$hashes" 2>/dev/null; then
    rm -f "$hashes"
    npm install --no-audit --no-fund
    sha256sum .claude/hooks/session-start.sh package.json package-lock.json > "$hashes" || rm -f "$hashes"
  fi
fi
