from __future__ import annotations

import pytest

from tests.daemon_logs import preserve_daemon_log


def test_preserves_every_daemon_log_when_module_is_reentered(tmp_path):
    artifact_dir = tmp_path / "artifacts"
    contents = [b"first daemon\r\n\x1b[31mdisconnect\x1b[0m\xff\n", b"second daemon\n"]
    destinations = []

    for index, content in enumerate(contents):
        instance_dir = tmp_path / f"instance-{index}"
        instance_dir.mkdir()
        log_file = instance_dir / "daemon.log"
        log_file.write_bytes(content)
        destination = preserve_daemon_log(log_file, artifact_dir, "tests.test_daemon", "gw0")
        assert destination is not None
        destinations.append(destination)
        # Fixture temp directories disappear after teardown.
        log_file.unlink()
        instance_dir.rmdir()

    assert destinations[0] != destinations[1]
    assert set(artifact_dir.glob("daemon-tests_test_daemon-gw0-*.log")) == set(destinations)
    assert [path.read_bytes() for path in destinations] == contents


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_copy_failure_does_not_replace_original_failure(
    tmp_path, monkeypatch, capsys, cleanup_fails
):
    log_file = tmp_path / "daemon.log"
    log_file.write_bytes(b"daemon log")

    def fail_copy(source, destination):
        destination.write(b"partial")
        raise OSError("disk full")

    def fail_cleanup(*args, **kwargs):
        raise OSError("cleanup denied")

    if cleanup_fails:
        monkeypatch.setattr("tests.daemon_logs.Path.unlink", fail_cleanup)

    monkeypatch.setattr("tests.daemon_logs.shutil.copyfileobj", fail_copy)

    with pytest.raises(RuntimeError, match="original test failure"):
        try:
            raise RuntimeError("original test failure")
        finally:
            assert (
                preserve_daemon_log(log_file, tmp_path / "artifacts", "tests.test", "gw0") is None
            )

    errors = capsys.readouterr().err
    assert "Failed to preserve daemon log" in errors
    if cleanup_fails:
        assert "Partial daemon log remains" in errors
    else:
        assert list((tmp_path / "artifacts").iterdir()) == []
