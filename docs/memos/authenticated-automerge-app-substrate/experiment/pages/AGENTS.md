# Pages contributor instructions

Pages rich text is being rebuilt around one model. Before touching the document
model, codec, Markdown, comments content, or agent write tools, read
[RICH-TEXT-V2.md](RICH-TEXT-V2.md). It sets the replacement's direction;
the implementation and tests establish current behavior. Keep the two distinct.

| Task | Start with |
| --- | --- |
| Rich text, codec, Markdown edge, agent tools | [RICH-TEXT-V2.md](RICH-TEXT-V2.md) |
| Current host, viewer, tool behavior | [REFERENCE.md](REFERENCE.md), then the code and its colocated tests |
| Setup and tests | [README.md](README.md#run-locally) |
| Targets and releases | [DEPLOYMENT.md](DEPLOYMENT.md) |

The directory and npm workspace names still contain `experiment`. Pages is a
product. [archive/](archive/) holds superseded notes; don't follow them.

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
- Fresh-target work does not need historical adapter-byte parity. Retire
  obsolete fixtures alongside replaced code, not useful behavioral regressions.
- Make reversible engineering choices in isolated experiments and record the
  evidence. Do not turn a research proposal into an approved product feature cut.

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

Run setup and the Pages build from the containing `experiment` workspace
([Run locally](README.md#run-locally)). Pages uses celld and a loopback OIDC
issuer; `cargo xtask dev` doesn't start it.

1. Run the narrow tests for the contract you changed.
2. Run `npm test --workspace @nteract/pages-native-experiment` and the build.
3. Shared backend changes: also run `npm test` in `experiment`.
4. Browser changes: run the relevant E2E suites and check wide and narrow
   widths ([Verify changes](README.md#verify-changes)).
5. From the repo root, before committing: `cargo xtask lint --fix`.

Leave `pages.runtimed.run` unchanged: no deployment, reset, migration, or
automatic promotion. Build and deploy experiments on a separate service;
`pages2` is a candidate, and page10 resets are permitted. Verify actual target
isolation and preservation needs before mutations. Read
[DEPLOYMENT.md](DEPLOYMENT.md) before release work. Local tests don't qualify
a live identity provider or object-store failover.
