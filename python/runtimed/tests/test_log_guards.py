from __future__ import annotations

import pytest

from tests.log_guards import assert_no_automerge_recovery_logs, find_automerge_recovery_logs


def test_find_automerge_recovery_logs_matches_direct_recovery_lines():
    log_text = "\n".join(
        [
            "INFO daemon started",
            "ERROR [runtime-doc-sync] automerge panicked: actor table mismatch",
            "WARN [notebook-sync] Recovered from sync panic for receive: bad actor",
            "WARN [notebook-sync] Failed to rebuild after sync panic for receive: label: nope",
            "WARN [notebook-sync] Recovered from RuntimeStateSync panic for outbound: nope",
            "ERROR [sync] settings sync recovery retry failed after Automerge panic: nope",
            "WARN [notebook-sync] Closing sync task after Automerge sync failure for nb: nope",
            "WARN [notebook-sync] Closing sync task after RuntimeStateSync failure for nb: nope",
            "WARN [runtime-agent] Closing after RuntimeStateSync failure: nope",
            "WARN [runtime-agent] Closing after RuntimeStateSync reply failure: nope",
            "WARN [runtime-agent] Closing after outbound RuntimeStateSync failure: nope",
            "ERROR [sync] settings sync generate failed after Automerge panic: nope",
        ]
    )

    matches = find_automerge_recovery_logs(log_text)

    assert len(matches) == 11
    assert all("daemon started" not in match for match in matches)


def test_find_automerge_recovery_logs_requires_sync_context_for_error_names():
    log_text = "\n".join(
        [
            "INFO user stdout: PatchLogMismatch",
            "INFO user stdout: InvalidChangeDepIndex",
            "WARN [notebook-sync] receive failed: PatchLogMismatch",
            "WARN [runtime-state] load failed: InvalidChangeDepIndex",
        ]
    )

    matches = find_automerge_recovery_logs(log_text)

    assert matches == [
        "3: WARN [notebook-sync] receive failed: PatchLogMismatch",
        "4: WARN [runtime-state] load failed: InvalidChangeDepIndex",
    ]


def test_assert_no_automerge_recovery_logs_reports_sample():
    with pytest.raises(AssertionError, match="Automerge recovery/corruption markers"):
        assert_no_automerge_recovery_logs("WARN [notebook-sync] receive failed: DuplicateSeqNumber")
