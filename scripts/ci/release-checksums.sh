#!/usr/bin/env bash
# Release checksum manifest and its minisign signature.
#
#   write <dir> [<extra-dir>...]   Write <dir>/SHA256SUMS for the top-level
#                                  files of every named directory.
#   install-minisign <dest-dir>    Fetch the pinned minisign release binary
#                                  for this Linux host into <dest-dir>.
#   public-key <installer>         Print the public key pinned in
#                                  scripts/install-linux-release.
#   sign <SHA256SUMS> <tag>        Write <SHA256SUMS>.minisig. The trusted
#                                  comment is "nteract release <tag>".
#   verify <SHA256SUMS> <tag> <public-key>
#                                  Check <SHA256SUMS>.minisig and its tag.
#   cleanup                        Remove the decoded signing key, if any.
#
# `sign` reads RELEASE_CHECKSUMS_SIGNING_KEY (base64 of a minisign secret key
# file) and RELEASE_CHECKSUMS_SIGNING_KEY_PASSWORD from the environment. The
# key is decoded under $RUNNER_TEMP with umask 077, the password reaches
# minisign on stdin, and neither appears in argv or output.
#
# SHA256SUMS is GNU coreutils format: one `<sha256>  <name>` line per asset,
# sorted by name in the C locale, no comments, never listing itself or its
# signature. Asset names contain no whitespace; `write` refuses any that do.
set -euo pipefail

MANIFEST_NAME="SHA256SUMS"
SIGNATURE_SUFFIX=".minisig"
TRUSTED_COMMENT_PREFIX="nteract release "
MINISIGN="${MINISIGN:-minisign}"

# minisign 0.12 from https://github.com/jedisct1/minisign/releases/tag/0.12.
# The tarball carries static binaries at minisign-linux/<arch>/minisign. To
# move the pin: download the new minisign-<version>-linux.tar.gz and its
# .minisig, check it with
#   minisign -Vm <tarball> -P RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
# (the key published in the minisign README), then replace the version and
# the `shasum -a 256` of the tarball here.
MINISIGN_VERSION="0.12"
MINISIGN_TARBALL_SHA256="9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73"

KEY_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nteract-release-checksums-key"

die() {
  echo "release-checksums: $*" >&2
  exit 1
}

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

cmd_write() {
  [[ $# -ge 1 ]] || die "write needs an output directory"
  local out_dir="$1"
  [[ -d "$out_dir" ]] || die "not a directory: $out_dir"
  local manifest="$out_dir/$MANIFEST_NAME"
  local lines="" seen=$'\n' dir path name
  for dir in "$@"; do
    [[ -d "$dir" ]] || die "not a directory: $dir"
    for path in "$dir"/* "$dir"/.[!.]*; do
      [[ -f "$path" ]] || continue
      name="${path##*/}"
      if [[ "$dir" == "$out_dir" ]]; then
        [[ "$name" != "$MANIFEST_NAME" && "$name" != "$MANIFEST_NAME$SIGNATURE_SUFFIX" ]] || continue
      fi
      [[ "$name" =~ ^[A-Za-z0-9._+-]+$ ]] || die "asset name has unsupported characters: $path"
      [[ "$seen" != *$'\n'"$name"$'\n'* ]] || die "two assets share the name $name"
      seen+="$name"$'\n'
      lines+="$(sha256_of "$path")  $name"$'\n'
    done
  done
  [[ -n "$lines" ]] || die "no assets found in: $*"
  printf '%s' "$lines" | LC_ALL=C sort -k2,2 > "$manifest.new"
  mv -f "$manifest.new" "$manifest"
  echo "Wrote $manifest ($(wc -l < "$manifest" | tr -d ' ') assets)"
}

cmd_install_minisign() {
  [[ $# -eq 1 ]] || die "install-minisign needs a destination directory"
  local dest="$1" arch
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) arch=x86_64 ;;
    Linux-aarch64) arch=aarch64 ;;
    *) die "pinned minisign is for Linux x86_64 or aarch64, not $(uname -s) $(uname -m)" ;;
  esac
  local work
  work="$(mktemp -d)"
  local tarball="$work/minisign-$MINISIGN_VERSION-linux.tar.gz"
  curl --fail --location --silent --show-error --retry 3 \
    "https://github.com/jedisct1/minisign/releases/download/$MINISIGN_VERSION/minisign-$MINISIGN_VERSION-linux.tar.gz" \
    --output "$tarball"
  local actual
  actual="$(sha256_of "$tarball")"
  [[ "$actual" == "$MINISIGN_TARBALL_SHA256" ]] ||
    die "minisign tarball SHA-256 is $actual, expected $MINISIGN_TARBALL_SHA256"
  tar -xzf "$tarball" -C "$work" "minisign-linux/$arch/minisign"
  mkdir -p "$dest"
  install -m 0755 "$work/minisign-linux/$arch/minisign" "$dest/minisign"
  rm -rf "$work"
  "$dest/minisign" -v
}

