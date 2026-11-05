# Pages contributor instructions

Pages is a rich collaborative document product in the nteract monorepo. Its
historical directory and npm workspace name still contain `experiment`.
Start with [README.md](README.md) for current behavior, local setup, and tests;
use [DEPLOYMENT.md](DEPLOYMENT.md) for release targets and qualification.

## Product and ownership

- Pages combines writing, images, diagrams, tables, task lists, interactive
  dataframes, and passage comments. Keep the experience expressive and enjoyable
  for people, with equivalent content operations available to agents.
- The Wordgard browser editor and HTTP/MCP tools edit the same native Automerge
  content. Markdown is an import/export and agent projection. Preserve content
  that projection cannot represent, including dataframe nodes.
- Pages has its own content document and a separate comments document. Its
  model is independent of notebook `NotebookDoc`, `CommentsDoc`, and runtime
  documents. Code blocks display source; there is no notebook kernel in Pages.
- The Page host owns admission, authorization, persistence, and durable receipts.
  Browser replicas and UI state do not confer access or establish remote
  durability. Keep host checks aligned across native sync and tool writes.
- Projects organize Pages. Project membership is currently owner-only, and Page
  sharing uses direct grants. Do not infer inherited access from a Page's location.

## Editing contracts

Read the implementation and its colocated tests before changing behavior. The
README's document/editor, comments, and HTTP/MCP sections describe the current
contracts and their limits.

- Keep browser and agent writes consistent with the node and mark registries,
  shared encoding, and schema-feature gates. Preserve unknown content.
- Preserve block identity, text objects, and cursor anchors when editing or
  moving content; comments and agent selectors depend on them.
- Respect observed revisions, conflict scopes, and idempotency receipts. A
  retry must resume the recorded operation rather than duplicate a mutation.
- Use the repository's explicit state-machine and RxJS rules for async work.
  Keep local drafts, synced content, and host-confirmed persistence distinct.

## Development and verification

Pages uses the containing npm integration workspace. Run setup and the Pages
build from that workspace as documented in [Run locally](README.md#run-locally).
The local server uses celld and a loopback OIDC issuer; the notebook desktop
`cargo xtask dev` workflow does not launch Pages.

Run the narrow model, viewer, worker, or script tests for the changed contract,
then the Pages suite and build as needed. Shared backend changes also need the
containing integration suite. Browser changes need the relevant local E2E
suites and visual checks at wide and narrow widths. The
[verification guide](README.md#verify-changes) owns commands, runtime versions,
fixture boundaries, and artifact locations.

Use local fixtures for development. Deployment scripts, target names, and
historical profiles are operational boundaries; consult the deployment guide
before release work. A passing local test does not establish live identity
provider behavior or object-store failover durability.
