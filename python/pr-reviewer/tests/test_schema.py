import pytest

from pr_reviewer.schema import Finding, normalize_structured_output


def test_normalize_structured_output_returns_findings() -> None:
    verdict, summary, findings = normalize_structured_output(
        {
            "verdict": "findings",
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
        normalize_structured_output({"verdict": "maybe", "summary": "", "findings": []})
