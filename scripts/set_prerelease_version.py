#!/usr/bin/env python3
"""Stamp the project with a PEP 440 prerelease version."""

from __future__ import annotations

import argparse
import re
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-version",
        required=True,
        help="Stable base version in X.Y.Z form, e.g. 2.0.1",
    )
    parser.add_argument(
        "--timestamp",
        help="UTC timestamp suffix in YYYYMMDDHHMM form. Defaults to current UTC minute.",
    )
    return parser.parse_args()


def build_version(base_version: str, timestamp: str | None) -> str:
    if not re.fullmatch(r"\d+\.\d+\.\d+", base_version):
        raise SystemExit(f"Invalid base version '{base_version}'. Expected X.Y.Z.")

    if timestamp is None:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    elif not re.fullmatch(r"\d{12}", timestamp):
        raise SystemExit(f"Invalid timestamp '{timestamp}'. Expected YYYYMMDDHHMM.")

    return f"{base_version}a{timestamp}"


def replace_version(pyproject_path: Path, version: str) -> None:
    text = pyproject_path.read_text()
    updated_text, count = re.subn(
        r'(?m)^version = "[^"]+"$',
        f'version = "{version}"',
        text,
        count=1,
    )
    if count != 1:
        raise SystemExit(f"Could not update version in {pyproject_path}")
    pyproject_path.write_text(updated_text)


def main() -> None:
    args = parse_args()
    version = build_version(args.base_version, args.timestamp)
    replace_version(Path("pyproject.toml"), version)
    print(version)


if __name__ == "__main__":
    main()
