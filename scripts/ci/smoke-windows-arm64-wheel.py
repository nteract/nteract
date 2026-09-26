"""Install and exercise exactly one produced ARM64 wheel, outside the checkout."""

from __future__ import annotations

import platform
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

PROBE = """
import importlib.metadata
import pathlib
import struct
import sys

import runtimed
import runtimed._internals

root = pathlib.Path(sys.prefix).resolve()
package = pathlib.Path(runtimed.__file__).resolve().parent
extension = pathlib.Path(runtimed._internals.__file__).resolve()
assert package.is_relative_to(root), f"Package outside test venv: {package}"
assert extension.is_relative_to(root), f"Extension outside test venv: {extension}"
version = importlib.metadata.version("runtimed")
assert version == sys.argv[1], f"Installed {version}, expected {sys.argv[1]}"
data = extension.read_bytes()
assert data[:2] == b"MZ", f"Not a PE extension: {extension}"
offset = struct.unpack_from("<I", data, 0x3C)[0]
assert data[offset:offset + 4] == b"PE\\0\\0", f"Invalid PE header: {extension}"
machine = struct.unpack_from("<H", data, offset + 4)[0]
assert machine == 0xAA64, f"Expected ARM64 extension, got {machine:#x}"
# Exercise the installed Rust binding without requiring a running daemon.
socket = runtimed.default_socket_path()
assert isinstance(socket, str) and socket, f"Invalid socket path: {socket!r}"
print(f"Installed runtimed {version}: {package}", flush=True)
print(f"Native extension: {extension}", flush=True)
print(f"Native binding socket path: {socket}", flush=True)
"""


def main() -> None:
    if sys.platform != "win32" or platform.machine().lower() != "arm64":
        raise RuntimeError("Wheel smoke requires native Windows ARM64 Python")
    dist = Path(sys.argv[1]).resolve()
    wheels = list(dist.glob("runtimed-*-win_arm64.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"Expected exactly one ARM64 wheel in {dist}, got {wheels}")
    wheel = wheels[0]
    version = wheel.name.split("-")[1]
    with tempfile.TemporaryDirectory(prefix="runtimed-wheel-smoke-") as temporary:
        root = Path(temporary)
        venv.EnvBuilder(with_pip=True).create(root / "venv")
        python = root / "venv" / "Scripts" / "python.exe"
        subprocess.run(
            [
                str(python),
                "-I",
                "-m",
                "pip",
                "install",
                "--no-index",
                "--no-deps",
                str(wheel),
            ],
            cwd=root,
            check=True,
        )
        subprocess.run([str(python), "-I", "-c", PROBE, version], cwd=root, check=True)


if __name__ == "__main__":
    main()
