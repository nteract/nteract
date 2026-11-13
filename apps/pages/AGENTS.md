# Pages contributor instructions

Read [DIRECTION.md](DIRECTION.md) first. It is the one direction for Pages
work: the destination, the order of work, what to delete, and the rules for
deployed targets. The implementation and tests establish current behavior.
Keep the two distinct.

| Task | Start with |
| --- | --- |
| Where Pages is going, what to build or delete next | [DIRECTION.md](DIRECTION.md) |
| Current host, viewer, tool behavior | [REFERENCE.md](REFERENCE.md), then the code and its colocated tests |
| Setup and tests | [README.md](README.md#run-locally) |
| Targets and releases | [DEPLOYMENT.md](DEPLOYMENT.md) |

The gate workflow is still `authenticated-automerge-spike.yml` ("Pages
experiment"). The page10 controller and `scripts/promote-artifact.mjs` pin
that name, so it changes with them. Pages is a product. [archive/](archive/)
holds superseded notes; don't follow them.

## Rules for rich-text work

- The Wordgard tree is the only in-memory model. Don't add ProseMirror code,
  dependencies, or PM trees as validators.
- Markdown is an agent-edge format. Never store it or route editor or host
  writes through it.
- Preserve text and marker identity with targeted splices, marks, and per-key
  marker edits. Test broad projection diffs against concurrent edits and
  comment anchors; `A.updateBlock` is not an in-place attribute update.
- Movable order is a map plus fractional `position`. No Automerge lists for it.
  Test tie allocation without overwriting concurrent moves.
- Handle concurrent merge outcomes deterministically without discarding
  content. A decoder's tolerance does not replace host admission checks.
- No parity work. Don't compare bytes with an earlier encoder or add
  compatibility matrices. Delete fixtures that pin replaced code; keep tests
  that state behavior.
- Decide reversible engineering choices in the pull request. Bring the
  maintainer a choice when it changes what people can do, who can reach the
  service, where it runs, or what happens to existing documents.

## Ownership

- The Page host owns admission, authorization, persistence and durable
  receipts. Browser replicas and UI state never confer access or prove
  durability. Keep host checks aligned across plain Automerge sync and tool
  writes.
- Pages has a content document and a separate comments document. Notebook
  `NotebookDoc`, `CommentsDoc` and daemon rules don't apply.
- Project members (viewer, commenter, editor) inherit access to every Page in
  the Project. The Project owner owns every Page in it, including Pages an
  editor adds. Only the owner shares, moves or trashes Project Pages. Direct
  Page grants never reach a Page's Project, siblings or descendants.
- Every stored fact has one normative home, and each table or key says so where
  it is created. Durable Objects and D1 are both durable, and neither is
  inherently the source of truth. Name which kind of state you are adding:
  - **Normative in a Durable Object, projected into D1.** The Durable Object
    (Page host, Catalog, Project) is the truth and the D1 row is a derived copy
    kept in sync with it, for listing and search. A projection table can be
    cleared and rebuilt; its code never invents data. The `pages_catalog_`
    prefix means this kind.
  - **Normative in D1.** The D1 table is the only copy, with no Durable Object
    behind it (Page tags in `page_tags`, quota rules, memberships,
    invitations, sessions and OAuth grants). Never name it `pages_catalog_*`,
    and no reconcile pass, repair or migration may clear or rewrite its rows.
    Add a Durable Object only for state with a real-time or single-writer
    need; do not add one to mirror D1 data that needs only REST access.
  - Don't call a table an index, a cache or a projection unless something can
    regenerate it. Say "normative" when nothing can. See
    [Where state lives](DEPLOYMENT.md#where-state-lives).
- Respect observed revisions, conflict scopes and idempotency receipts. A retry
  resumes the recorded operation; it never duplicates a mutation.
- Async lifecycles use the repository's state-machine and RxJS rules. Keep
  local drafts, synced content and host-confirmed persistence distinct.

## Develop and verify

Run setup and the Pages build from `apps/pages`
([Run locally](README.md#run-locally)). Pages uses celld and a loopback OIDC
issuer; `cargo xtask dev` doesn't start it.

1. Run the narrow tests for the contract you changed.
2. Run `npm test` and the build.
3. Sync backend changes: also run `npm run test:contract`.
4. Browser changes: run the relevant E2E suites and check wide and narrow
   widths ([Verify changes](README.md#verify-changes)).
5. From the repo root, before committing: `cargo xtask lint --fix`.

`pages.runtimed.run` holds documents people use: don't reset it and don't build
a migration from it. It runs the commit tagged `pages-format-1`. Nothing from
`main` deploys there: a fix goes on a maintenance branch cut from that tag. The
other targets the deployment helpers know are demos and can be reset. A
deployment someone made from the
[release package](DEPLOYMENT.md#deployment-neutral-release-package) is not in
that list. It takes builds of `main` and can hold documents people use: don't
reset it or delete from it, and say so in the PR when a change stops a stored
document from opening. Confirm which target a command
addresses before it mutates anything. Read
[DEPLOYMENT.md](DEPLOYMENT.md) before release work. Local tests don't qualify
a live identity provider or object-store failover.
