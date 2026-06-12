---
name: architecture
description: Architecture and documentation framing for cross-cutting repo decisions, docs taxonomy placement, ADRs, memos, PRDs, implementation plans, audits, measurements, runbooks, and source-grounded proposals. Use when deciding where durable docs belong, drafting or moving architecture/product/design docs, or promoting `.context/` notes into repo docs. Do not use for routine code changes unless they require durable cross-functional documentation.
---

# Architecture and Documentation

Use this skill when the work is about durable architecture, product, or design
documentation, or when deciding where a document belongs. Do not load it for
routine implementation notes, test plans, or ordinary code changes.

## Default Path

- Start working notes in `.context/`.
- Keep routine implementation notes in the PR body, code comments, or final response.
- Promote only when the artifact should outlive the immediate change and help
  product, design, engineering, research, or AI collaborators.

## Placement

- `docs/memos/`: shared thinking, research, options, and RFC-style proposals
  before there is a decision.
- `docs/adr/`: durable technical decisions, invariants, compatibility
  boundaries, and rejected alternatives.
- `docs/prd/`: user-facing requirements, workflows, roles, and launch criteria.
- `docs/plans/`: scoped execution plans for already-framed work.
- `docs/audits/`: source-backed evidence and follow-up lists.
- `docs/measurements/`: benchmark evidence and performance models.
- `docs/runbooks/`: operational procedures.
- `docs/handoffs/`: time-bound transfer notes.

## Workflow

1. Read `docs/README.md` and the relevant directory README before creating or
   moving durable docs.
2. When moving docs, update indexes and cross-links; search for old paths with
   `git grep`.
3. Prefer the smallest durable artifact. Mark contentious sections as open
   questions or commentary instead of forcing them into a decision.
4. Run focused link/path checks for moved docs and `cargo xtask lint --fix`
   before commit.
