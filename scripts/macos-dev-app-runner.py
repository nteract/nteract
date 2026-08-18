#!/usr/bin/env python3
"""Cargo runner that executes a Tauri dev binary from an isolated macOS app bundle."""

from __future__ import annotations

import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required by the nteract macOS dev app runner")
    return value


def split_runner_args(arguments: list[str]) -> tuple[list[str], list[str]]:
    if not arguments or arguments[0] != "run":
        raise SystemExit(
            "the nteract macOS dev app runner expected cargo-style arguments beginning with 'run'"
        )
    try:
        separator = arguments.index("--")
    except ValueError:
        separator = len(arguments)
    return ["build", *arguments[1:separator]], arguments[separator + 1 :]


def write_app_bundle(bundle: Path, binary: Path, display_name: str, bundle_id: str) -> Path:
    contents = bundle / "Contents"
    macos = contents / "MacOS"
    macos.mkdir(parents=True, exist_ok=True)
    executable = macos / "notebook"
    executable.unlink(missing_ok=True)
    try:
        os.link(binary, executable)
    except OSError:
        shutil.copy2(binary, executable)

    info = {
        "CFBundleDisplayName": display_name,
        "CFBundleExecutable": "notebook",
        "CFBundleIdentifier": bundle_id,
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": display_name,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "0.0.0",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "11.0",
        "NSHighResolutionCapable": True,
        "NSPrincipalClass": "NSApplication",
    }
    with (contents / "Info.plist").open("wb") as handle:
        plistlib.dump(info, handle, sort_keys=True)
    return executable


def main() -> int:
    if sys.platform != "darwin":
        raise SystemExit("the nteract macOS dev app runner can only run on macOS")

    build_args, app_args = split_runner_args(sys.argv[1:])
    cargo = os.environ.get("CARGO", "cargo")
    result = subprocess.run([cargo, *build_args], check=False)
    if result.returncode:
        return result.returncode

    binary = Path(required_env("NTERACT_DEV_BINARY_PATH")).resolve(strict=True)
    bundle = Path(required_env("NTERACT_DEV_APP_BUNDLE_PATH"))
    display_name = required_env("NTERACT_DEV_APP_DISPLAY_NAME")
    bundle_id = required_env("NTERACT_DEV_APP_BUNDLE_ID")
    executable = write_app_bundle(bundle, binary, display_name, bundle_id)

    print(f"Launching {display_name} from {bundle}", flush=True)
    os.execv(executable, [str(executable), *app_args])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
