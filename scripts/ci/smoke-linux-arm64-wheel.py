"""Install and exercise exactly one produced Linux ARM64 wheel, outside the checkout."""

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
import subprocess
import sys

import runtimed
import runtimed._internals

EM_AARCH64 = 0xB7


def assert_aarch64_elf(path):
    data = path.read_bytes()[:20]
    assert data[:4] == b"\\x7fELF", f"Not an ELF file: {path}"
    assert data[4] == 2, f"Expected 64-bit ELF: {path}"
    assert data[5] == 1, f"Expected little-endian ELF: {path}"
    machine = struct.unpack_from("<H", data, 18)[0]
    assert machine == EM_AARCH64, f"Expected AArch64 ELF, got {machine:#x}: {path}"


root = pathlib.Path(sys.prefix).resolve()
package = pathlib.Path(runtimed.__file__).resolve().parent
extension = pathlib.Path(runtimed._internals.__file__).resolve()
daemon = package / "_bin" / "runtimed"
assert package.is_relative_to(root), f"Package outside test venv: {package}"
assert extension.is_relative_to(root), f"Extension outside test venv: {extension}"
version = importlib.metadata.version("runtimed")
assert version == sys.argv[1], f"Installed {version}, expected {sys.argv[1]}"
assert_aarch64_elf(extension)
assert daemon.is_file(), f"Wheel is missing the bundled daemon: {daemon}"
assert_aarch64_elf(daemon)
# Exercise the installed Rust binding and daemon without starting a daemon.
socket = runtimed.default_socket_path()
assert isinstance(socket, str) and socket, f"Invalid socket path: {socket!r}"
subprocess.run([str(daemon), "--help"], check=True, stdout=subprocess.DEVNULL)
print(f"Installed runtimed {version}: {package}", flush=True)
print(f"Native extension: {extension}", flush=True)
print(f"Bundled daemon: {daemon}", flush=True)
print(f"Native binding socket path: {socket}", flush=True)
"""


def main() -> None:
    if sys.platform != "linux" or platform.machine().lower() not in {"aarch64", "arm64"}:
        raise RuntimeError("Wheel smoke requires native Linux ARM64 Python")
    dist = Path(sys.argv[1]).resolve()
    wheels = list(dist.glob("runtimed-*_aarch64.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"Expected exactly one Linux ARM64 wheel in {dist}, got {wheels}")
    wheel = wheels[0]
    version = wheel.name.split("-")[1]
    with tempfile.TemporaryDirectory(prefix="runtimed-wheel-smoke-") as temporary:
        root = Path(temporary)
        venv.EnvBuilder(with_pip=True).create(root / "venv")
        python = root / "venv" / "bin" / "python"
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
