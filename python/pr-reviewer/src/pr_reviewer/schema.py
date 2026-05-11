from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Verdict = Literal["clear", "findings", "needs_human", "infra_uncertain"]
Severity = Literal["blocker", "high", "medium", "low"]
Confidence = Literal["high", "medium", "low"]


REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["verdict", "findings", "summary"],
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["clear", "findings", "needs_human", "infra_uncertain"],
        },
        "summary": {"type": "string"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "severity",
                    "file",
                    "line",
                    "title",
                    "evidence",
                    "suggested_fix",
                    "confidence",
                ],
                "properties": {
                    "severity": {
                        "type": "string",
                        "enum": ["blocker", "high", "medium", "low"],
                    },
                    "file": {"type": "string"},
                    "line": {"type": ["integer", "null"]},
                    "title": {"type": "string"},
                    "evidence": {"type": "string"},
                    "suggested_fix": {"type": ["string", "null"]},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
            },
        },
    },
}


@dataclass(frozen=True)
class Finding:
    severity: Severity
    file: str
    line: int | None
    title: str
    evidence: str
    suggested_fix: str | None
    confidence: Confidence


@dataclass(frozen=True)
class ReviewedDiff:
    base_ref: str
    head_ref: str
    merge_base: str
    changed_files: list[str]
    diff_stat: str


@dataclass(frozen=True)
class ReviewReport:
    verdict: Verdict
    summary: str
    findings: list[Finding] = field(default_factory=list)
    reviewed_diff: ReviewedDiff | None = None
    model: str | None = None
    session_id: str | None = None
    workspace: str | None = None
    cost_usd: float | None = None
    raw_result: str | None = None

    def to_json_dict(self) -> dict[str, Any]:
        return asdict(self)


def normalize_structured_output(data: Any) -> tuple[Verdict, str, list[Finding]]:
    if not isinstance(data, dict):
        raise ValueError("structured output was not an object")

    verdict = data.get("verdict")
    if verdict not in {"clear", "findings", "needs_human", "infra_uncertain"}:
        raise ValueError(f"invalid review verdict: {verdict!r}")

    summary = data.get("summary")
    if not isinstance(summary, str):
        raise ValueError("review summary was not a string")

    findings_data = data.get("findings")
    if not isinstance(findings_data, list):
        raise ValueError("review findings was not a list")

    findings: list[Finding] = []
    for item in findings_data:
        if not isinstance(item, dict):
            raise ValueError("finding was not an object")
        findings.append(
            Finding(
                severity=item["severity"],
                file=item["file"],
                line=item["line"],
                title=item["title"],
                evidence=item["evidence"],
                suggested_fix=item["suggested_fix"],
                confidence=item["confidence"],
            )
        )

    return verdict, summary, findings
