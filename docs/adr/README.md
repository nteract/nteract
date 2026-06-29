# Architecture Decision Register

This directory is the durable architecture register for nteract notebook rooms,
runtime state, output transport, hosted sharing, and related daemon invariants.

Exploratory research and cross-functional framing start in
`docs/memos/`. Memos are source-grounded but not decision-authoritative; durable
technical decisions graduate back into this ADR register.

## ADR Statuses

- **Accepted**: load-bearing decision that current and future work should treat
  as the architectural source of truth.
- **Draft**: proposed or recently extracted decision that should be reviewed
  before being used as a hard dependency.
- **Proposed**: scoped direction for a planned change that still needs review
  or implementation evidence before it becomes a decision.
- **In progress**: design line with landed slices and remaining open work;
  review the "Done" / "Next" sections before treating it as complete.

## Maintenance Rules

1. New ADRs should start with `# Title` and `**Status:** ...` in the first few
   lines.
2. Use `Accepted` only when the decision is ready to guide future code review.
3. Use ADRs for durable technical decisions, rejected alternatives, invariants,
   and compatibility boundaries.
4. Record architectural smells in the owning ADR's "Open Follow-ups" section
   instead of hiding them in prose-only open questions.
5. When a tracked follow-up lands, remove its bullet from the ADR's
   "Open Follow-ups" section in the same patch, recording the evidence in
   the relevant decision text if it changed one.
