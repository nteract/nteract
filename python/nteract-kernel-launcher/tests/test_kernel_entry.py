"""Tests for ``kernel_entry.py``, the script the daemon starts kernels through.

Each test runs the script with a real interpreter and the working directory
set to a temporary notebook directory, as the daemon does.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

KERNEL_ENTRY_SOURCE = Path(__file__).resolve().parents[1] / "kernel_entry.py"


def _write(path: Path, source: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(source))


# A stand-in launcher that records how it was started.
_PROBE_LAUNCHER = """
    import json, os, sys
    try:
        import helpers
        sibling = helpers.VALUE
    except ImportError as exc:
        sibling = repr(exc)
    record = {
        "name": __name__,
        "file": __file__,
        "argv": sys.argv,
        "path0": sys.path[0],
        "path": sys.path,
        "cwd": os.getcwd(),
        "sibling": sibling,
    }
    with open(os.environ["PROBE_OUT"], "w") as f:
        json.dump(record, f)
"""

_STRAY_MODULE = """
    import os
    open(os.environ["STRAY_MARKER"], "w").close()
"""


def _child_env(**overrides: str) -> dict[str, str]:
    env = dict(os.environ)
    env.pop("PYTHONSAFEPATH", None)
    env.update(overrides)
    return env


@pytest.fixture
def entry_script(tmp_path: Path) -> Path:
    """Copy the script into a directory of its own, as the daemon does."""
    script = tmp_path / "kernel-entry" / "kernel_entry.py"
    script.parent.mkdir()
    shutil.copyfile(KERNEL_ENTRY_SOURCE, script)
    return script


@pytest.fixture
def notebook_dir(tmp_path: Path) -> Path:
    nb = tmp_path / "notebook dir"
    _write(nb / "helpers.py", "VALUE = 'from-notebook-dir'\n")
    return nb


def _run_entry(
    entry: Path, module: str, cwd: Path, pythonpath: Path, tmp_path: Path
) -> tuple[subprocess.CompletedProcess, dict | None, Path]:
    out = tmp_path / "probe.json"
    marker = tmp_path / "stray-ran"
    env = _child_env(PYTHONPATH=str(pythonpath), PROBE_OUT=str(out), STRAY_MARKER=str(marker))
    proc = subprocess.run(
        [sys.executable, "-Xfrozen_modules=off", str(entry), module, "-f", "conn.json"],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    record = json.loads(out.read_text()) if out.exists() else None
    return proc, record, marker


def test_package_launcher_wins_over_same_named_module_in_cwd(tmp_path, entry_script, notebook_dir):
    managed = tmp_path / "managed"
    _write(managed / "probe_launcher" / "__init__.py", "")
    _write(managed / "probe_launcher" / "__main__.py", _PROBE_LAUNCHER)
    _write(notebook_dir / "probe_launcher.py", _STRAY_MODULE)

    proc, record, marker = _run_entry(
        entry_script, "probe_launcher", notebook_dir, managed, tmp_path
    )

    assert proc.returncode == 0, proc.stderr
    assert not marker.exists()
    assert record is not None
    assert record["name"] == "__main__"
    assert record["file"] == str(managed / "probe_launcher" / "__main__.py")
    assert record["argv"] == [record["file"], "-f", "conn.json"]
    assert record["path0"] == record["cwd"]
    assert record["sibling"] == "from-notebook-dir"
    assert str(entry_script.parent) not in record["path"]


def test_package_launcher_wins_over_same_named_package_in_cwd(tmp_path, entry_script, notebook_dir):
    managed = tmp_path / "managed"
    _write(managed / "probe_launcher" / "__init__.py", "")
    _write(managed / "probe_launcher" / "__main__.py", _PROBE_LAUNCHER)
    _write(notebook_dir / "probe_launcher" / "__init__.py", _STRAY_MODULE)
    _write(notebook_dir / "probe_launcher" / "__main__.py", _STRAY_MODULE)

    proc, record, marker = _run_entry(
        entry_script, "probe_launcher", notebook_dir, managed, tmp_path
    )

    assert proc.returncode == 0, proc.stderr
    assert not marker.exists()
    assert record is not None
    assert record["file"] == str(managed / "probe_launcher" / "__main__.py")


def test_module_launcher_wins_over_same_named_module_in_cwd(tmp_path, entry_script, notebook_dir):
    managed = tmp_path / "managed"
    _write(managed / "probe_launcher.py", _PROBE_LAUNCHER)
    _write(notebook_dir / "probe_launcher.py", _STRAY_MODULE)

    proc, record, marker = _run_entry(
        entry_script, "probe_launcher", notebook_dir, managed, tmp_path
    )

    assert proc.returncode == 0, proc.stderr
    assert not marker.exists()
    assert record is not None
    assert record["name"] == "__main__"
    assert record["file"] == str(managed / "probe_launcher.py")
    assert record["argv"] == [record["file"], "-f", "conn.json"]
    assert record["sibling"] == "from-notebook-dir"
    assert "runpy" not in proc.stderr


def test_sys_path_matches_python_dash_m(tmp_path, entry_script, notebook_dir):
    managed = tmp_path / "managed"
    _write(managed / "probe_launcher" / "__init__.py", "")
    _write(managed / "probe_launcher" / "__main__.py", _PROBE_LAUNCHER)

    _, via_entry, _ = _run_entry(entry_script, "probe_launcher", notebook_dir, managed, tmp_path)

    out = tmp_path / "dash-m.json"
    env = _child_env(PYTHONPATH=str(managed), PROBE_OUT=str(out))
    subprocess.run(
        [sys.executable, "-Xfrozen_modules=off", "-m", "probe_launcher", "-f", "conn.json"],
        cwd=notebook_dir,
        env=env,
        check=True,
        timeout=60,
    )
    via_dash_m = json.loads(out.read_text())

    assert via_entry is not None
    assert via_entry["path"] == via_dash_m["path"]
    assert via_entry["argv"] == via_dash_m["argv"]


def test_missing_module_exits_with_error(tmp_path, entry_script, notebook_dir):
    proc, record, _ = _run_entry(
        entry_script, "no_such_launcher_module", notebook_dir, tmp_path, tmp_path
    )

    assert proc.returncode != 0
    assert record is None
    assert "No module named no_such_launcher_module" in proc.stderr


def test_real_kernel_ignores_stray_launcher_and_imports_siblings(
    tmp_path, entry_script, notebook_dir
):
    jupyter_client = pytest.importorskip("jupyter_client")
    from jupyter_client.connect import write_connection_file

    launcher_src = KERNEL_ENTRY_SOURCE.parent
    marker = tmp_path / "stray-ran"
    _write(notebook_dir / "nteract_kernel_launcher.py", _STRAY_MODULE)

    conn_file, _ = write_connection_file(str(tmp_path / "kernel.json"))
    env = _child_env(PYTHONPATH=str(launcher_src), STRAY_MARKER=str(marker))
    proc = subprocess.Popen(
        [
            sys.executable,
            "-Xfrozen_modules=off",
            str(entry_script),
            "nteract_kernel_launcher",
            "-f",
            conn_file,
        ],
        cwd=notebook_dir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    client = jupyter_client.BlockingKernelClient(connection_file=conn_file)
    client.load_connection_file()
    client.start_channels()
    try:
        client.wait_for_ready(timeout=60)
        outputs: list[str] = []

        def collect(msg):
            if msg["msg_type"] == "stream":
                outputs.append(msg["content"]["text"])

        reply = client.execute_interactive(
            "import helpers, os, sys\n"
            "print(helpers.VALUE)\n"
            "print(sys.path[0] == os.getcwd())\n"
            "print(type(get_ipython()).__name__)\n",
            output_hook=collect,
            timeout=60,
        )
        assert reply["content"]["status"] == "ok", reply["content"]
        assert "".join(outputs).split() == ["from-notebook-dir", "True", "NteractShell"]
        assert not marker.exists()
    finally:
        client.shutdown()
        client.stop_channels()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        if proc.stderr is not None:
            proc.stderr.close()
