# Pages

A runnable, private Pages service on celld. A browser and an agent authenticated
to the same OIDC account work on the same documents. Markdown renders through
nteract's Rust Markdown engine and shared `ProjectedMarkdownView`.

This is an initial service, not a full Spaces replacement. The account owns one
workspace Durable Object, with an independent Automerge document per Page.
There are no kernels or executable cells. Code fences are document content.

## Run locally

Requires Node, pnpm, Rust with `wasm32-unknown-unknown`, and celld 0.6.1 or later
with `celld dev`. From the repository root:

```sh
pnpm install
pnpm --dir apps/pages build
pnpm --dir apps/pages dev
```

Open <http://localhost:9890> and sign in. Development runs the real PKCE,
nonce validation, server token exchange, and HttpOnly session flow against
`@nteract/local-oidc`. This local provider automatically grants `dev@localhost`;
it is not a production login challenge. Both request and configured public
origin must be loopback before its routes can run.

`PAGES_PORT` changes the port. State survives process restarts in
`dist/.celld/dev`. The build preserves that directory. Do not delete `dist` to
rebuild if you want to retain local Pages. The dev session secret is generated
in ignored `dist/.dev.vars`, retained on restart, and never sent to the browser.

## Storage and identity

The service reuses nteract's server OIDC and session implementation directly
from `apps/notebook-cloud/src`. It does not fork the auth protocol or copy
tokens into browser storage. Server-login deployments (the default) accept only
their own session cookie with same-origin checks, and reject raw provider tokens.
This prevents a token issued through a shared OAuth client on another endpoint
from directly accessing Pages. Agent credentials scoped to Pages are not yet
implemented. Dedicated bearer-only installations can omit
`NOTEBOOK_CLOUD_OIDC_FLOW=server` and send an OIDC access token in
`Authorization: Bearer …`; do not use that mode with the shared preview client.
Workspace addressing binds the configured issuer and verified principal.
Client-supplied identity headers are discarded.

Inside a workspace, every Page stores:

- An Automerge document containing a title, block map, and ordered block IDs.
  Block Markdown is Automerge text; updates use `updateText`, not wholesale
  replacement of block objects. Instruction blocks are an explicit kind.
- A server sequence and the last 128 change receipts, separate from the CRDT.
- Idempotency receipts for creation and the last 128 edits.

Block IDs are stored identities. Markdown parser node IDs are disposable
rendering details within a block. Metadata remains with a block across text
edits and moves. Per-block hashes include kind, Markdown, and canonicalized
metadata; they are opaque guards, not a claim of hash compatibility with Spaces.

The workspace serializes calls across async hashing and storage. It persists
the page, sequence, receipts, and catalog together using Durable Object
storage's atomic multi-key `put`. It returns success only after persistence.
A storage exception returns `commit_status: unknown`, because an acknowledged
write and a failed reply are different things. Fleet bucket durability remains
the operator's celld configuration; local dev proves local restart recovery.

The browser polls every 15 seconds and submits explicit guarded saves. The
current transport does not accept untrusted Automerge deltas or provide offline
editing. The CRDT is real storage, but this is not yet a browser sync protocol.
Two devices can read and edit; stale saves are rejected and retain the local
draft. The editor can compare the current saved block before the user explicitly
chooses a new base. Drafts are retained in per-tab `sessionStorage`, keyed to an
opaque account identifier, and recover after signing back in to the same account.
No OIDC credentials enter browser storage. Raw HTML and MDX remain source text
when they need an isolated renderer.

Each stored Page value and the catalog have a conservative 1.5 MiB JSON budget
(including byte arrays, receipts, and history), checked before persistence.
This can become the limiting factor before the 1 MiB content limit. A rejected
size check is definite and does not modify stored content.

## Tool contract

`GET /api/capabilities` advertises the implemented subset and limits. Call tools
with `POST /api/tools`:

```json
{
  "operation": "read_page",
  "arguments": { "page_id": "page_observed_id", "view": "editing" }
}
```

The shape follows the observed Spaces connector: `page_id`, ordered `blocks`,
`id`, `kind`, `markdown`, `metadata`, `hash`, `title_hash`, and
`through_sequence`. This is a separate HTTP API, not an MCP server or a promise
of drop-in connector compatibility. The service does not connect to or modify
ChatGPT Pages. Existing tools need a small transport adapter.

| Operation | Supported arguments / behavior |
| --- | --- |
| `list_spaces`, `get_space` | One private space, no root Page; `space_id` is validated when supplied. |
| `list_pages` | All Pages in the bounded private workspace; no pagination needed below the 1000-Page cap. |
| `create_page` | `title`, `block_units` or `markdown`, required `idempotency_key`. Returns the created Page and snapshot. |
| `read_page` | `page_id`, `view: editing/full`, `search` literals or observed `block_ids`, optional `include_content: false`. Always includes instruction blocks in selected content and reports missing IDs. |
| `edit_page` | `page_id`, required `base_sequence`, `idempotency_key`, and `operations`. Atomic structural batch. |
| `patch_page` | Same envelope; only `patch_block_markdown`. Partial results, one receipt per operation. |
| `read_page_changes` | `page_id`, `since_sequence`. Changed blocks, deletion IDs, complete current block order, title, and authenticated actor records; `resync_required` outside retained history. |

