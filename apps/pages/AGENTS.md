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
a migration from it. A format 1 release may be promoted to it by hand once
page10 runs the same build; format 2 work never deploys there. Every other
deployed target is a demo and can be reset. Confirm which target a command
addresses before it mutates anything. Read
[DEPLOYMENT.md](DEPLOYMENT.md) before release work. Local tests don't qualify
a live identity provider or object-store failover.
