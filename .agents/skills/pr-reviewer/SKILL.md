---
name: pr-reviewer
description: Use the repository-local pr-review CLI for Bedrock-authenticated Claude Agent SDK reviews of GitHub pull requests, branch diffs, or review loops. Use when a task asks for an external/Claude/Bedrock review, a second-model PR review, structured review findings, or validation of an implementation PR.
---

# PR Reviewer

Use `pr-review` instead of shelling out to raw `claude` for PR reviews in this repository. It creates an isolated disposable git worktree, authenticates Claude through Bedrock, gives the reviewer the PR diff plus repo access, and writes structured JSON reports.

## When To Use

- The user asks for a Claude, Bedrock, external, second-model, or structured PR review.
- You have opened or updated a PR and need a reviewer pass before marking work complete.
- You need a machine-readable review result with `verdict`, `terminal_reason`, findings, model, session id, cost, and diff metadata.

## Commands

Smoke-test Bedrock auth first when setup may have drifted:

```bash
uv run pr-review doctor
```

Review a GitHub PR:

```bash
uv run pr-review https://github.com/nteract/nteract/pull/<number> \
  --max-turns 120 \
  --out .context/reviews/pr-<number>.json
```

For large diffs, raise `--max-turns`. If omitted, `pr-review` estimates a turn budget from changed files and diff size.

## Read The Report

Inspect the structured result before reporting or acting:

```bash
jq '.report | {verdict, terminal_reason, summary, findings, model, session_id, cost_usd}' \
  .context/reviews/pr-<number>.json
```

Meanings:

- `verdict: clear` with `terminal_reason: review_complete` means the reviewer completed and found no actionable issues.
- `verdict: findings` means triage each finding locally before reporting or patching.
- `verdict: needs_human` means a product, design, or scoping decision is needed.
- `terminal_reason: budget_exhausted` means rerun with a higher `--max-turns`.
- `verdict: infra_uncertain` or `terminal_reason: infra_uncertain` means do not trust the review as a quality signal until the infrastructure issue is resolved.

## Review Loop

1. Run `uv run pr-review doctor` if Bedrock/model access is uncertain.
2. Run `pr-review` against the real PR URL, not a pasted diff.
3. Read the JSON report from `.context/reviews/`.
4. For every finding, assign a disposition:
   - `confirmed-fix`: verified and fixed.
   - `confirmed-defer`: verified but intentionally deferred with a reason.
   - `not-reproduced`: plausible but not verified.
   - `non-issue`: contradicted by local code, tests, or repo policy.
   - `needs-human`: requires product/design/scoping judgment.
5. If you fix anything, commit/push and rerun `pr-review` on the PR.
6. Do not mark the PR ready or the task complete until findings are fixed, intentionally deferred, or shown to be non-issues.

## Guardrails

- Do not use `claude ultrareview`; it consumes limited Claude reviews.
- Do not substitute regular Claude/Max auth if Bedrock fails. Report the blocking Bedrock failure.
- Treat reviewer output as advisory until locally verified.
- Preserve review-only mode: if the user asked only for review, do not edit files.
- The CLI may create review worktrees and reports under `.context/`; that path is intentionally untracked.