Edits support `set_title`, `insert_markdown` with observed `between_blocks`
anchors, `replace_block_markdown`, `delete_block`, `move_block`, and
`set_block_metadata`. Replacement/deletion/metadata require `expected_hash`.
Title changes require `expected_title_hash`. All edits require an observed
`base_sequence`, including moves. This is deliberately stricter than Spaces'
optional page sequence. Insertion can accept explicit `block_units`; a single
Markdown string stays one block and is not split by blank lines.

```json
{
  "operation": "patch_page",
  "arguments": {
    "page_id": "page_observed_id",
    "base_sequence": 7,
    "idempotency_key": "a-unique-key-for-this-exact-request",
    "operations": [{
      "op": "patch_block_markdown",
      "block_id": "observed-block-id",
      "expected_hash": "observed-hash",
      "replacements": [{ "old": "Draft", "new": "Ready for review" }]
    }]
  }
}
```

Patch literals must each occur exactly once in the original block and may not
overlap. Patch each block once per batch. Instruction blocks require explicit
whole-block editing. A rejected structural batch changes nothing; partial patch
batches return applied/rejected receipts. Do not replay successful siblings
under a new key. After an uncertain outcome retry the identical request with
the same key, or reread. A reused key with different content is rejected.
After receipt eviction an old base sequence prevents silent replay.
An entirely rejected patch batch neither writes a receipt nor advances history.

Not implemented: multi-user sharing, nested/multiple Spaces, comments,
attachments, native artifacts, scratch streams, excerpts, in-block/Yjs anchors,
semantic reconciliation, task dispatch, or execution. No wording in a Page or
instruction block grants runtime authority. Read the capability endpoint before
adapting a tool workflow that expects these features.

## Deployment

The build writes a self-contained celld project to `dist`: Worker JavaScript,
Automerge WASM, Markdown WASM, viewer assets, and `wrangler.json`. Deploy that
directory to a **separate celld fleet/store**; a fleet has one application.
Do not reuse a running notebook fleet's deployment destination.

Set these Worker variables in the deployment configuration/secrets, following
the existing nteract OIDC provider configuration:

```text
NOTEBOOK_CLOUD_OIDC_FLOW=server
NOTEBOOK_CLOUD_PUBLIC_ORIGIN=https://pages.example.com
NOTEBOOK_CLOUD_OIDC_ISSUER=https://your-issuer.example.com
NOTEBOOK_CLOUD_OIDC_CLIENT_ID=your-client-id
NOTEBOOK_CLOUD_OIDC_AUDIENCE=your-api-audience
NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE=your-provider-namespace
NOTEBOOK_CLOUD_APP_SESSION_SECRET=<a-new-random-secret-at-least-32-characters>
```

Register `https://pages.example.com/oidc` with the provider. Confidential clients
can also set `NOTEBOOK_CLOUD_OIDC_CLIENT_SECRET` and
`NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD` as in nteract. Never enable
`NOTEBOOK_CLOUD_LOCAL_OIDC` for a public deployment. Terminate TLS at ingress.
The D1 binding is for auth transactions and sessions; Pages use Durable Object
storage. No public deployment is created by build or dev.

### Proposed `m.runtimed.run` deployment

Use the production Anaconda public-PKCE client already configured for
`*.runtimed.run`, with the following public settings (verified against the
existing host configuration and provider discovery on 2026-10-17):

```text
NOTEBOOK_CLOUD_OIDC_FLOW=server
NOTEBOOK_CLOUD_PUBLIC_ORIGIN=https://m.runtimed.run
NOTEBOOK_CLOUD_OIDC_REDIRECT_URI=https://m.runtimed.run/oidc
NOTEBOOK_CLOUD_OIDC_ISSUER=https://auth.anaconda.com/api/auth
NOTEBOOK_CLOUD_OIDC_CLIENT_ID=1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0
NOTEBOOK_CLOUD_OIDC_AUDIENCE=anaconda,1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0
NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE=runtimed-pages-anaconda
NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD=none
NOTEBOOK_CLOUD_OIDC_USERINFO=true
```

Generate a separate persistent session secret; never copy a notebook preview's
secret or local development state. The callback still needs a live browser
qualification; provider discovery alone does not prove wildcard acceptance.

The current notebook preview router does not accept `m.runtimed.run`. Pages
needs an exact ingress route to its own private Worker listener, ahead of the
wildcard preview route, plus its own DNS record. Keep the operator listener
private. Use a separately pinned celld runtime: the application was tested with
0.6.1, while lab1's shared runtime was observed at 0.5.1. Do not replace that
shared binary to deploy Pages. Host selection, storage destination, ingress,
and live login qualification remain pending; this configuration is not a claim
that the hostname is deployed.

## Verification

```sh
pnpm --dir apps/pages test
pnpm --dir apps/pages typecheck
pnpm --dir apps/pages build
# With the dev service running:
pnpm --dir apps/pages smoke
```

The tests cover concurrent text merging, stale guards, atomic rollback, partial
patches, Unicode, stable identity, idempotency, storage failure, HTTP call
serialization, change cursors, workspace separation, and CSRF boundaries.
