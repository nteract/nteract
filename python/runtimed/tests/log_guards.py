"""Assertions over daemon logs produced by integration tests."""

from __future__ import annotations

import re

_AUTOMERGE_RECOVERY_PATTERNS = (
    re.compile(r"\[[^\]]+\]\s+automerge panicked:", re.IGNORECASE),
    re.compile(r"after Automerge panic", re.IGNORECASE),
    re.compile(
        r"Closing (?:sync task )?after (?:(?:outbound )?RuntimeStateSync(?: reply)?|Automerge sync) failure",
        re.IGNORECASE,
    ),
    re.compile(r"Recovered from (?:sync|RuntimeStateSync) panic", re.IGNORECASE),
    re.compile(r"Failed to rebuild after sync panic", re.IGNORECASE),
    re.compile(r"settings sync recovery retry failed", re.IGNORECASE),
)

_AUTOMERGE_ERROR_PATTERN = re.compile(
    r"\b("
    r"PatchLogMismatch|"
    r"InvalidChangeDepIndex|"
    r"InvalidChangeHash(?:Slice)?|"
    r"InvalidOp|"
    r"InvalidSeq|"
    r"DuplicateSeq(?:Number)?|"
    r"DuplicateDocumentOp|"
    r"InvalidActor|"
    r"duplicate document op(?: id)?|"
    r"invalid document dep index"
    r")\b",
    re.IGNORECASE,
)

_SYNC_CONTEXT_PATTERN = re.compile(
    r"\b(automerge|notebook-sync|runtime[- ]state|pool[- ]state|settings sync|sync)\b",
    re.IGNORECASE,
)


def find_automerge_recovery_logs(log_text: str) -> list[str]:
    """Return daemon log lines that indicate Automerge recovery or corruption."""
    matches: list[str] = []
    for line_number, line in enumerate(log_text.splitlines(), start=1):
        if any(pattern.search(line) for pattern in _AUTOMERGE_RECOVERY_PATTERNS):
            matches.append(f"{line_number}: {line}")
            continue

        if _AUTOMERGE_ERROR_PATTERN.search(line) and _SYNC_CONTEXT_PATTERN.search(line):
            matches.append(f"{line_number}: {line}")

    return matches


def assert_no_automerge_recovery_logs(log_text: str) -> None:
    """Assert that integration logs did not take an Automerge recovery path."""
    matches = find_automerge_recovery_logs(log_text)
    if not matches:
        return

    sample = "\n".join(matches[:20])
    remaining = len(matches) - 20
    suffix = f"\n... and {remaining} more matching lines" if remaining > 0 else ""
    raise AssertionError(
        f"daemon log contains Automerge recovery/corruption markers:\n{sample}{suffix}"
    )
