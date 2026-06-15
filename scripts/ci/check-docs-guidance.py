#!/usr/bin/env python3
"""Validate changed documentation and agent-guidance files.

This checker is intentionally changed-file scoped. The repository still has
some historical Markdown outside the active docs tree; this job should prevent
new stale references without turning unrelated baseline cleanup into a
precondition for every docs PR.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_SUBDIRS_REQUIRING_INDEX = {
    "adr",
    "audits",
    "handoffs",
    "measurements",
    "memos",
    "plans",
    "prd",
    "runbooks",
}
GUIDANCE_EXTENSIONS = {".md", ".mdx"}

INLINE_LINK_RE = re.compile(r"(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)")
REFERENCE_LINK_RE = re.compile(r"^\s*\[[^\]\n]+\]:\s*(\S+)", re.MULTILINE)


def tracked_files() -> set[str]:
    output = subprocess.check_output(["git", "ls-files"], cwd=REPO_ROOT, text=True)
    return set(output.splitlines())


def is_guidance_path(path: Path) -> bool:
    rel = path.as_posix()
    return (
        rel == "AGENTS.md"
        or rel == "CLAUDE.md"
        or rel in {"README.md", "CONTRIBUTING.md", "DESIGN.md", "RELEASING.md"}
        or rel == "scripts/ci/check-docs-guidance.py"
        or rel.startswith("docs/")
        or rel.startswith(".agents/")
        or rel.startswith(".claude/")
    )


def local_target(raw_target: str, source: Path) -> Path | None:
    target = raw_target.strip()
    if not target or target.startswith("#"):
        return None
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
        return None
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target:
        return None

    target = urllib.parse.unquote(target)
    if target.startswith("/"):
        candidate = REPO_ROOT / target.lstrip("/")
    else:
        candidate = REPO_ROOT / source.parent / target
    try:
        return candidate.resolve().relative_to(REPO_ROOT)
    except ValueError:
        return None


def iter_link_targets(text: str) -> list[tuple[int, str]]:
    targets: list[tuple[int, str]] = []
    for match in INLINE_LINK_RE.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        targets.append((line, match.group(1)))
    for match in REFERENCE_LINK_RE.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        targets.append((line, match.group(1)))
    return targets


def check_index(path: Path, errors: list[str]) -> None:
    parts = path.parts
    if len(parts) < 3 or parts[0] != "docs":
        return
    subdir = parts[1]
    if subdir not in DOCS_SUBDIRS_REQUIRING_INDEX:
        return
    index = REPO_ROOT / "docs" / subdir / "README.md"
    if not index.exists():
        errors.append(f"{path}: docs/{subdir}/ contains durable docs but has no README.md index")


def check_file(path: Path, tracked: set[str], errors: list[str]) -> None:
    absolute = REPO_ROOT / path
    if path.suffix.lower() not in GUIDANCE_EXTENSIONS:
        check_index(path, errors)
        return
    if not absolute.exists() or not absolute.is_file():
        return

    check_index(path, errors)
    text = absolute.read_text(encoding="utf-8", errors="replace")
    for line, raw_target in iter_link_targets(text):
        target = local_target(raw_target, path)
        if target is None:
            continue
        target_path = REPO_ROOT / target
        target_str = target.as_posix()
        if target_path.exists() or target_str in tracked:
            continue
        errors.append(f"{path}:{line}: broken local link to {raw_target!r}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--paths-json",
        help="JSON array of changed paths, as emitted by dorny/paths-filter.",
    )
    parser.add_argument("paths", nargs="*", help="Changed paths to validate")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    tracked = tracked_files()
    raw_paths = list(args.paths)
    if args.paths_json:
        try:
            decoded = json.loads(args.paths_json)
        except json.JSONDecodeError as error:
            print(f"::error::invalid --paths-json: {error}")
            return 1
        if not isinstance(decoded, list) or not all(isinstance(item, str) for item in decoded):
            print("::error::--paths-json must be a JSON array of strings")
            return 1
        raw_paths.extend(decoded)

    paths = []
    for raw in raw_paths:
        path = Path(raw)
        if path.is_absolute():
            try:
                path = path.resolve().relative_to(REPO_ROOT)
            except ValueError:
                continue
        if not is_guidance_path(path):
            continue
        paths.append(path)

    errors: list[str] = []
    for path in sorted(set(paths)):
        check_file(path, tracked, errors)

    if errors:
        for error in errors:
            print(f"::error::{error}")
        return 1

    print(f"Checked {len(set(paths))} docs/agent guidance path(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
