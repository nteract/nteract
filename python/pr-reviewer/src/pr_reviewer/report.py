from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pr_reviewer.schema import ReviewReport


def write_report(
    path: Path, report: ReviewReport, *, metadata: dict[str, Any] | None = None
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {"report": report.to_json_dict()}
    if metadata:
        payload["metadata"] = metadata
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
