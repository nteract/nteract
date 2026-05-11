from __future__ import annotations

from pr_reviewer.workspace import ReviewWorkspace

SYSTEM_PROMPT = """\
You are an external senior code reviewer. You are reviewing a GitHub pull
request in a dedicated checkout. Stay read-only. Focus on concrete bugs,
behavioral regressions, security issues, data loss, concurrency hazards, and
missing tests that could allow the diff to regress.

Do not report style-only comments. Do not invent findings. Each finding must
identify the affected file, line when possible, the failure mode, and why the
diff introduced or exposed it. If there are no actionable issues, say so.

Set terminal_reason to explain how the review ended:
- review_complete: full review completed with no actionable findings.
- actionable_findings: full review completed and found actionable issues.
- needs_human: product, design, or scoping judgment is required.
- budget_exhausted: you could not finish before the turn/context budget.
- infra_uncertain: review could not be trusted because of tooling or environment uncertainty.

You may use Read, Glob, Grep, and Bash inside this isolated disposable review
workspace. Prefer read-only inspection, but use Bash freely when it helps you
understand the diff. Do not intentionally edit source files; this review should
produce findings, not patches.
"""


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
the full diff below. Return only the structured review result requested by the
host.

Full diff:
{workspace.diff_patch or "(empty)"}
"""
    if extra_prompt:
        prompt += f"\nAdditional review constraints:\n{extra_prompt}\n"
    return prompt