cmd_public_key() {
  [[ $# -eq 1 ]] || die "public-key needs the installer path"
  local key
  key="$(sed -n 's/^NTERACT_RELEASE_PUBLIC_KEY="\([A-Za-z0-9+/=]*\)"$/\1/p' "$1")"
  [[ -n "$key" && "$(printf '%s\n' "$key" | wc -l | tr -d ' ')" == 1 ]] ||
    die "expected exactly one NTERACT_RELEASE_PUBLIC_KEY line in $1"
  printf '%s\n' "$key"
}

check_tag() {
  [[ "$1" =~ ^v[0-9A-Za-z.+-]+$ ]] || die "invalid release tag: $1"
}

cmd_sign() {
  [[ $# -eq 2 ]] || die "sign needs <SHA256SUMS> <tag>"
  local manifest="$1" tag="$2"
  check_tag "$tag"
  [[ -s "$manifest" ]] || die "missing or empty manifest: $manifest"
  [[ -n "${RELEASE_CHECKSUMS_SIGNING_KEY:-}" ]] ||
    die "RELEASE_CHECKSUMS_SIGNING_KEY is empty. Set it in the signing environment."
  [[ -n "${RELEASE_CHECKSUMS_SIGNING_KEY_PASSWORD:-}" ]] ||
    die "RELEASE_CHECKSUMS_SIGNING_KEY_PASSWORD is empty. Set it in the signing environment."

  trap cmd_cleanup EXIT
  (
    umask 077
    rm -rf "$KEY_DIR"
    mkdir -p "$KEY_DIR"
    printf '%s' "$RELEASE_CHECKSUMS_SIGNING_KEY" | base64 --decode > "$KEY_DIR/release.key"
  ) || die "RELEASE_CHECKSUMS_SIGNING_KEY is not valid base64"
  [[ -s "$KEY_DIR/release.key" ]] || die "decoded signing key is empty"

  rm -f "$manifest$SIGNATURE_SUFFIX"
  printf '%s\n' "$RELEASE_CHECKSUMS_SIGNING_KEY_PASSWORD" |
    "$MINISIGN" -S -s "$KEY_DIR/release.key" -m "$manifest" \
      -x "$manifest$SIGNATURE_SUFFIX" -t "$TRUSTED_COMMENT_PREFIX$tag" >/dev/null ||
    die "minisign could not sign $manifest"
  echo "Signed $manifest for $tag"
}

cmd_verify() {
  [[ $# -eq 3 ]] || die "verify needs <SHA256SUMS> <tag> <public-key>"
  local manifest="$1" tag="$2" key="$3" comment
  check_tag "$tag"
  [[ -s "$manifest$SIGNATURE_SUFFIX" ]] || die "missing signature: $manifest$SIGNATURE_SUFFIX"
  comment="$("$MINISIGN" -V -m "$manifest" -x "$manifest$SIGNATURE_SUFFIX" -P "$key" -Q)" ||
    die "signature on $manifest does not verify against $key"
  [[ "$comment" == "$TRUSTED_COMMENT_PREFIX$tag" ]] ||
    die "signature names '$comment', expected '$TRUSTED_COMMENT_PREFIX$tag'"
  echo "Verified $manifest for $tag"
}

cmd_cleanup() {
  rm -rf "$KEY_DIR"
}

command="${1:-}"
[[ $# -eq 0 ]] || shift
case "$command" in
  write) cmd_write "$@" ;;
  install-minisign) cmd_install_minisign "$@" ;;
  public-key) cmd_public_key "$@" ;;
  sign) cmd_sign "$@" ;;
  verify) cmd_verify "$@" ;;
  cleanup) cmd_cleanup ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
