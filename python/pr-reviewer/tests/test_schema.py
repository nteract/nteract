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
                    "category": "correctness",
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
            category="correctness",
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


def test_normalize_structured_output_accepts_nit_findings() -> None:
    _, _, _, findings = normalize_structured_output(
        {
            "verdict": "findings",
            "terminal_reason": "actionable_findings",
            "summary": "One nit.",
            "findings": [
                {
                    "severity": "nit",
                    "category": "shared_surface",
                    "file": "apps/notebook/src/Foo.tsx",
                    "line": 12,
                    "title": "Duplicate shared surface behavior",
                    "evidence": "The app-local code repeats a shared notebook surface invariant.",
                    "suggested_fix": "Move the reusable behavior under src/components.",
                    "confidence": "medium",
                }
            ],
        }
    )

    assert findings[0].severity == "nit"
    assert findings[0].category == "shared_surface"


def test_normalize_structured_output_rejects_invalid_category() -> None:
    with pytest.raises(ValueError, match="finding 0 has invalid category"):
        normalize_structured_output(
            {
                "verdict": "findings",
                "terminal_reason": "actionable_findings",
                "summary": "Bad category.",
                "findings": [
                    {
                        "severity": "low",
                        "category": "style",
                        "file": "src/lib.rs",
                        "line": None,
                        "title": "Vague",
                        "evidence": "Not a real review category.",
                        "suggested_fix": None,
                        "confidence": "low",
                    }
                ],
            }
        )
