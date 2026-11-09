#!/bin/bash
# Prepare a new worktree: allow .envrc in direnv and hydrate Git LFS files.
#
# A worktree shares the main checkout's git storage but gets its own working
# files and its own direnv allow, so it can start with two things missing:
#
#   - .envrc is blocked. scripts/direnv-allow-pinned.sh allows it while it
#     matches main and leaves a changed .envrc for a person to read.
#   - LFS-tracked files are pointer files. `git lfs checkout` fills them from
#     the local LFS store, which every worktree of this repository shares, so
#     the usual case needs no network. `git lfs pull` runs only for objects
#     the store lacks.
#
# Hydrating writes the bytes the branch's own pointers name, the same content
# a checkout with the LFS smudge filter produces. A file that is no longer a
# pointer is left alone, so a local edit to an LFS-tracked file survives.
#
# Usage:
#   scripts/worktree-setup.sh [dir]    dir defaults to the current directory.
#                                      Reports each step on stderr and exits 1
#                                      if LFS files are still pointers.
#   scripts/worktree-setup.sh --hook   Claude Code hook: reads `cwd` from the
#                                      hook JSON on stdin. Always exits 0 and
#                                      stays silent, so it neither blocks the
#                                      session nor adds to its context.
#                                      WORKTREE_SETUP_VERBOSE=1 reports on
#                                      stderr.
#
# Nothing is written to stdout in either mode. Every caller runs unattended
# (the Claude Code SessionStart and SubagentStart hooks, and
# scripts/codex-worktree-setup.sh), so git never prompts for credentials here.
#
# SubagentStart reports the subagent's own directory as `cwd`. For a subagent
# with worktree isolation that is its new worktree; for any other subagent it
# is the session's checkout, where this finds nothing left to do.

set -u

LFS_POINTER_PREFIX="version https://git-lfs.github.com/spec/"

hook_mode=""
dir="."

say() {
  if [ -z "$hook_mode" ] || [ -n "${WORKTREE_SETUP_VERBOSE:-}" ]; then
    printf 'worktree-setup: %s\n' "$*" >&2
  fi
}

if [ "${1:-}" = "--hook" ]; then
  hook_mode=1
  if ! command -v jq >/dev/null 2>&1; then
    say "jq not found; cannot read the hook input"
    exit 0
  fi
  dir="$(jq -r '.cwd // empty' 2>/dev/null)"
  if [ -z "$dir" ]; then
    say "hook input has no cwd"
    exit 0
  fi
elif [ -n "${1:-}" ]; then
  dir="$1"
fi

# Leaves with the given status in direct mode. A hook always reports success.
finish() {
  if [ -n "$hook_mode" ]; then
    exit 0
  fi
  exit "$1"
}

if ! command -v git >/dev/null 2>&1; then
  say "git not found"
  finish 1
fi

root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || {
  say "$dir is not in a git checkout"
  finish 1
}

export GIT_TERMINAL_PROMPT=0

# direnv goes first: it is local and quick, so a slow LFS download that runs
# into the hook timeout cannot skip it.
# The sibling script comes from beside this file, not from the target
# checkout, so the copy that decides the allow is the one the caller chose
# to run.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "$hook_mode" ] || [ -n "${WORKTREE_SETUP_VERBOSE:-}" ]; then
  DIRENV_ALLOW_PINNED_VERBOSE=1 "$script_dir/direnv-allow-pinned.sh" "$root"
else
  "$script_dir/direnv-allow-pinned.sh" "$root"
fi

# Prints the LFS-tracked paths whose working file is still a pointer.
# `git lfs ls-files` marks a locally edited file the same way as a pointer,
# so the file's own first bytes decide. They go through a pipe rather than a
# command substitution because a hydrated binary can start with NUL bytes.
lfs_pointer_paths() {
  git -C "$root" ls-files ':(top,attr:filter=lfs)' 2>/dev/null | while IFS= read -r tracked; do
    if head -c "${#LFS_POINTER_PREFIX}" "$root/$tracked" 2>/dev/null |
      grep -q -a -F -- "$LFS_POINTER_PREFIX"; then
      printf '%s\n' "$tracked"
    fi
  done
}

count_lines() {
  if [ -z "$1" ]; then
    echo 0
  else
    printf '%s\n' "$1" | wc -l | tr -d ' '
  fi
}

pointers="$(lfs_pointer_paths)"
if [ -z "$pointers" ]; then
  say "LFS files are already hydrated"
  finish 0
fi
before="$(count_lines "$pointers")"

if ! git lfs version >/dev/null 2>&1; then
  say "git-lfs not found; $before LFS files stay as pointers"
  finish 1
fi

git -C "$root" lfs checkout >/dev/null 2>&1
pointers="$(lfs_pointer_paths)"
if [ -z "$pointers" ]; then
  say "hydrated $before LFS files from the local store"
  finish 0
fi

say "$(count_lines "$pointers") of $before LFS files are not in the local store; running git lfs pull"
git -C "$root" lfs pull >/dev/null 2>&1
pointers="$(lfs_pointer_paths)"
if [ -z "$pointers" ]; then
  say "hydrated $before LFS files"
  finish 0
fi

say "$(count_lines "$pointers") LFS files are still pointers; run \`git lfs pull\` to see why:"
printf '%s\n' "$pointers" | while IFS= read -r tracked; do
  say "  $tracked"
done
finish 1
