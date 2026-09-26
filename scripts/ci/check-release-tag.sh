#!/usr/bin/env bash
# target_commitish does not move existing tags. Reject a conflicting tag before
# publishing any assets, and never rewrite it to make a release pass.
set -euo pipefail

tag="${1:?release tag required}"
source_sha="${2:?built source SHA required}"
git check-ref-format "refs/tags/$tag"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid source SHA: $source_sha" >&2; exit 1; }
refs=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")
if [[ -z "$refs" ]]; then
  echo "Release tag $tag is available for $source_sha"
  exit 0
fi

# Annotated tags point at a tag object; compare the peeled commit when present.
commit=$(awk '$2 ~ /\^\{\}$/ {print $1}' <<< "$refs")
if [[ -z "$commit" ]]; then
  commit=$(awk '{print $1}' <<< "$refs")
fi
if [[ "$commit" != "$source_sha" ]]; then
  echo "Release tag $tag points to $commit, but artifacts were built from $source_sha. Refusing to publish; leave the existing tag unchanged." >&2
  exit 1
fi
echo "Release tag $tag matches built source $source_sha"
