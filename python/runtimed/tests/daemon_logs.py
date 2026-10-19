"""Preserve logs from each integration-test daemon instance."""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path


def preserve_daemon_log(
    log_file: Path, artifact_dir: Path, module_name: str, worker: str
) -> Path | None:
    """Copy one daemon's log without replacing an earlier module/worker log.

    xdist's loadscope scheduler can leave and reenter a module, creating another
    module-scoped daemon fixture. Allocate each destination exclusively so both
    instances survive, including when an artifact directory is reused.
    """
    destination_path: Path | None = None
    try:
        artifact_dir.mkdir(parents=True, exist_ok=True)
        with (
            log_file.open("rb") as source,
            tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=f"daemon-{module_name.replace('.', '_')}-{worker}-",
                suffix=".log",
                dir=artifact_dir,
                delete=False,
            ) as destination,
        ):
            destination_path = Path(destination.name)
            shutil.copyfileobj(source, destination)
        return destination_path
    except OSError as error:
        if destination_path is not None:
            try:
                destination_path.unlink(missing_ok=True)
            except OSError as cleanup_error:
                print(
                    f"[test] Partial daemon log remains at {destination_path}: {cleanup_error}",
                    file=sys.stderr,
                )
        # Diagnostic collection must not replace a test or teardown failure.
        print(f"[test] Failed to preserve daemon log {log_file}: {error}", file=sys.stderr)
        return None
