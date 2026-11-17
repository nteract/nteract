#!/usr/bin/env python3
"""Collect same-build preview outputs; hashes are evidence, never runtime authorization."""

import argparse
import hashlib
import json
import re
import struct
import tarfile
from pathlib import Path, PurePosixPath

TARGET = "aarch64-apple-darwin"
NATIVE = "runtimed-node.darwin-arm64.node"


def digest(data):
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def regular_bytes(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected regular file: {path}")
    data = path.read_bytes()
    if not data:
        raise ValueError(f"Empty artifact: {path}")
    return data


def archive_files(path):
    regular_bytes(path)
    files = {}
    with tarfile.open(path, "r:gz") as archive:
        seen = set()
        for member in archive:
            name = member.name
            parts = PurePosixPath(name).parts
            canonical = PurePosixPath(name).as_posix()
            if (name.rstrip("/") if member.isdir() else name) != canonical:
                raise ValueError(f"Noncanonical archive member: {name}")
            if name in seen or name.startswith("/") or ".." in parts:
                raise ValueError(f"Unsafe or duplicate archive member: {name}")
            seen.add(name)
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"Non-regular archive member: {name}")
            files[name] = archive.extractfile(member).read()
    return files


def require_arm64_macho(data, filetypes):
    # Thin little-endian Mach-O only. Do not accept a mislabeled x64/fat payload.
    if len(data) < 32 or struct.unpack_from("<IIII", data)[:2] != (0xFEEDFACF, 0x0100000C):
        raise ValueError("Expected a thin ARM64 Mach-O artifact")
    if struct.unpack_from("<I", data, 12)[0] not in filetypes:
        raise ValueError("Unexpected Mach-O file type")


def package_candidate(args):
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise ValueError("Expected full lowercase source commit")
    pattern = (
        r"0\.0\.0-pr\.[1-9][0-9]*\.sha\."
        + args.commit
        + r"\.run\.[1-9][0-9]*\.attempt\.[1-9][0-9]*"
    )
    if not re.fullmatch(pattern, args.build_id):
        raise ValueError("Build ID must bind the source commit, PR, run and attempt")
    run_pattern = r"https://github\.com/nteract/nteract/actions/runs/[1-9][0-9]*"
    if not re.fullmatch(run_pattern, args.run_url):
        raise ValueError("Expected nteract Actions run URL")
    if f".run.{args.run_url.rsplit('/', 1)[1]}.attempt." not in args.build_id:
        raise ValueError("Run URL does not match build ID")
    daemon = regular_bytes(args.daemon)
    require_arm64_macho(daemon, (2,))  # MH_EXECUTE
    if args.daemon.stat().st_mode & 0o111 == 0:
        raise ValueError("Daemon must be executable")

    ui = archive_files(args.ui)
    prefix = "nteract-notebook-ui/"
    ui_manifest = json.loads(ui[prefix + "nteract-notebook-ui.json"])
    expected_ui = {
        "schemaVersion": 1,
        "commit": args.commit,
        "version": args.build_id,
        "channel": "nightly",
        "entrypoint": "index.html",
        "outputDocument": "output-frame.html",
        "license": "LICENSE.nteract",
        "notices": "THIRD_PARTY_NOTICES.txt",
        "sbom": "sbom.cdx.json",
    }
    if any(ui_manifest.get(k) != v for k, v in expected_ui.items()):
        raise ValueError("Notebook UI manifest does not match candidate")
    for name in [
        "index.html",
        "output-frame.html",
        "LICENSE.nteract",
        "THIRD_PARTY_NOTICES.txt",
        "sbom.cdx.json",
    ]:
        if not ui.get(prefix + name):
            raise ValueError(f"Missing UI material: {name}")
    sbom = json.loads(ui[prefix + "sbom.cdx.json"])
    metadata = sbom.get("metadata", {})
    properties = metadata.get("properties", [])
    source_properties = [
        p.get("value") for p in properties if p.get("name") == "nteract:source-commit"
    ]
    if (
        sbom.get("bomFormat") != "CycloneDX"
        or not sbom.get("components")
        or metadata.get("component", {}).get("version") != args.build_id
        or source_properties != [args.commit]
    ):
        raise ValueError("Notebook UI attribution does not match candidate")

    wrapper = archive_files(args.wrapper)
    native = archive_files(args.native)
    wrapper_manifest = json.loads(wrapper["package/package.json"])
    native_manifest = json.loads(native["package/package.json"])
    if (
        wrapper_manifest.get("name") != "@runtimed/node"
        or native_manifest.get("name") != "@runtimed/node-darwin-arm64"
        or wrapper_manifest.get("version") != native_manifest.get("version")
        or native_manifest.get("os") != ["darwin"]
        or native_manifest.get("cpu") != ["arm64"]
    ):
        raise ValueError("Mismatched Node wrapper/native package identity")
    wrapper_outputs = [
        "index.cjs",
        "index.d.ts",
        "binding.cjs",
        "binding.d.ts",
        "relay.cjs",
        "relay.d.ts",
    ]
    for name in wrapper_outputs:
        if not wrapper.get("package/src/" + name):
            raise ValueError(f"Missing Node wrapper output: {name}")
    native_bytes = native["package/" + NATIVE]
    require_arm64_macho(native_bytes, (6, 8))  # Rust cdylib or MH_BUNDLE (.node)

    artifacts = {
        "runtimed": (args.daemon, daemon),
        "notebook-ui.tar.gz": (args.ui, regular_bytes(args.ui)),
        "runtimed-node-wrapper.tgz": (args.wrapper, regular_bytes(args.wrapper)),
        "runtimed-node-darwin-arm64.tgz": (args.native, regular_bytes(args.native)),
    }
    manifest = {
        "schemaVersion": 1,
        "kind": "preview-candidate",
        "sourceCommit": args.commit,
        "buildId": args.build_id,
        "target": TARGET,
        "producerRunUrl": args.run_url,
        "trust": (
            "Candidate evidence only. Independently verify source, run and bytes before pinning "
            "in a disposable consumer build. Not a signature or runtime authorization."
        ),
        "artifacts": {name: digest(data) for name, (_, data) in artifacts.items()},
        "node": {
            "version": wrapper_manifest["version"],
            "nativePath": "package/" + NATIVE,
            **digest(native_bytes),
        },
        "notebookUi": ui_manifest,
    }
    # Never replace a candidate identity, even on a rerun.
    args.output.mkdir(parents=True, exist_ok=False)
    for name, (_, data) in artifacts.items():
        (args.output / name).write_bytes(data)
    (args.output / "runtimed").chmod(0o755)
    manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    (args.output / "candidate.json").write_text(manifest_text)
    names = [*artifacts, "candidate.json"]
    checksums = "".join(
        f"{digest((args.output / name).read_bytes())['sha256']}  {name}\n" for name in sorted(names)
    )
    (args.output / "SHA256SUMS").write_text(checksums)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ["commit", "build-id", "run-url"]:
        parser.add_argument("--" + key, required=True)
    for key in ["daemon", "ui", "wrapper", "native", "output"]:
        parser.add_argument("--" + key, required=True, type=Path)
    args = parser.parse_args()
    try:
        package_candidate(args)
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    main()
