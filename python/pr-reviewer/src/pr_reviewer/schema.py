from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, cast

Verdict = Literal["clear", "findings", "needs_human", "infra_uncertain"]
TerminalReason = Literal[
    "review_complete",
    "actionable_findings",
    "needs_human",
    "budget_exhausted",
    "infra_uncertain",
]
Severity = Literal["blocker", "high", "medium", "low"]
Confidence = Literal["high", "medium", "low"]


REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["verdict", "terminal_reason", "findings", "summary"],
    "properties": {
        "verdict": {
            "type": "string",
            "enum": ["clear", "findings", "needs_human", "infra_uncertain"],
        },
        "terminal_reason": {
            "type": "string",
            "enum": [
                "review_complete",
                "actionable_findings",
                "needs_human",
                "budget_exhausted",
                "infra_uncertain",
            ],
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
    terminal_reason: TerminalReason
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


def normalize_structured_output(data: Any) -> tuple[Verdict, TerminalReason, str, list[Finding]]:
    if not isinstance(data, dict):
        raise ValueError("structured output was not an object")

    verdict = data.get("verdict")
    if verdict not in {"clear", "findings", "needs_human", "infra_uncertain"}:
        raise ValueError(f"invalid review verdict: {verdict!r}")

    terminal_reason = data.get("terminal_reason")
    if terminal_reason not in {
        "review_complete",
        "actionable_findings",
        "needs_human",
        "budget_exhausted",
        "infra_uncertain",
    }:
        raise ValueError(f"invalid terminal reason: {terminal_reason!r}")

    summary = data.get("summary")
    if not isinstance(summary, str):
        raise ValueError("review summary was not a string")

    findings_data = data.get("findings")
    if not isinstance(findings_data, list):
        raise ValueError("review findings was not a list")

    findings: list[Finding] = []
    for index, item in enumerate(findings_data):
        if not isinstance(item, dict):
            raise ValueError("finding was not an object")
        finding_data = cast(dict[str, Any], item)
        try:
            severity = finding_data["severity"]
            file = finding_data["file"]
            line = finding_data["line"]
            title = finding_data["title"]
            evidence = finding_data["evidence"]
            suggested_fix = finding_data["suggested_fix"]
            confidence = finding_data["confidence"]
        except KeyError as exc:
            raise ValueError(f"finding {index} is missing required field {exc.args[0]!r}") from exc

        if severity not in {"blocker", "high", "medium", "low"}:
            raise ValueError(f"finding {index} has invalid severity {severity!r}")
        if not isinstance(file, str):
            raise ValueError(f"finding {index} file was not a string")
        if line is not None and not isinstance(line, int):
            raise ValueError(f"finding {index} line was not an integer or null")
        if not isinstance(title, str):
            raise ValueError(f"finding {index} title was not a string")
        if not isinstance(evidence, str):
            raise ValueError(f"finding {index} evidence was not a string")
        if suggested_fix is not None and not isinstance(suggested_fix, str):
            raise ValueError(f"finding {index} suggested_fix was not a string or null")
        if confidence not in {"high", "medium", "low"}:
            raise ValueError(f"finding {index} has invalid confidence {confidence!r}")

        findings.append(
            Finding(
                severity=cast(Severity, severity),
                file=file,
                line=line,
                title=title,
                evidence=evidence,
                suggested_fix=suggested_fix,
                confidence=cast(Confidence, confidence),
            )
        )

    return (
        cast(Verdict, verdict),
        cast(TerminalReason, terminal_reason),
        summary,
        findings,
    )
