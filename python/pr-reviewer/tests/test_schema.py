import pytest

from pr_reviewer.schema import Finding, normalize_structured_output


def test_normalize_structured_output_returns_findings() -> None:
    verdict, terminal_reason, summary, findings = normalize_structured_output(
        {
            "verdict": "findings",
            "terminal_reason": "actionable_findings",
            "summary": "One issue.",
            "findings": [
                {
                    "severity": "high",
                    "file": "src/lib.rs",
                    "line": 42,
                    "title": "Race",
                    "evidence": "The old value can overwrite the new value.",
                    "suggested_fix": "Check generation before storing.",
                    "confidence": "high",
                }
            ],
        }
    )

    assert verdict == "findings"
    assert terminal_reason == "actionable_findings"
    assert summary == "One issue."
    assert findings == [
        Finding(
            severity="high",
            file="src/lib.rs",
            line=42,
            title="Race",
            evidence="The old value can overwrite the new value.",
            suggested_fix="Check generation before storing.",
            confidence="high",
        )
    ]


def test_normalize_structured_output_rejects_invalid_verdict() -> None:
    with pytest.raises(ValueError, match="invalid review verdict"):
        normalize_structured_output(
            {
                "verdict": "maybe",
                "terminal_reason": "review_complete",
                "summary": "",
                "findings": [],
            }
        )


def test_normalize_structured_output_rejects_invalid_terminal_reason() -> None:
    with pytest.raises(ValueError, match="invalid terminal reason"):
        normalize_structured_output(
            {
                "verdict": "clear",
                "terminal_reason": "stopped",
                "summary": "",
                "findings": [],
            }
        )


def test_normalize_structured_output_wraps_missing_finding_field() -> None:
    with pytest.raises(ValueError, match="finding 0 is missing required field 'severity'"):
        normalize_structured_output(
            {
                "verdict": "findings",
                "terminal_reason": "actionable_findings",
                "summary": "Bad finding.",
                "findings": [{"file": "src/lib.rs"}],
            }
        )
