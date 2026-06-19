from __future__ import annotations

from pathlib import Path

from pr_reviewer.workspace import ReviewWorkspace

REVIEW_RUBRIC_PATH = (
    Path(__file__).resolve().parents[4] / ".agents" / "reviewers" / "nteract-code-review-rubric.md"
)


def load_nteract_review_rubric() -> str:
    try:
        return REVIEW_RUBRIC_PATH.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return (
            "Review against nteract ownership, authority, shared-surface, "
            "runtime/output, async, generated-artifact, and test boundaries."
        )


NTERACT_REVIEW_RUBRIC = load_nteract_review_rubric()

SYSTEM_PROMPT = f"""\
You are an external senior code reviewer. You are reviewing a GitHub pull
request in a dedicated checkout.

Use this shared nteract reviewer rubric:

{NTERACT_REVIEW_RUBRIC}

Set terminal_reason to explain how the review ended:
- review_complete: full review completed with no actionable findings.
- actionable_findings: full review completed and found actionable issues.
- needs_human: product, design, or scoping judgment is required.
- budget_exhausted: you could not finish before the turn/context budget.
- infra_uncertain: review could not be trusted because of tooling or environment uncertainty.

You may be running through opencode inside an isolated disposable review
workspace or through a direct Bedrock API fallback with the full diff in
context. Prefer read-only inspection when tools are available, but do not assume
tool access. Do not intentionally edit source files; this review should produce
findings, not patches.
"""

REVIEW_JSON_SHAPE = """\
{
  "verdict": "clear" | "findings" | "needs_human" | "infra_uncertain",
  "terminal_reason": "review_complete" | "actionable_findings" |
    "needs_human" | "budget_exhausted" | "infra_uncertain",
  "summary": "short review summary",
  "findings": [
    {
      "severity": "blocker" | "high" | "medium" | "low" | "nit",
      "category": "correctness" | "state_ownership" | "shared_surface" |
        "host_boundary" | "authority_boundary" | "protocol_sync" |
        "output_widget_runtime" | "async_ordering" | "tests" |
        "generated_artifact" | "style_maintainability" | "infra",
      "file": "path/to/file",
      "line": 123,
      "title": "short issue title",
      "evidence": "why this is a real bug, risk, or invariant drift",
      "suggested_fix": "concrete fix, or null",
      "confidence": "high" | "medium" | "low"
    }
  ]
}"""


def build_review_prompt(workspace: ReviewWorkspace, *, extra_prompt: str | None = None) -> str:
    pr = workspace.pr
    files = "\n".join(f"- {name}" for name in workspace.reviewed_diff.changed_files)
    prompt = f"""\
Review this pull request.

PR: {pr.url}
Title: {pr.title}
Number: {pr.number}
Base ref: {workspace.reviewed_diff.base_ref}
Head ref: {workspace.reviewed_diff.head_ref}
Merge base: {workspace.reviewed_diff.merge_base}

Changed files:
{files or "- (none)"}

Diff stat:
{workspace.reviewed_diff.diff_stat or "(empty)"}

You are in the PR workspace. Inspect files as needed and compare the PR against
the full diff below. Return exactly one JSON object and no prose, markdown, or
code fence. The JSON shape is:
{REVIEW_JSON_SHAPE}

Full diff:
{workspace.diff_patch or "(empty)"}
"""
    if extra_prompt:
        prompt += f"\nAdditional review constraints:\n{extra_prompt}\n"
    return prompt


def build_architecture_prompt(workspace: ReviewWorkspace, *, review_prompt: str) -> str:
    files = "\n".join(f"- {name}" for name in workspace.reviewed_diff.changed_files)
    return f"""\
Review this local architecture diff.

Review goal:
{review_prompt}

Base ref: {workspace.reviewed_diff.base_ref}
Head ref: {workspace.reviewed_diff.head_ref}
Merge base: {workspace.reviewed_diff.merge_base}

Changed files:
{files or "- (none)"}

Diff stat:
{workspace.reviewed_diff.diff_stat or "(empty)"}

You are in the workspace being reviewed. Inspect files as needed and compare the
current local changes against the full diff below. Return exactly one JSON
object and no prose, markdown, or code fence. The JSON shape is:
{REVIEW_JSON_SHAPE}

Full diff:
{workspace.diff_patch or "(empty)"}
"""
