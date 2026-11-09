#!/bin/bash
# Bootstrap a Codex-created worktree after the repo has been checked out.
#
# The Codex UI writes .codex/environments/environment.toml per worktree; keep
# that generated file out of git and point its setup script at this helper.
#
# Claude Code worktrees get the same steps from the SessionStart and
# SubagentStart hooks in .claude/settings.json. All of them call
# scripts/worktree-setup.sh.

set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  echo "git is required for Codex worktree setup" >&2
  exit 1
fi

if [ -n "${CODEX_WORKTREE_PATH:-}" ]; then
  cd "$CODEX_WORKTREE_PATH"
else
  cd "$(git rev-parse --show-toplevel)"
fi

# Allows .envrc in direnv while it matches main, then hydrates LFS files.
# A blocked or missing direnv never fails setup. LFS files left as pointers
# do, because the build needs them.
scripts/worktree-setup.sh
