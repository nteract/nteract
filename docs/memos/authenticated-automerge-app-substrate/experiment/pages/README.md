# Pages

Pages is an **actively maintained experiment** in collaborative documents for
people and agents. People write in a rich editor; agents read and edit Markdown
through HTTP or MCP. Both work on the same Automerge document, with passage
comments, presence, private images, and host-enforced sharing.

The application evaluates experimental Automerge Repo 3 and Subduction as a
shared document foundation. It has its own document model and deployment; it
does not migrate or replace nteract notebooks. APIs, editor behavior, and resource
limits may evolve as the experiment is exercised. Page8 is the current isolated
QA deployment; Page7 and earlier deployments remain frozen.

- [Architecture and motivation](../../README.md)
- [Shared integration workspace](../README.md) and [upstream provenance and patches](../UPSTREAM.md)
- [Deployment and rollback boundaries](DEPLOYMENT.md)

## Run locally

Use Node 22.13 or newer, Git, npm, and `celld` on `PATH`. The local E2E harness
requires celld 0.6.3; use that runtime to qualify the current profile. From the containing `experiment` directory:

```sh
npm run setup
npm run build --workspace @nteract/pages-native-experiment
PAGES_ASYNC_PERSISTENCE=true PAGES_COMPACT_RECORDS=true \
  npm run dev --workspace @nteract/pages-native-experiment
```

Setup fetches and verifies the pinned upstream source, installs the locked
workspace dependencies, and builds the Repo packages. The separate Pages build
must finish before `dev`; rebuild after source changes. The dev command serves
`http://localhost:9894`. Set `PAGES_PORT` to use another port.

Wordgard is the only browser editor, locally and in deployed Pages. The
`PAGES_EDITOR` comparison flag is no longer used. These flags enable background
record persistence and lossless record cleanup used by Page8; without them,
local persistence is synchronous. A Page records its storage mode at creation:
changing a persistence flag does not migrate existing local documents.

Local sign-in uses a loopback-only OIDC issuer. State persists under
`pages/dist/.celld`; local credentials and build output are ignored. The dev
issuer cannot be enabled on a public deployment by copying its flag. Browser
and Worker entry points share the workspace's pinned Automerge version and
initialize their respective WASM packaging.

## Verify changes

From `experiment`:

```sh
npm test
npm test --workspace @nteract/pages-native-experiment
npm run build --workspace @nteract/pages-native-experiment
npx playwright install chromium
npm run e2e --workspace @nteract/pages-native-experiment
```

`npm run e2e` builds once, then runs each curated browser suite in turn against
its own loopback celld 0.6.3 with temporary state and a per-suite timeout. Name
suites to run a subset (`npm run e2e --workspace @nteract/pages-native-experiment -- wordgard sharing`);
`node scripts/e2e.mjs --list` shows them, including opt-in suites that run only
when named. Each suite's log, celld log, report, and screenshots (failure
screenshots and HTML included) land in `pages/test-results/e2e-<timestamp>/<suite>/`.
Any failure exits non-zero. `PAGES_E2E_RETRIES=1` reruns a failed suite once in
a fresh fixture and reports a pass on retry as flaky; more flaky suites than
`PAGES_E2E_MAX_FLAKY` (default 1) also fail the run. Each suite's result is
appended to `results.jsonl` and `summary.json` as it finishes.

The Pages experiment workflow runs setup, both unit-test suites, and the Pages
build in one job. A second job downloads the official celld 0.6.3 Linux x86_64
release, checks the archive hash and the executable hash in `CELLD_RELEASE`,
installs Playwright's Chromium with system dependencies, runs `npm run e2e` with
one retry and a flaky budget of one, and always uploads `test-results/`. On a
fresh Linux runner, install browser system dependencies with
`npx playwright install --with-deps chromium`.

The sharing suite (also `npm run test:e2e:sharing`) builds Pages and starts an
isolated celld process on an available loopback port. Three browser profiles use the real local OIDC
code/PKCE flow to test invitations, viewer/editor roles, edits, promotion,
downgrade, revocation, reload, and reconnect. Generated API keys exercise the
normal validator, MCP, ACL, and sync paths through a test-only provider response.
That fixture rejects external fetches and is absent from the production entry;
it does not qualify Anaconda's live provider or key issuance.

E2E state and credentials are temporary; existing `dist/.dev.vars` and
`dist/.celld` are not reused. Reports, screenshots, and logs remain under
`pages/test-results/sharing-<timestamp>`. `CELLD_BIN` selects the runtime,
`PAGES_E2E_OUTPUT` selects the output directory, and `--skip-build` reuses a build.

Run targeted browser checks from `pages`. `npm run e2e` runs all of these by
default except the latency check, which records timings rather than gating
on them, and the build-update check. That one is opt-in until a Page reopened
after a celld restart reliably reaches Saved; under load it can stall at "The
request timed out" (fix in progress on `fix/pages-restart-saved-stall`). Its
text-order failure ([#4547](https://github.com/nteract/nteract/issues/4547))
was a caret race in the smoke; the editor side is
[#4552](https://github.com/nteract/nteract/issues/4552).

| Check | Command | Server lifecycle |
| --- | --- | --- |
| Company-domain access | `node scripts/local-sharing-e2e.mjs --domain-view` | Starts an isolated fixture |
| Browser uploads and image permissions | `node scripts/local-sharing-e2e.mjs --images` | Starts an isolated fixture |
| MCP file import, insertion, and retries | `node scripts/local-sharing-e2e.mjs --mcp-images` | Starts an isolated fixture |
| Collaborative checkboxes | `node scripts/local-sharing-e2e.mjs --task-lists` | Starts an isolated fixture |
| Admission codes, celld restart, and reconnect to Saved | `node scripts/local-sharing-e2e.mjs --admission` | Starts and restarts an isolated fixture |
| Reload prompt after a deploy under an open tab | `node scripts/local-sharing-e2e.mjs --build-update` | Starts an isolated fixture and swaps its build |
| Trash, restore, and permanent deletion | `node scripts/local-sharing-e2e.mjs --trash` | Starts an isolated fixture |
| Projects over MCP and in the browser, `/projects` and `/pages` on a phone-sized screen, breadcrumbs, Trash and restore in a Project | `node scripts/local-sharing-e2e.mjs --projects` | Starts an isolated fixture |
| Rollback to a previous build and forward again on one data directory | `node scripts/rollback-qualification.mjs --previous <previous pages dir>` | Starts an isolated fixture; build the previous commit first |
| Rich comment tables and drafts | `PAGES_ORIGIN=http://localhost:9894 node scripts/rich-comments-smoke.mjs` | Uses the running Wordgard fixture |
| Comments panel placement at 1920/1440/1100/800px | `PAGES_ORIGIN=http://localhost:9894 node scripts/comments-layout-smoke.mjs` | Uses the running Wordgard fixture |
| Native table editing | `PAGES_ORIGIN=http://localhost:9894 npm run smoke:tables` | Uses the running Wordgard fixture |
| Passage edits and revision deltas | `PAGES_ORIGIN=http://localhost:9894 node scripts/passages-changes-smoke.mjs` | Uses the running Wordgard fixture |
| Local creation and navigation | `PAGES_ORIGIN=http://localhost:9894 node scripts/navigation-smoke.mjs` | Uses the running Wordgard fixture |
| Editing, comments, links, diagrams, and recovery | `PAGES_ORIGIN=http://localhost:9894 npm run smoke:editor` | Uses the running Wordgard fixture |
| History growth and typing latency | `PAGES_ORIGIN=http://localhost:9894 node scripts/latency-smoke.mjs` | Uses the running Wordgard fixture with buffered persistence |
| Client catch-up after reopening a Page far behind the host | `node scripts/catch-up-benchmark.mjs --runs 5 2000+2000` | No server; in-process Repo peers over the authenticated wire, Node with MemoryByteStore (no IndexedDB or editor cost) |

Use `PAGES_ASYNC_PERSISTENCE=true` for the latency check. The editor checks
exercise the same Wordgard path used by deployed Pages.

Choose one `local-sharing-e2e.mjs` feature flag per run. Its image importer fixture
supplies a synthetic ChatGPT download response; actual client file handoff needs
live verification. Synthetic browser tests also do not establish real OS IME,
mobile-keyboard, object-store failover, or deployment reliability.

## Document and editor

A Page contains its title, stable ordered block IDs, rich text, and comments in
Automerge. Markdown is the import/export and tool projection. A dedicated title
is displayed above the body; agents should not repeat it as an opening heading.
Authoring receipts warn about likely duplicates without removing or hiding text.

Wordgard is the sole editor and applies native text splices, marks, and
structural spans. The shared Markdown codec still uses ProseMirror schema and
traversal libraries for import/export, validation, and passage-address mapping.
It does not own an editor or mediate Wordgard keystrokes. Keeping that codec
preserves existing documents, comment anchors, and MCP operations while the
browser editor is simplified; replacing it requires a separate compatibility
pass. Each Pages block has its own continuous editor. Moves update fractional positions without recreating the block or its
text object, preserving comment and selection anchors. Concurrent positions use
block IDs as deterministic ties. Cross-Pages-block selections remain unsupported.
The binding's upstream attribution is in [WORDGARD-NOTICE](viewer/WORDGARD-NOTICE).

The interface keeps navigation and account actions outside the document, with
contextual formatting, a searchable Pages list, and System/Light/Dark appearance
using nteract's shared tokens. Theme preferences are browser-local. **Copy as
Markdown** in Share exports the title and content, including private image
references; it does not publish the Page or change asset access.

- **Comments:** select a passage and choose Comment, or press Cmd/Ctrl+Alt+M.
  Highlighted passages and thread quotes navigate between text and discussion.
  Draft anchors capture native object identity and text cursors; deleted or
  replaced passages reject submission rather than moving a comment elsewhere.
  New browser comments use Wordgard for formatting, links, lists, and native
  table cells. Drafts retain their native spans until Send and survive responsive
  rail/sheet changes; changing Pages clears local drafts. Expand the sidebar for
  wider discussions. Agent comments opt in with `body_format: "markdown"` on
  `manage_page_comment`; rich comment reads return Markdown and the same format
  marker. Existing unmarked comments remain literal. Omitting the format when
  editing retains the message's current kind; `plain` can preserve literal syntax.
  Thread/message IDs and passage anchors stay unchanged. The original `body`
  string is frozen import provenance, not a current-content mirror for old
  clients; native `richText` is authoritative once marked rich. If native content
  cannot be decoded, reads return that original text with
  `content_error: "rich_text_unavailable"` rather than failing the entire Page. Source is limited to 16,000 characters and native structure
  to 64 KiB. Formatting-only changes appear in `read_page_changes`.
- **Highlights:** the formatting toolbar's highlighter offers the four palette
  colors and Remove; Cmd/Ctrl+Shift+H toggles yellow. A highlight is a text mark
  (`highlight`), so it syncs, merges, and follows edit permission like bold.
  Palette names resolve to theme tokens; agents can also set `#rrggbb`. Markdown
  projects highlights as `<mark data-color="…">…</mark>`. Comment anchors keep
  their own tint and underline; where they overlap a highlight, both tints show.
- **Mark registry:** [`model/marks.json`](model/marks.json) lists every inline
  mark with its value shape, expand rule, and Markdown projection. Validation,
  the Wordgard binding, Markdown import/export, the MCP `format_match` schema,
  and the Rust codec read it. Readers keep marks they don't know: they render as
  plain text and survive edits. Agents edit existing text through
  `replace_match` and `format_match`, which work on native spans; Markdown is
  for reading and for writing whole blocks.
- **Links:** click for Open, Edit, and Remove; Cmd/Ctrl-click opens directly and
  Cmd/Ctrl+K edits. Incoming edits update or dismiss the link control, and URL
  policy applies both to stored content and navigation.
- **Code and diagrams:** three backticks on an empty paragraph followed by Enter
  or Space creates code; a language can follow the backticks. Mermaid renders
  through nteract's Pele renderer and SVG sanitizer. Compact Edit diagram,
  Preview, and Copy diagram code controls switch the local view. Source and
  language are shared content; rendered SVG is not stored. Cmd/Ctrl+Enter
  continues in a paragraph. Pages does not execute code.
- **Tables:** native row/cell markers live in the same rich-text field as prose.
  Insert table chooses dimensions; Table options changes rows and columns. Tab
  moves between cells and appends a row at the end. The first row is the header.
  Preserved Markdown tables convert only through an explicit, undoable Edit
  table action; unsupported syntax stays preserved. Column resizing/moving and
  merged cells are not implemented.
- **Task lists:** use Task list or type `- [ ] ` / `- [x] `. Enter creates an
  unchecked item; an empty item returns to prose. Native list-item markers store
  checked state independently of the text, so checkbox and text edits can merge.
  Markdown preserves nested tasks. Read-only Pages disable checkbox changes.

## Opening, recovery, and ownership

Canonical links are `/p/<page_id>`; browser Back/Forward restores the corresponding
Page and legacy query links normalize. Direct links work independently of the
catalog but never bypass Page permissions.

Browser creation allocates the Page and history locally, persists them to
IndexedDB, and opens the editor while authenticated registration proceeds.
Retries reuse the same ID, immutable bootstrap, key, and server retry token.
Account-scoped checkpoints let other tabs recover pending work; each tab has its
own native signing identity/database, protected by Web Locks. Checkpoints merge
Automerge history, and local deletion tombstones prevent stale tabs from reviving
removed entries. Browser storage eviction is outside the recovery guarantee.
An existing local replica can open before network sync; this does not guarantee
an offline cold start of application assets or authentication.

```text
Browser Repo + Wordgard                 Authorized HTTP / MCP operations
            | authenticated binary sync             |
            +--------------------+-------------------+
                                 |
                         Page Durable Object
                         Repo + Subduction
                         host-owned access/control state
                                 |
                    PageRecords Durable Object (buffered mode)
                                 |
                         ctx.storage / runtime
                                 |
                     celld SQLite/LTX + fleet bucket
                      or Cloudflare SQLite Durable Objects
```

Catalog objects index owned/shared Pages; D1 stores server sessions and MCP OAuth
state, and (with `PAGES_CATALOG_INDEX`) a catalog projection for paginated, searchable
listings. See [Catalog index](#catalog-index). Ownership, ACLs, signing-key bindings, credential leases, and deletion are
host state outside the document. Unknown document fields are preserved; projecting
known content is not authority to rewrite the whole schema.

The byte-store adapter delegates persistence to `ctx.storage`. The runtime owns
replication and recovery; the application does not create a second SQLite store
or upload a new document snapshot for every edit. Images have a separate private
blob binding. See [upstream integration contracts](../UPSTREAM.md) and celld's
[durability guarantees](https://celld.dev/docs/guarantees/).

## Catalog index

Each account's `Catalog` Durable Object remains its discovery list: `page/<id>`
for owned Pages, `shared/<id>` for shared or company-opened Pages. Setting
`PAGES_CATALOG_INDEX` to an epoch label (for example `1`) also projects those
entries into D1 tables (`pages_catalog_pages`, `pages_catalog_access`) so
`list_pages` can paginate by cursor and search titles without opening every
shared Page. Migrations are versioned in
[catalog-index.mjs](worker/catalog-index.mjs) and applied lazily on first use.

D1 picks candidates; it never grants access. Every non-owner row returned by a
listing is verified by its Page host with the caller's credentials, and owner rows
must match the account's own Catalog entry. Each access row keeps its own title
snapshot, updated only while that principal is authorized: members on title
changes, domain readers when they open the Page, and any principal when account
reconciliation verifies it with the Page host. Search and ordering use that
snapshot, so a row left behind after revocation still carries the last title its
principal was allowed to see. Rejected rows are pruned when a listing meets them,
guarded by the revision the listing read. A listing looks ahead for one verified
row past its page; only a scan that stops at its bound (`2 × limit + 16`
candidates) returns a cursor without one, and that can only reflect stale rows
carrying titles the caller was previously authorized to see. `next_cursor` is sealed (AES-GCM, keyed from
`NOTEBOOK_CLOUD_APP_SESSION_SECRET`) to the caller, query and `in_trash`, and
expires after 24 hours. Pagination is best-effort: a Page whose title or sharing
changes mid-traversal can move across the cursor.

Page hosts report their row after creation, title changes and ACL commits. Writes
carry the committed ACL revision, so a report that outlives its timeout changes
nothing once a newer revision has landed. A failed report leaves a marker in the
Page host and repeats on its next request. Before an ACL restriction or a deletion
is durable, the host removes listing rows best-effort; the deleted tombstone is
written only after the host record is durable. Editing and sync never wait on D1.
If D1 errors or exceeds its read budget, listing falls back to the Catalog entries
(at most 500 per prefix) with the same cursor format.

Each account reconciles from its Catalog entries: on its first listing under an
epoch, after a Catalog change that may have missed D1, and at least every six
hours. A pass rewrites owner rows (title, timestamps, state), re-verifies shared
entries and non-owner rows (using the Page host's own title observation time), and
drops owner rows the Catalog no longer has. A Page host's first check after a
restart also reports its row. Each listing advances the pass until about one
second, 128 entries or 16 Page checks. The deadline is checked before every D1
call and every group of four Page checks, and nothing new starts after it; only a
check group already made still commits. Worst case is the deadline plus one D1
call (2.5 s), or plus one check group (3 s) and its commit (1.5 s). Progress is
saved through the last committed entry, so a pass, which is O(account size) and
advanced only by listings, resumes exactly and does not hold the Catalog's queue
beyond that bound. While D1 calls take longer than the budget, the pass waits.
Until an account's first pass completes, its listings use the Catalog entries.
Changing the epoch value forces an immediate pass everywhere; it is not required
after a rollback, since the periodic pass and each Page host's first report after
restart repair what an older build missed.

## Authentication and sharing

Browser sessions reuse nteract's Anaconda OIDC flow; API keys reuse its provider
verification and capability bounds. Configure OIDC and API-key principal
namespaces explicitly when they represent the same account. The native handshake
binds a proven peer signing key to that authenticated account. Storage and
presence policies enforce access; disabled editor controls are not authorization.

Pages also serves OAuth for `/mcp`. Its predefined ChatGPT and Kilo clients require
exact callbacks, PKCE S256, resource validation, sign-in, and consent. Arbitrary
client metadata fetching and dynamic registration are disabled. Codes are
single-use; access tokens last ten minutes, with rotating refresh tokens bounded
by an absolute thirty-day grant. Correctly bound code/refresh replay revokes its
family. Provider tokens stay on the server. Refresh does not refresh verified
email evidence, and MCP tokens cannot authorize raw HTTP assets, sharing, or sync.

`/connect` and the public `/llms.txt` are the maintained client setup guides.
They lead with API keys, the method for coding agents, scripts, and anything
long-running or headless (Kilo, Claude Code, Codex). OAuth is for interactive
cloud clients such as ChatGPT: the client refreshes on next use, so nothing runs
in the background, and the person authorizes again after thirty days. One OAuth
token set must not be shared between processes. Two processes refreshing it
concurrently trip replay detection and revoke the grant, so concurrent agents
use an API key. Agents can prepare non-secret configuration while a person
creates a key or authorizes the connection; a successful `list_pages` call
verifies access.

API-key recipes send `X-Pages-Driver` (the harness, such as Kilo) and an
optional `X-Pages-Agent` session label of at most 80 characters; blank means no
label. The Kilo recipe uses one shared entry with
`"X-Pages-Agent": "{env:PAGES_AGENT}"`, and each worktree sets `PAGES_AGENT` in
its `.envrc`. Both labels are self-declared descriptions shown under the
authenticated account, not verified vendor identity or a permission grant.

A Page starts private. Its immutable owner manages access, Trash, and permanent
deletion, editors write/comment, and viewers read. Each operation intersects the Page role with
credential scopes. Email invitations expire after seven days, become stable
principal grants only after verified provider email admission, and do not send
email. Pending invitations cannot authorize sockets or override a newer role.
There is no public/anonymous access, commenter-only role, or ownership transfer.

Company-domain viewing is an optional, read-only fallback. Deployment configuration
and the owner's Page setting must both allow it; only `anaconda.com` is currently
recognized. New Pages start Restricted. Existing company audiences remain active.
Enabling a company audience requires fresh owner proof. Browser and OAuth proof
expires after six hours. API-key access uses bounded leases backed by provider
verification. Explicit revocation overrides domain access; removing the audience
revokes fallback access without creating permanent members.

ACL updates use a revision and idempotency key. Increases wait for durable
confirmation; reductions apply immediately. Downgrade/removal retires affected
native writer keys and disconnects peers. A new grant cannot revive those keys.
Dirty browser replicas pause with a downloadable draft rather than silently
re-signing rejected offline edits. Previously accepted history remains available;
revocation cannot retract downloaded documents or images. Historical signer
provenance does not authenticate arbitrary actor strings inside imported history.

Browser sessions renew while open and on return to the tab. A return to the tab
or an explicit check that lands while a session request is in flight queues one
fresh request after it, and only the fresh answer applies (the
[session-refresh machine](viewer/session-refresh-machine.mjs)). Native sockets retain
the expiry observed on admission and reconnect with current credentials. API-key
sockets renew bounded leases through provider verification; caching means provider
revocation is not instantaneous. A pending or late check cannot revive an expired,
disconnected, or changed grant. Page ACL enforcement is independent of sign-in renewal.

Native admission separates an active socket from its pending durable signing-key
binding. A handshake timeout or disconnect cancels that socket's waiter; a compatible
reconnect joins the same write and rechecks current access before becoming active.
An unchanged ACL refresh cannot demote a pending writer. Retirement writes are
ordered after earlier binding writes, while access reductions apply immediately.
Storage that never settles still prevents admission; a reconnect is not a durability
shortcut. Failed writes retain their original identity, author ceiling, and quota
reservation because failure does not prove that the write had no effect. A matching
retry uses the same payload. These pending reservations are resident state; after
restart, the host loads the binding records that storage actually retained.

Every refusal on `/api/connect`, `/api/sync`, `/api/saved`, and native admission
logs one `admission.denied` JSON line with a reason from the closed set in
[admission-reasons.mjs](worker/admission-reasons.mjs). celld exports it as the
OTel log body. It names the refused boundary, not the cause of a storage delay,
and omits principals, signing keys, Page IDs, tokens, messages, and content. A
handshake deadline that expires while the key's binding write is still unsettled
logs `native_binding_stalled` rather than `native_admission_timeout`.

Clients receive only a code from [admission.mjs](shared/admission.mjs): HTTP
errors carry it as `code`; native refusals after the upgrade close the socket with
that code as the reason. Byte-transport refusals (text frames, oversized frames,
full queues) report a bounded category, log it once, and close with
`request_rejected` or `temporarily_unavailable`.

A Page holds at most 24 sockets, 4 per account, and 20 across members other than
the owner. A socket over a quota still completes the upgrade, then closes at once
with `temporarily_unavailable` and logs `connection_capacity`. A browser reads a
refused HTTP upgrade only as close 1006, so the close code is what lets its
reconnect count the refusal. A discovery epoch from an earlier host stays an HTTP
409 before the upgrade: the next attempt's `/api/connect` returns the current
epoch, so it clears without counting as a refusal.

A deleted Page returns `page_deleted` only to its owner and to holders of a
current viewer/editor grant. Everyone else, including principals with a role
"none" tombstone, receives the same `403 page_access_denied` body and headers as
for an unreadable Page. Clients that send `X-Pages-Admission: 1` also get that
response for a missing Page. Clients without it keep the legacy 404, because
viewers built before that header renew an expired draft registration only on
that 404. Those viewers predate the protocol floor and never read it, so it
stays until the removal policy in [Build updates](#build-updates) is met. Until
then, a caller that omits the header can still distinguish missing from existing
Pages, as before. Tool and MCP routes also still distinguish them.

The browser reconnects with backoff on transient codes, rechecks access through
`/api/connect` on access and sign-in codes, and stops on `signing_key_rejected`
until Retry. A first open waiting for the document ends with that diagnosis
instead of a lookup timeout, and the open retry loop does not reopen. A socket
counts as admitted only after it stays open 15 seconds, so quick refusals keep
growing the backoff instead of resetting it.

Backoff steps double from 0.5 s to a 60 s cap, with equal jitter: each retry
waits between half the step and the full step, so tabs dropped by one host
restart spread out. Transient failures (no status, 5xx, a close without an
admission code) retry indefinitely. Six admission closes in a row on sockets
that never proved stable pause automatic reconnects with "Sync paused" and the
Retry control, since discovery keeps answering while native admission keeps
refusing. Retry, the `online` event and signing in again clear both counters and
reconnect at once; a stable connection clears them too.
[reconnect-machine.mjs](viewer/reconnect-machine.mjs) holds these transitions.

A host restart is not an error the person can act on. A 502, 503 or 504 (JSON
or a gateway's HTML page), a JSON error marked `retryable`, and a failed fetch
are transient (`isTransientFailure` in [request.mjs](viewer/request.mjs)): the
Page shows Offline or Saved locally and retries without a red banner. Receipts
retry on the same backoff. From the seventh failure in a row, about 15 to 30
seconds in, the Page shows one sentence, "Pages can't reach the server. Your
changes are saved on this device.", and keeps retrying; the next admitted
connection clears it and restarts the receipt. Receipts and session checks
are timed instead of counted (`OUTAGE_MS`, 20 s), because edits and Page
reconnects trigger them too: receipt failures count from the first one after
the last successful receipt, across edits, and the session-refresh machine
tracks a run of unreachable answers, so a library screen whose renewals keep
failing shows the same sentence until a session request succeeds. Both read
one monotonic clock ([monotonic.mjs](viewer/monotonic.mjs), `performance.now()`),
so changing the system time can't hide or hasten the notice. A renewal the
server refuses (401 or 403) still signs the tab out, and says why: "Your
session ended. Sign in again." or the server's 403 message, or the open
Page's own sign-in prompt. Each screen renders its banners
from one deduplicated list ([alerts.mjs](viewer/alerts.mjs)).

The status line separates syncing from saving. Every head change asks the host
for a receipt, but only a local edit marks the replica as holding unacknowledged
work. Catching up on other peers' changes after a reopen says "Syncing"; a
local edit says "Saving" until a receipt for heads that include it lands, even
if remote changes arrive in between.

A reopen decides from the restored replica, not from the checkpoint's `pending`
flag, which only says a receipt was outstanding. The checkpoint's `localEdits`
records every Automerge actor this browser authored with (each session records
its fresh actor before it accepts an edit) and the heads the host last
acknowledged. The replica has unconfirmed work exactly when it holds a change by
one of those actors outside the acknowledged history. Native storage persists
an edit before the debounced checkpoint, so a tab that dies in between still
reopens Saving, and its edit is not claimed as saved. Checkpoints from before
`localEdits` keep their `pending` flag as unattributed local work until a receipt
covers them. Each actor is recorded with the native replica it wrote into, and
only that replica's session drops it: earlier actors once a receipt covers the
whole replica, its own when it closes with nothing unconfirmed. Another tab's
actor is never dropped, by count or otherwise, because that tab may be live or
may be restored later with its native database.
[local-edits.mjs](viewer/local-edits.mjs) holds these rules.
[sync-status-machine.mjs](viewer/sync-status-machine.mjs) holds these
transitions and the label each state renders; a phase pause (sign-in, access,
deletion) or a failed local save outranks it.

A binding write that never settles still blocks its own signing key until the
host restarts; other keys are unaffected. A rejected write may have taken effect,
so the host neither issues a competing write nor releases the reservation. If an
ACL change retires that key, the access refresh waits behind the same write and
holds the Page's serialized HTTP queue. The pending-admission tests pin both cases.

Membership, invitation, connection, and lifetime signing-key counts are bounded;
retired keys remain recorded to prevent regained authority. See [access.mjs](worker/access.mjs) and the Worker tests for membership admission
and the associated resource limits. Sharing
receipts retain the latest 256 results; older retries must still pass the revision
guard, and receipt capacity never prevents revocation. Comment author labels are
editable document data, not an audit log; author-only comment editing is not implemented.

## Authorization

### Current behavior

Capability checks use `decide()`. Grant identity and deletion disclosure use separate projections of the same relation model. The function lives in [authz.mjs](worker/authz.mjs):

```text
decide(principal, actor_chain, object, now)
  -> { capabilities, valid_until, revision, authority_token, basis }
```

It is pure and synchronous, and the celld policy hooks call it on every frame.
It reads what the Page host already holds: the Page record's ACL and lifecycle.
`pageAccess`, the native lease bound and the Project read check are projections
of its result. `pageGrant` reports grant identity (role and signing-key
generation), which Trash keeps. `pageRelation` answers deletion disclosure and
the lifecycle owner check. It reads the same relations without the lifecycle
overlay.

The adapter builds a view scoped to one principal. It holds the owner (or the
project), company view, and only that principal's member row. A decision
therefore costs one member lookup, however many grants and removal tombstones
the ACL has collected.

Capabilities are named: `read`, `comment`, `edit`, `share`, `administer`,
`trash`, `restore`, `purge`, `create_items`, `manage_members`, `move_within`,
`move_out`. A Page never gets `manage_members`, and a project never gets
`comment`. Nothing checks the `move_*` capabilities, because moves don't exist
yet. Execute is out of scope for Pages.

decide() runs three steps, in this order:

1. **Relations.** A viewer or editor member row grants, and a removal
   tombstone becomes `removed`. Company view is the `organization#member`
   userset. Built-in mode has no tenants, so the verified email-domain lease
   stands in for organization membership. A tombstone subtracts from the
   item's own viewer path, so it beats company view. A Page placed in a
   Project has the `project` relation instead of `owner`.
2. **Lifecycle overlay.** A trashed item keeps `read`, `administer`, `restore`
   and `purge`, and only for principals who may restore it. A deleted or
   missing item grants nothing. The overlay runs after every relation, so no
   grant can reopen a trashed item.
3. **Credential ceiling.** A credential without write keeps only `read`.

`revision` is nteract's own ACL revision, which only increases and which every
`expected_revision` write compares. `valid_until` is the credential's expiry,
or the first earlier lease whose loss would change the capabilities. The
email-domain proof is such a lease. Native sockets use it as their lease
bound. `basis` names the strongest relation that survived the lifecycle
overlay and the path that supplied it. It feeds the `role` label and
`source: "domain"`. `authority_token` is always null in this build.

Built-in project ownership is synthesized from the Page owner. External leases
and token round-tripping are not wired. Projects are owner-only, and only a
Project's owner places Pages in it, so a Page's project copy names the Page
record's owner. `decide()` already drops inherited paths when a project copy
carries a `valid_until` in the past, but no built-in copy carries one.

Built-in callers always pass `NO_ACTOR_CHAIN`. This build has no verified
delegation, and driver labels (`x-operator`, `x-pages-driver`) are attribution
only. An agent's API key or OAuth token authenticates as the person, and its
scope is the credential ceiling.

One timing difference from the rules decide() replaced: the Project read check
now requires an unexpired credential, as Page checks always have.
`authenticate()` returns an unexpired credential, but the Project then reads the
request body and its record before it checks access against a fresh clock. A
credential that expires during those reads is refused as `project_not_found`.
Before, the owner was admitted.

### Schema invariants

[schema.zed](authz/schema.zed) is the model, written in SpiceDB's schema
language. It defines `user` (a person), `organization`, `group`, `project` and
`page`, and the proposal's rewrites: `project.contribute`, `project.read_items`,
and the item's `administer`, `edit`, `read` and `share`. Each capability is a
permission of the same name. Agents hold no grants and never appear as
subjects. An item has a `project` or an `owner`, never both. SpiceDB can't
express that, so writers must keep the two exclusive. decide() refuses a copy
that holds both.

[fixtures.json](authz/fixtures.json) lists relationship tuples, a lifecycle and
each principal's expected capabilities. [authz.test.mjs](worker/authz.test.mjs)
runs every row through decide(). The `modes` field marks rows only a host could
produce: groups, organizations on projects, project editors and viewers, and a
leased project copy. The agent row checks only that a non-empty actor chain
leaves the person's decision unchanged.

SpiceDB matches 14 fixture cases after removing local overlays. Writers enforce
owner/project exclusivity; the malformed case tests JavaScript rejection only.
When `zed` is installed, the test runs `zed validate` with the lifecycle,
credential ceiling and project lease removed, so SpiceDB computes the same
relation decision as decide() for every principal. Without `zed`, the test
parses the schema structurally.

[authz-equivalence.test.mjs](worker/authz-equivalence.test.mjs) compares
decide() with the rules it replaced, frozen in
[access-legacy-fixture.mjs](worker/access-legacy-fixture.mjs). It covers 63,000
combinations of lifecycle, placement, company setting, member row, credential
expiry, write scope and domain proof. It also counts member inspections with a
1000-tombstone ACL, to check that a decision stays O(1).

### Proposed host integration

None of this is wired. A hosting platform would implement `decide` with the
same signature over a leased copy of its own relations, and only step 1 would
change. The lifecycle overlay and the credential ceiling stay with nteract:

- The copy would hold the item's relations and its project's. The host's
  change feed (a watch stream) would refresh it, with pushes for quick
  revocation and a lease to bound staleness. Batch checks would run when the
  copy refreshes, never inside a policy hook.
- When the lease expires and the host can't be reached, inherited access
  would fail closed, and `valid_until` would report the lease.
- `authority_token` would carry the token the copy was read at, such as a
  SpiceDB ZedToken. Nothing would compare it for ordering. `revision` stays
  nteract's.
- A refresh that removes access would go through `installAccess`, which closes
  affected sockets as a built-in ACL change does.

## Private images

Browser upload, screenshot paste, and file drop send PNG, JPEG, or static WebP to
`POST /api/pages/:pageId/assets`. Only a stable Page-scoped reference and alt text
enter Automerge. Image bytes use the private `PAGES_ASSETS` R2 binding, backed by
the fleet object store on celld. Immutable hash-addressed assets avoid repeated
uploads; they do not consume the document history budget.

Uploads check current edit permission before transfer and again before returning
the asset. Transfer does not hold the Page mutation queue. Browser insertion
captures a CRDT cursor and refuses to redirect a completed upload into a replaced
block or revoked editor. `GET`/`HEAD /api/pages/:pageId/assets/:sha256` check current
read access before lookup, then return verified raster MIME, `nosniff`, and
`Cache-Control: private, no-store`. No public bucket, persistent presigned URL,
or cross-Page hash lookup is exposed.

Current limits are 5 MiB per image, 8192 pixels per side, and 25 million pixels;
the HTTP request ceiling is 6 MiB. SVG, HTML, GIF, APNG, and animated WebP are not
accepted. Container validation is not full pixel decoding. Removed images and
interrupted uploads may leave private objects: immediate deletion would break
undo or offline references. Asset garbage collection and copying assets between
Pages/deployments require a separate lifecycle implementation.

For agents, importing bytes and inserting content are separate operations:

1. API-key clients upload raw bytes to the asset endpoint. ChatGPT uses
   `import_page_image({page_id, file})` with its client-provided file descriptor.
   The importer requires read/write OAuth scope and Page edit access, accepts
   bounded HTTPS downloads from `files.oaiusercontent.com` without redirects,
   and returns `asset_id`, reference, MIME, dimensions, and size. A file ID alone
   is not a download URL. Temporary source URLs are not stored in the document.
2. Read the current Page, then call guarded `edit_page` with `insert_image`,
   `asset_id`, alt text, and optional `after_block_id` (omitted appends; `null`
   prepends). The host verifies the asset belongs to this Page and creates a
   dedicated image block. Its receipt returns the actual `block_id`, asset
   reference, updated heads, and Page URL. Exact retries reuse that result.
3. Read back the block. Upload success alone is not insertion or proof of rendering.

The MCP schema declares `_meta["openai/fileParams"]` for the client handoff. No
base64 argument or extra API key is needed for that route. Client catalog refresh
may be necessary; a generated ChatGPT image must actually be exposed as a
transferable file. The importer does not provide image-reading capability or
imply pixel access from a Markdown reference.

## Persistence and resource limits

Local Repo completion means local history is recoverable. Remote edit visibility,
native peer heads, and an online connection do not prove durable storage.
`POST /api/saved?page=<id>` waits for the host's Repo/backend and captured record
batches to cross the configured durability barrier before acknowledging heads.
The browser retains pending state through bounded receipt retries; sign-in failure
pauses them until renewal. A client timeout does not cancel or reorder persistence.

With `PAGES_ASYNC_PERSISTENCE=true`, the live Page keeps a bounded in-memory record
replica and sends batches to a separate `PageRecords` object, normally after one
second or on a receipt request. Its output gate does not block ordinary outgoing
edits and presence. Control state and API intents remain durable on the live Page,
so admission and API writes may still encounter storage latency. Failed batches
remain retryable beneath newer values. After a crash, the host recovers persisted
records and browser replicas resynchronize later history. A generation lease
rejects stale pre-crash batches. Record writes follow causal order, decoded from record payloads, so a
persisted prefix of a flush holds the parents of every record in it; records
that depend on each other share one atomic PageRecords write. If stored history
still references a change that never became durable (records written by earlier
builds could be split that way), the Page starts on the history that
materializes, logs `page.history_incomplete` with a count, and runs journal
recovery. Readers that pass admission see `history_incomplete` in read results
and `historyIncomplete` from `/api/connect` until a peer or a pending intent
supplies the missing parents.

Every `PageRecords` request settles within 20 seconds. An unanswered batch stays
pending for the next flush, and a request waiting on it fails with a retryable
`503 record_persistence_timeout`. Tool requests to a Catalog or Page answer
within 60 seconds; a slower one returns a retryable `504 request_timeout` while
the host finishes the work it accepted. Both responses tell the caller to retry
with the same `idempotency_key` and `retry_token`.

No gateway request awaits a promise that another request may still be settling.
celld 0.6.3 resumes a promise continuation under the request whose I/O settled
the promise. A request that awaits another request's pending promise runs inside
it, including the Page fetch it forwards, and loses its timers and I/O when the
other request responds. Continuations inside Durable Objects keep their own
context. Without this rule, a tab's concurrent `/api/saved` and `/api/connect`
after a restart can leave a stuck `/api/connect` holding the Page's serialized
HTTP queue, and the tab stays at "Saved locally". Nothing in that queue bounds a
request, so it stays held until the object is discarded.

[isolate-setup.mjs](worker/isolate-setup.mjs) applies the rule. The gateway
sets up each D1 schema (server sessions, MCP OAuth) once per isolate. Work in
front of the API-key verifier's cache, which shares pending lookups, runs one
lookup per token at a time. The request that starts the work awaits it; others
wait on their own timers. Either side gives up with a retryable `503` after 10
seconds. A key stays held until its lookup settles, or for 65 seconds, past the
cache's 60-second lifetime for an entry. The OIDC libraries' discovery,
signing-key and UserInfo caches, the ChatGPT client metadata check and the
loopback issuer's key still share pending promises across requests (#4567). Remove it when celld keeps request context across shared
promises; [celld-context-probe.mjs](scripts/celld-context-probe.mjs) then exits 0.

The storage backend keeps one representation per record key, but a fragment's
bundle orders concurrent changes in each peer's application order. Stored
history is never re-encoded. An API edit reserves and stores only the records
it adds to the serving document, and a retry reuses that exact reservation
until release. A browser checkpoint import decides coverage from the change
hashes its stored records hold, keeps every stored record as is, and adds any
uncovered change under a new key or as a loose commit.

Versioned binary records preserve signed native envelopes and Automerge changes;
legacy hex records remain readable. `PAGES_COMPACT_RECORDS=true` enables
conservative cleanup only after a retained fragment is durably proven to contain
all changes in a redundant record. API intent reservations prevent removal of
records needed for replay. This is lossless packing, **not history truncation**;
offline peers retain their merge history. See [UPSTREAM.md](../UPSTREAM.md) for
the pinned native fixes, storage-index ownership, codec, and cleanup contracts.

The current resource envelope remains 16 MiB of aggregate native history and
900 KiB per record, with a 1,900,000-byte stored-frame-plus-key guard. The transport
allows individual frames up to 32 MiB and bounds its receive queue at 32 MiB/256
messages. These guards do not bound all decoded WASM state, runtime-owned outgoing
queues, or total isolate memory. Binary encoding alone does not qualify larger
histories, Cloudflare memory use, or cheaper object-store operation.

API admission reserves exact records through the same writer used by native
ingress before journaling an intent. Recovery validates pending changes before
modifying the serving document. An older over-capacity intent leaves accepted
history readable but blocks writes with an explicit recovery error; it is never
silently discarded or rebuilt from JSON. Rollbacks must retain both binary record
readers and the `PageRecords` binding for buffered Pages.

Resident WebSockets reconnect after restart. Hibernation, cross-host ownership
transfer, power-loss/bucket failover, and larger resource envelopes need separate
qualification. Runtime adaptations such as the Worker-only CBOR Uint8Array path
are source-checked and regression-tested; a passing storage probe alone does not
qualify ephemeral presence. Diagnostics exclude provider messages, credentials,
request bodies, and document content.

### Page quotas

Each account has one Page limit. It bounds the account's active Pages and,
separately, its Pages in Trash. [page-quota.mjs](worker/page-quota.mjs) resolves
it from the first match of:

| Rule | Matches |
| --- | --- |
| `email` | the account's server-verified email, normalized as invites normalize it |
| `domain` | that email's domain, lowercased; subdomains don't match |
| default | `PAGES_DEFAULT_PAGE_QUOTA` for the deploy target, 250 when unset |

A matching rule replaces the default, so it can lower it, and `0` turns creation
off. A quota never deletes or hides existing Pages. Only server-verified email
counts: an API key's whoami email, or the HMAC bindings a browser session or
OAuth grant carries. An identity without one gets the default without reading
D1. Rules live in D1's `pages_quota_rules` table, which the gateway reads whole
(at most 1,000 rows) once per isolate every five minutes. A failed or slow read
gives every account the default for 30 seconds and logs the failure; it never
lifts a limit.

The gateway forwards the resolved limit as `page_limit`, beside the caller's
arguments, on Catalog calls that can add a Page to either listing
(`create_page`, `register_page`, `create_space`, `delete_page`, `restore_page`)
and on `list_pages`. The Catalog stays the authority for the count. It keeps
`host/count/active` and `host/count/trash` equal to the number of `page/` and
`trash/` keys, reservations and pending creations included, and writes them in
the same storage batch as each change, inside its serial queue. Below the limit
a check reads only the stored count. At the limit, or before the counts exist,
it counts every entry, releasing stale reservations, and rebuilds them. Every
`list_pages` reads every owned entry for location anyway and rewrites counts
that disagree, logging `catalog.count_repaired`; a rollback build that writes
entries without counts leaves that to repair.

At the limit, creating or restoring returns `409 page_quota_exceeded` and moving
to Trash returns `409 trash_capacity`, each with `limit` and `count`.
`list_pages` returns `quota: {limit, count, trash_count}` for the caller's own
account, whatever the listing's filters. Home shows usage from 90% of the limit.

## Build updates

Each build has a 12-character id: the start of its source fingerprint, also
recorded as `build_id` in `dist/build-receipt.json`. The Worker reports it as
`build` in `/health` and in an `X-Pages-Build` header on every `/api/*`
response; the viewer bundle embeds the same id. The Worker also advertises
`minViewerProtocol` (header `X-Pages-Min-Viewer-Protocol`), the oldest viewer
protocol it serves. Both live in [build-identity.mjs](shared/build-identity.mjs).

The viewer compares on every response it already reads (reconnect, saves,
session refresh), when a hidden tab becomes visible, and every 10 minutes while
visible. It never polls while hidden and never reloads by itself.

| Server advertises | Viewer shows | Editing |
| --- | --- | --- |
| Same build | Nothing | Unchanged |
| Different build (newer or a rollback), floor at or below this viewer | "Pages changed on the server. Reload to use the current version." | Unchanged |
| Floor above this viewer's protocol | "Pages changed on the server. This tab can't edit until you reload." | Paused; accepted edits keep saving |
| Editor chunk failed to load, server on another build | "Pages changed on the server. This tab can't edit until you reload." | No Page opens until reload |
| Editor chunk failed to load, same build | "Pages couldn't load the editor. Reload to try again." | No Page opens until reload |

The viewer is `app.js`, which renders the shell (header, account, sign-in and
the Page list), plus content-hashed files under `/chunks/`. `app.js` imports the
editor chunk at boot, and that chunk waits for the WASM runtimes; the
[editor-load machine](viewer/editor-load-machine.mjs) tracks the import. The
index routes, `/projects` and `/pages`, only list, so they render from the
shell and its static chunks alone. They start the editor import when a Page
opens or a new Page is created, or a little earlier when a pointer goes down on
a Page row. A
release serves only its own chunks, so a tab still running an earlier `app.js`
can find its editor chunk gone: the path then answers with the app's HTML and
the import fails. The tab asks `/health` for the build and the banner offers
Reload. The Mermaid renderer loads only when a diagram shows; a failed import
asks `/health` the same way.

Every file `index.html` names carries a content hash too: `app-<hash>.js`,
`app-<hash>.css`, `theme-<hash>.js`, `automerge-<hash>.wasm` and
`subduction-<hash>.wasm`, plus `mermaid-<hash>.js` from the editor chunk. The
hash is the first 40 bits of the file's sha256 in base32. `_headers` serves
each hashed file `public, max-age=31536000, immutable` by its exact path, so
a return visit revalidates only `index.html`, which stays
`max-age=0, must-revalidate`. A retired name falls through to the app's HTML
with the default revalidating header, never the immutable one. The reload
fetches the current `index.html` and, through it, the current files.

Reload covers everything the tab holds. It pauses edits and waits until every
accepted edit on the open Page has a durable host receipt. If those edits can't
be saved (signed out, access removed, local storage failed, or 15 seconds
without a receipt), the banner says why and the tab stays open. Opening another
Page while Reload waits cancels it. A voluntary attempt that fails resumes
editing; a raised floor keeps its own pause.

A Page the person just left keeps syncing for up to 10 seconds, then closes and
writes its IndexedDB checkpoint, which reopening imports. The tab then releases
that Page's session and keeps only its account, id, title and whether the
checkpoint was written. When a closed Page's edits never reached the server:

| Checkpoint | Reload shows |
| --- | --- |
| Written | "Edits on _title_ haven't reached the server yet. They're saved in this browser and sync when you open that Page again." with Reload anyway and Open _title_ |
| Failed | Names the Page and blocks Reload. Download edits and comments, then Discard unsaved edits and reload (or acknowledge the loss first) |

The download is one Markdown file: the Page body, then an "Unsent comments"
section with every comment, reply or edit the host never acknowledged, each
under the passage it was attached to. A failed record outlives reopening the
Page, since the reopened replica can't contain what its checkpoint failed to
write. It clears only when a host receipt includes all of its heads, or when the
person confirms Discard unsaved edits. Records are keyed by account and Page id.

Each Page session moves through the
[viewer-session machine](viewer/session-machine.mjs): opening, open, paused
(sign-in, access, Trash or access reload), draining while it is left, then
checkpointing, closed or deleted. `PageSession.phase$` is that state in a
[Store](viewer/store.mjs), and every lifecycle flag derives from it. A close
can grow while it runs (a late deletion adds its forget), so the close itself
is private and `closeSettled()` is the only way to wait for it. The
[SessionHost](viewer/session-host.mjs) owns the installed session and every
session still closing. The [reload gate](viewer/reload-gate-machine.mjs) follows
the host and each owned session's phase, so no caller registers a session with
it, and keeps its records as plain data. Their tables,
[viewer-session](test/fixtures/machines/viewer-session.json) and
[reload-gate](test/fixtures/machines/reload-gate.json), run against both
transitions and through PageSession and ReloadGate.

Deliberate differences from the earlier flag-based sessions:

- Closed means the final checkpoint settled; backend release may still be
  running. Reload waits for the release.
- A Page closed without the drain (sign-out, unmount) is closing until its
  release settles, like a Page left through the drain, and keeps the same
  record if its edits never reached the server. Closing a held Page cancels a
  waiting Reload.
- A deleted Page forgets its local copy before it starts closing. It counts as
  closing, and Reload waits for it, until that close releases its backend.
- Leaving during access reload waits for archiving and the replacement-open
  attempt.
- If the replacement fails to open, the archived Page stays installed with
  Reload current Page, which retries the open without archiving again.
- A second Reload while one waits joins it. Reload after the tab started
  reloading repeats the reload.

An unsent comment or reply, on an open or resolved thread, blocks Reload until
it is sent or discarded. A draft that can't be sent (edits paused, write access
gone, or the thread resolved) stays visible read-only with Copy and Discard.

The floor pauses supporting browser viewers; it does not enforce compatibility
for older viewers or API clients. Viewers built before this mechanism never read
it, and a tab that was offline can reconnect later with edits it accepted under
an older protocol. Remove a server compatibility path only after all of these
hold:

1. Every supported viewer reads the floor.
2. The floor has excluded the older viewers for a full support window.
3. The server can still drain edits older clients already accepted, or rejects
   them without losing them (the client keeps a local draft and says so).

Raise `MIN_VIEWER_PROTOCOL` and `VIEWER_PROTOCOL` together in one release. MCP
and HTTP tool compatibility is versioned separately and does not follow this
floor.

## State machines

Each async lifecycle (an operation, a Page's trash state, a viewer session)
gets named states, named events, and one pure transition function.
[machine.mjs](shared/machine.mjs) defines them:

```js
const lamp = defineMachine({
  name: "lamp",
  states: ["off", "on"],
  events: ["flip", "hold"],
  initial: "off",
  unreachable: [["on", "hold", "only an off lamp can be held"]],
  transition(state, event) {
    if (event.type === "hold") return reject(state, "held");
    const name = state.name === "off" ? "on" : "off";
    return { state: { name }, effects: [{ type: name === "on" ? "light" : "dark" }] };
  },
});
lamp.step({ name: "off" }, { type: "flip" }); // { state: { name: "on" }, effects: [{ type: "light" }] }
```

- A state is a JSON object whose `name` is one of `states`. Events and effects
  are JSON objects with a `type`. `step` validates both sides and returns
  `{ state, effects, response?, rejected? }`.
- A guard that refuses an event returns `reject(state, reason)`: the same state,
  no effects, a reason, and optionally a `response` for the caller.
- `unreachable` lists `[state, event, reason]` pairs that can't happen by
  construction. `step` throws on them. Late or duplicate events are reachable;
  answer them with `reject`.
- `validate` holds domain checks keyed by name:
  `{ states: { [name]: fn }, events: { [type]: fn }, effects: { [type]: fn } }`.
  Each `fn` throws to reject. They run on the initial state, every input and
  output, and every table row. Declaring `effects` makes its keys the only
  effect types allowed.
- `cases` names the guard outcomes of a pair, such as
  `{ "connecting/closed": ["current-generation", "stale-generation"] }`. Each
  row on that pair names its `case`, and every case needs a row. State and
  event names can't contain `/`.
- The transition never reads storage, the network, clocks or randomness. An
  interpreter at the edge runs the effects and turns replies and timers back
  into events. Worker interpreters keep the Durable Object's promise tails;
  viewer interpreters use RxJS.
- Persist state and outbox together; return success only after the required durability barrier.

To add a machine:

1. Write the table as JSON in `test/fixtures/machines/<name>.json`: `machine`,
   `states`, `events`, `unreachable`, optional `cases`, and `rows` of
   `{ case?, state, event, expect: { state, effects, response?, rejected? } }`.
2. Drive the current code through an adapter:
   `await runTable({ name, states, events, unreachable, cases, validate }, loadTable(file), { drive })`.
   `drive(state, event)` sets the old code up in `state`, delivers `event`, and
   reads the result back.
3. Extract the transition with `defineMachine`, make the old code its
   interpreter, and run the same table with `runTable(machine, loadTable(file))`.

[machine-test.mjs](shared/machine-test.mjs) fails when a state × event pair has
neither a row nor an unreachable entry, when a declared case has no row, when a
row covers an unreachable pair, or when the file's names, unreachable pairs or
cases disagree with the machine. Coverage is exhaustive over names; add rows for each guard outcome.
Rows compare `state`, `effects`, `rejected` and `response` exactly, including
whether `rejected` and `response` are present. To skip one row's response,
write `"response": { "$ignore": true }` (`IGNORE` in JavaScript). Without
`drive`, the runner also checks that the transition leaves its input untouched
and returns the same result twice. The JSON file is the contract a port to Rust
would replay. [machine.test.mjs](test/machine.test.mjs) runs one table against
both a machine and flag-style code.

Viewer state lives in a [Store](viewer/store.mjs): one private
`BehaviorSubject`, `snapshot()`, `update(fn)`, and `select(project, equals)`,
which emits synchronously and then only on change. Components read
`useStore(store, project, equals)`, built on React's
`useSyncExternalStoreWithSelector`. It memoizes on the store, `project` and
`equals`, and compares with the last committed value. Pass a named comparator
when `project` allocates. Test timers with `TestScheduler` from `rxjs/testing`,
as [store.test.mjs](viewer/store.test.mjs) does for a backoff interpreter.

## HTTP and MCP tools

`POST /api/tools` accepts `{operation, arguments}`; `POST /mcp` exposes the same
Page operations through Streamable HTTP MCP. MCP accepts a Pages OAuth access
token or Anaconda API key in `Authorization: Bearer ...`; `X-Pages-Driver` is an
optional client label and `X-Pages-Agent` an optional session label. OAuth
scopes and current Page permissions apply on every call. The public `/llms.txt`
is the tool usage and authentication reference.

A single `tools/list` or `ping` message needs no credential: tool definitions are
static and carry no account data. `initialize`, `tools/call` and every other method
return the OAuth challenge without one, so MCP clients still start sign-in from
`initialize`. A presented credential that fails still gets the challenge.

Other endpoints include `/api/access` for sharing, `/api/connect` for native
admission details, `/api/sync` for binary WebSockets, and `/api/saved` for durable
receipts. OAuth metadata is public at
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server`; authorization, token exchange/refresh,
and revocation use `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke`.

Reads capture content and heads together. Agents can select blocks, exact heading
sections, literal hits with neighboring nodes, or revision-bound node ranges.
`include_content:false` provides a paginated outline; explicit read projections
use bounded response budgets and never silently truncate content. Partial slices
are suitable for literal edits, not whole-block replacement. `list_page_comments`
reads filtered threads separately. Legacy `read_page({page_id})` remains unbounded
for cached clients.

`read_page_changes({page_id,since_heads})` returns a complete net delta at one
captured revision: changed native nodes, address-only deletions, title changes,
and compact comment changes. Stable native identity avoids treating later
paragraphs as changed when an earlier one is inserted. It is not an event/audit
log and does not supply historical person/client attribution or deleted message
bodies. Unknown history returns `resync_required`; oversized deltas return
`changes_budget_exceeded`, never partial success. Advance saved heads only after
consuming a successful response or resynchronizing with focused reads.

Mutations require an idempotency key; content edits, comment adds and deletion
also require observed `base_heads`. The default
`conflict_scope:"page"` requires exact current heads. `patch_page` can use
`conflict_scope:"target"` for batches of only `replace_match` and `format_match`:
native identity maps
historical literal ranges into current text, checking text, marks, and structure.
Optional `node_index` narrows the match at the base revision. Unrelated edits,
even within the same block, survive. Deleted/reinserted text is a new target;
overlapping batch targets are rejected. Structural/Markdown changes retain the
exact-head guard. Conflicts provide bounded addresses for focused rereading.
Guards check the preparation snapshot; native changes can still merge during
persistence. Tool mutations do not simulate typing or lock out peers.

### Refusal codes and tool hints

Every MCP refusal carries a stable `code`, in `structuredContent` and in the JSON
text, so agents never branch on message text. The Worker codes specific refusals
where they're raised: a stale exact-head guard is `409 stale_heads`, malformed
`base_heads` and an edit batch that can't apply (zero or multiple matches, an
unknown block, operation or mark) are `400 invalid_edit_selector`, and a comment
action on a missing thread, message or block is `400 invalid_comment_selector`.
A full account is `409 page_quota_exceeded` and a full Trash `409 trash_capacity`;
both carry `limit` and `count` (see Page quotas). An MCP result has no HTTP status, so [mcp.mjs](mcp.mjs) names any refusal the
Worker left uncoded by its status (`access_denied`, `not_found`, `conflict` and
so on). It adds `retryable: true` to `stale_heads`, whose retry is a new request
built from a fresh read. The HTTP API keeps `retryable` for transient failures
only, because the browser treats those as an outage. A tool call that gets no
answer returns `read_failed` or `outcome_unknown`. The `/llms.txt` guide lists the
codes agents act on.

Every tool declares all four MCP annotation hints, and `tool()` refuses one that
doesn't, because clients read an absent hint as destructive and open-world.
Reads are read-only. Keyed writes are idempotent and not destructive: edits stay
in Automerge history. `delete_page` and `purge_page` are destructive; Trash is
reversible, but it revokes every collaborator's access until restored.
`import_page_image` is open-world because it downloads the client's file, and
`report_page_progress` is not idempotent because each call without a lease starts
another session.

### Agent carets

API agents get presence derived from the calls the host already authorized
([`model/agent-presence.mjs`](model/agent-presence.mjs)). A committed
`patch_page` or `edit_page` publishes a caret where its last operation landed: a
selection over the text a `replace_match` or `format_match` changed, which the
browser fills for 600 ms before collapsing it to a caret, or a corner dot on a
block an operation inserted, moved or replaced. A `read_page` by section, search,
node range or block IDs shows a reading bar; a search with one to three hits also
fills each hit. Whole-page and outline reads show nothing.

Targets are Automerge cursors captured inside the change, so they follow
concurrent typing. They travel in the `page-activity` snapshot and are never
written to the document, a receipt or the journal; a replayed receipt publishes
nothing. A caret is active for 15 s after a write, then fades, and disappears 60 s
after the agent's last call; a reading marker lasts 10 s. Only API credentials
(an API key or MCP OAuth) get presence: a browser sign-in session publishes
nothing, since that person's editor shows their own caret. A caret reads
"Kyle's Kilo · release agent": the account, the `x-pages-driver` harness and an
optional `x-pages-agent` session label. Labels sit under the authenticated
account and are trusted as such. Records key by account, harness and session
label, so two sessions of one account keep separate carets. MCP `initialize`
responses also carry an `Mcp-Session-Id`, and clients echo it; the transport
stays stateless. The worker turns the id into an account-scoped SHA-256 tag
(`identity.session`), so two unlabeled sessions on one credential still get two
carets and two colors, and the raw id never leaves the worker. A reading marker's
targets are captured on the revision the read returned.
Each participant's color comes from nteract's cursor palette, keyed by
principal and driver.

Comment and progress anchors are native cursors, so they skip the exact-head
guard. `manage_page_comment` `add` with `selected_text` requires known
`base_heads`, finds the passage (and `occurrence`) at that revision, and anchors
its cursors there. It returns `edit_conflict` only when the passage no longer
resolves, and `resync_required` for unknown heads. A block comment needs only
its block. Replies, status changes, message edits and deletions touch only the
thread, so `base_heads` is optional and never compared. `report_page_progress`
targets follow the same rule with `expected_heads`, failing with
`presence_revision_changed` for unknown heads or a detached passage. Retries
still replay the recorded receipt; these guards run only for new intents.

`edit_page` supports structural operations including `insert_markdown`,
`move_block`, and `insert_image`. Placement uses stable `after_block_id` values,
`null` to prepend, or omission to append; fractional positions are internal.
Content warnings, inserted image IDs, and other receipt results are captured at
the operation's actual heads and are not recomputed during retry.

### Trash and permanent deletion

`delete_page` moves a Page to Trash; it does not delete the document. The Page
record keeps its Automerge document, comments, ACL, and signing-key bindings.
Trashing applies immediately, like an access reduction: member sessions close,
current viewers and editors get `403 page_trashed` (admission close 4410, retry
"recheck"), and their catalog references are pruned on their next listing.
Everyone else, including company viewers and removed members, gets exactly the
missing-Page response: the legacy `404`, or `403 page_access_denied` for clients
that send `X-Pages-Admission`. The D1 index retires trashed rows to the owner
and lists them only with `in_trash`. Index writes are fenced by the Page's
lifecycle revision, and every lifecycle transition advances the Catalog entry's
`updated_at`, so delayed retirements, reports and prunes cannot undo a restore. The owner keeps a
read-only preview through reads and native sync; edits, comments, progress,
sharing changes, and image uploads return `409 page_trashed`. The browser
previews on a reader replica; any key first admitted while trashed stays a
reader key, so restore reloads onto the writer replica. An upload authorized
before trashing can still store its bytes before the final authorization check
rejects it; those bytes are unreferenced and are not cleaned up. Reads of a trashed Page carry a `trash` object
and no edit retry authority. The owner's catalog moves the entry from `page/` to
`trash/`, so trashed Pages leave default listings and the account's active Page
quota (see Page quotas).
`list_pages({in_trash:true})` lists them.

Each transition increments the record's `lifecycleRevision`. The Catalog
records the revision it last observed when it reserves a lifecycle request and
sends it as `expected_revision`; the Page applies the request only at that
revision. A retry of an older request returns its stored receipt, or
`{superseded: true, applied: false, state}` once that receipt has been pruned,
and never applies again. A superseded result was not applied; callers read the
current state before acting. The Page keeps its newest 256 receipts. A
transition is committed with its receipt in one write and installed in memory
only after `sync()`; if that barrier fails, the next request finishes the
transition before doing anything else, so a receipt never replays for an
unfinished transition. If a newly reserved request is
superseded because the Catalog's index was stale, the Catalog retargets it once
at the Page's current revision. A Trash runs the leaf guard again first,
whatever the revision: the Page can have been trashed, restored and given a
child since the request was reserved. A refused or unsettled guard releases the
request, which the Page never recorded. The Catalog always projects the Page's
current state, not the replayed receipt.

The Page's side is one transition in
[page-lifecycle.mjs](worker/page-lifecycle.mjs), with its table in
[page-lifecycle.json](test/fixtures/machines/page-lifecycle.json). Its states
are missing, creating, active, trashing, trashed, restoring, purging, deleting
and deleted. Trashing, restoring and purging are commits whose sequence has
started and not finished; that phase lives only in memory, so a restart boots
from whichever record is durable. Deleting is a durable deleted record whose
deletion barriers have not run in this process. The lifecycle routes,
`/internal/lifecycle-state`, `/internal/tombstone` and the constructor are its
interpreter.

Pending trash and restore requests hold a hidden destination slot in the
owner's Catalog, written in the same storage call as the intent. The intent is
marked `forwarded` before the Page sees it. A never-forwarded slot counts for
one retry lifetime while its intent is pending. A forwarded slot does not
expire: once its lifetime lapses, counting asks the Page for its current
lifecycle state and either converts the slot to the real entry or releases it.
A resumed request whose slot lapsed takes a new one if capacity allows;
otherwise the Page only reports its current state. These rules, with the
retarget and the revision fence, are the
[operation-intent machine](worker/operation-intent.mjs). Its
[table](test/fixtures/machines/operation-intent.json) runs against the
transition and through the Catalog, which interprets it.

A trashed document that fails to load answers `503` and is retried on the next
request. Only a deleted record, or the owner Catalog's tombstone delivered to
the Page, makes the absence permanent; the Page then answers like a missing
Page. A tombstone answers only after its deleted record is durable. If that
write or sync fails, the next tombstone repeats it.

`restore_page` waits for the restored record to be durable, like an access
increase, then returns the same ID, content, comments, and ACL. Grants and key
generations are untouched by Trash, so collaborators reconnect with their
previous role and keys. Restored titles are projected back into member catalogs.
That projection runs after the restore commits. If the process dies in between,
a restart forgets it and a retried restore replays its receipt without
projecting, so members may not find the Page until its title projects again
([#4553](https://github.com/nteract/nteract/issues/4553)).

`purge_page` is a two-step owner operation on a trashed Page. `action:"preview"`
returns the title, comment count, collaborators who lose access, pending
invitations, and an HMAC-signed `preview_token` valid for ten minutes. The token
binds the owner, current heads, ACL, and lifecycle revision; any change
invalidates it. Confirmation rechecks the live heads and record in the same
synchronous step that tombstones the Page. While trashed, the policy refuses
native writes from every key, so only a change accepted before Trash and applied
late could differ. `action:"confirm"` with the unchanged token then runs the
permanent deletion path:
it tombstones the record and waits for it to be durable, then closes admission,
deletes the document, and writes the catalog deletion tombstone. Private image bytes stay in object storage but are
no longer served.

Trash has no automatic expiry. Pages stay there until the owner restores or
purges them, up to 100 per account. Each trash record identifies its root Page.
This implementation trashes and restores individual Pages.

### Projects

A Project is a container for Pages: its own ID (`prj_<uuid>`), title, description,
owner, a members ACL with a revision, and a home Page created with it. Results
carry `org`, always `null` until a host supplies tenancy. The name matches the
organization → project hierarchy hosting platforms use for access, so a Project
can map one-to-one onto a host's project. Its Durable Object
([spaces.mjs](worker/spaces.mjs)) is the authority for that record.

Projects were called Spaces, and storage keeps that name so a rollback build
reads the same records: the `Space` class behind the `PROJECTS` binding,
`space/<id>` Catalog entries, `space_id` on Catalog location entries, journal
intents and receipts, and the D1 `pages_catalog_spaces` table and `space_id` column.
[project-api.mjs](worker/project-api.mjs) is the one place callers' names meet
storage's: it maps `project_id` and the Project tools in, and `space_id` out.
`create_space`, `list_spaces`, `get_space` and `update_space` answer
`tool_renamed`, and a `space_id` argument answers `argument_renamed`, before
anything runs. Projects created before the rename keep their `sp_<uuid>` IDs,
and `/s/<id>` links open `/project/<id>`. See
[DEPLOYMENT.md](DEPLOYMENT.md#projects-and-their-storage-identity). In this build membership is owner-only: only the owner can open a Project,
list its Pages or add to it, and nothing inherits access from a Project. A Page in
a Project is readable by the owner and by anyone with a direct grant on that Page;
sharing works as before and never reveals the Project. Inherited access, moves and
a Project change feed come later.

The viewer lists them at two index routes. `/projects` shows every Project
`list_projects` returns, with its description. `/pages` shows every Page
`list_pages` returns, newest first, including Pages in Projects; an owned
Page's row links its Project. Search uses `list_pages`' `query`, trimmed and
cut to its 200-unit limit, and stays in the address as `?q=`. Load more follows
`next_cursor`; a cursor that has expired (`invalid_cursor`) starts the listing
over from its first page. `list_pages` has no filter for Your items or for
shared Pages, so `/pages` has no filter chips; shared rows say so instead.

| Tool | Arguments | Result |
| --- | --- | --- |
| `create_project` | `title`, `description?`, `idempotency_key`, `retry_token?` | `project_id`, `home_page_id`, `revision` |
| `list_projects` | `cursor?`, `limit?` | owned Projects, `next_cursor`, `retry_token` |
| `get_project` | `project_id` | title, description, revision, `home_page_id` |
| `update_project` | `project_id`, `title?`, `description?`, `expected_revision`, `idempotency_key` | the updated Project, or `superseded` |
| `create_page` | adds `project_id?`, `parent_id?` | adds `project_id`, `parent_id` |
| `list_pages` | adds `project_id?`, `parent_id?` (`null` = top level), `kind?` | owned rows add `project_id`, `parent_id`, `position`, `home` |
| `read_page` | unchanged | adds `kind`, `project_id`, `parent_id`, `home`, `breadcrumbs` |

Every Project and item operation goes through the caller's own Catalog, which
calls the Project and Pages with the caller's credentials. A Project never calls a
Catalog or a Page. `create_project` reserves a journal intent with the Project ID and
home Page ID first, then creates the Project record and the home Page; both steps
are idempotent, so retrying the same key and payload after a crash or lost
response finishes the same Project. Until then `get_project` answers `project_pending`
and `list_projects` omits it. The home Page holds orientation and guidance for
people and agents. It is ordinary, untrusted Page content and cannot move to
Trash on its own (`home_page_protected`).

The owner's Catalog is the only record of where a Page is
([catalog-location.mjs](worker/catalog-location.mjs)); Page records carry no
location. Each owned entry stores `parent_id` and `position`. A root in a
Project stores the Project's `space_id`, and the home Page adds `home`; a
sub-page's Project is derived by walking parents to its root with
[model/location.mjs](model/location.mjs). `create_page` writes the location
into the pending Catalog entry in the same put as its journal intent, so a
retry finds its parent there, and the Page learns only its content. Results
call `space_id` `project_id`. A parent implies its Project; a different
`project_id` is `placement_mismatch`. Pages nest at most 9 levels (`nesting_depth_exceeded`), and
only Pages the caller owns can hold sub-pages in this build. Project and Page IDs
have different shapes, so a swapped ID is a structural error
(`project_id_as_page_id`, `page_id_as_project_id`) that names the right tool and
argument and reveals nothing about either resource.

Listing by Project or parent reads the Catalog's entries, not D1: a Project
lists every descendant of its roots, and a parent lists its direct children.
Children of a parent shared with the caller come from the parent owner's
Catalog, and each is verified by its Page host with the caller's access.
`list_projects` takes candidates from `pages_catalog_spaces` and confirms each
against the owner's `space/<id>` Catalog entry; cursors are sealed to the
listing's filters. `read_page` breadcrumbs are computed in the gateway with one
call to the owner's Catalog, a host-only `/internal/location` route that answers
ancestor IDs and the root's Project and nothing else. Each ancestor and the
Project then answer with the caller's credentials, so the trail stops at the
first Page the caller cannot open and `project_id` appears only when the
Project is readable.

Trash stays single-Page. `delete_page` on a Page with active sub-pages, or
sub-pages still being created, returns `page_has_children`; trash the sub-pages
first. Subtree Trash is not available yet: it will return on an explicit
operation intent with per-item fences and capacity reservations. A restored Page
whose parent is in Trash or gone returns to the top level of its Project (or Your
items); a sub-page's Trash entry records its Project (`restore_space_id`) for
when the parent is purged. The Catalog decides this when it projects the
restore. Creating a Page under a parent in
Trash returns `parent_unavailable`, including a resumed creation, which checks
its parent again before it reaches the Page.

Placement decisions never trust a Catalog entry with an unsettled Trash or
restore reservation: a lost response or failed barrier can hide a transition the
Page already applied. Restore reservations record the Project and parent the Page
returns to. Before the leaf check or a restore placement reads such an entry,
the Catalog asks the Page for its lifecycle (`/internal/lifecycle-state`) and
projects an applied transition. A child whose restore applied counts as a child.
A parent with any Trash entry, or a pending Trash reservation, is unavailable,
so a restored child goes to the top level even if that trash has not applied
yet. When the Page can't answer, the request is refused with
`lifecycle_unsettled` (retryable) rather than decided on a guess. Every Catalog
request shares one queue, so these reads are bounded: each read (fetch and body)
gets 2 s, one pass gets 5 s with no read starting after its deadline, and an
exhausted budget also returns `lifecycle_unsettled`. Reads are shared across
passes: a pass reuses the read in flight for the same Page, and at most four
underlying reads run at once, counted until they settle rather than until a
caller stops waiting. Each read is aborted at 2 s; celld 0.6.3 honors an
AbortSignal on a Durable Object stub fetch, and the body is read through a
reader the abort cancels, since an abort after the headers does not interrupt
a body read. A resumed trash that lost its reservation never applied,
so before it re-acquires one it asks the Page: if the Page's lifecycle has not
moved, the leaf guard runs again and a child created meanwhile refuses it; if it
has, forwarding replays a recorded receipt or comes back superseded, and a
superseded Trash meets the guard again before it may retarget.

Catalog and Space objects each run one request at a time through
[serial-queue.mjs](worker/serial-queue.mjs). Not every await inside a request
has its own deadline: Page and Space fetches and credential checks do not. So
the queue has a watchdog. When the running request reaches 120 s, the object
resets through `ctx.abort()`, which celld 0.6.3 supports, and the next request
reaches a fresh instance. The running request's timer catches it, and so does
the next request to arrive, which checks the running request's age. Requests
already queued on the reset instance never settle, and their callers' 60 s
deadlines answer them. A Page's title projection has no gateway deadline, so
the Page gives it 10 s. On a timeout the Page forgets the title it sent, and
the next request to the Page sends it again. Reset is safe here because Catalog and Space state is
all in durable storage, and their operations recover from a restart through
stored operation intents. The log line has stage `catalog-queue` or
`space-queue`, status 503 and reason `request_timeout`. Pages don't use this
queue: a Page holds live document state and sockets.

celld 0.6.3 cancels a Durable Object request when its caller goes away: the
client of the gateway request that forwarded it disconnects, such as a tab
navigating away while its listing is in flight, or the calling object aborts
its stub fetch. The object request's pending timers and I/O are dropped and its
promise never settles. A request still waiting in a queue starts in that dead
context when its turn comes. Either way it holds the queue: a Catalog or Space
until the 120 s watchdog, a Page or `PageRecords` until the object is
discarded. So each of those objects passes every request to `ctx.waitUntil`
when it queues it, through [request-hold.mjs](worker/request-hold.mjs). A
Page's `/api/saved` and `/api/sync` skip its queue but are held the same way: a
save waits for heads and drains the record store's serialized flush, and a
sync's resident socket already holds its own request. A Catalog also holds the
lifecycle reads that later requests reuse. The catalog index migration is
shared by every object in an isolate, and its callers stop waiting after 1.5
or 2.5 s, so `catalogIndexDatabase(env, ctx)` requires the caller's `ctx` and
holds the migration on it; no Catalog or Page call site can skip the hold. The
work runs to completion after its caller leaves, and its response is
discarded.

`update_project` requires `expected_revision`. The Catalog records it in the
journal intent before the Project sees the request, and every attempt carries it,
so a retry can never apply once the Project has moved past that revision, even
after the Project evicted the key's receipt (it keeps the latest 64). Such a retry
returns `superseded: true, applied: false` with the current Project.

### Retry contract

After a conflict, reread before constructing new work. For an uncertain outcome,
retry the **identical token, key, and payload**. Page reads/deltas supply
`retry_token` and `retry_key_prefix`; catalog listing supplies create/delete
authority. Append a UUID to the returned prefix for a new operation.

Tokens last seven days. Expired completed requests return `410 retry_expired`
without executing, even after receipt collection; reconcile the old outcome
before deliberately submitting new work. Pending intents never expire and retain
their original replay authority. The journal first persists the causal base and
encoded changes, then replays identical CRDT change IDs after interruption.
Exact record reservations protect those changes from concurrent ingress and cleanup.

The versioned journal bounds active receipts at 1,000 entries/8 MiB and pending
work at 64 entries/4 MiB. Capacity causes explicit backpressure. Collection removes
expired completed receipts with a durable monotonic clock floor, not arbitrary
keys. Legacy receipts retain a separate 1,000-entry cap; browser edits do not
consume this budget. Catalog deletion tombstones remain permanent; Trash writes
none. See the
[operation journal](worker/operation-journal.mjs) and its integration tests.

### Progress and presence

`report_page_progress` creates an independent host-memory session with a private
lease token. Only its caller can update or clear it; status expires within 60
seconds and requires current edit access. It creates no document changes or
receipts. Optional passage targets use native cursor anchors and detach when
the passage is replaced/deleted. Restart and access changes clear activity;
external credential revocation is observed on a later authentication check.

`read_page_presence` returns recent browser selections and agent activity without
the body or edit authority; `read_page({include_presence:true,...})` includes the
same projection. Peer identity comes from authenticated admission, while driver
labels and progress text remain claims. Selection is not proof of typing, and
progress is not proof of a completed edit. Counts, message sizes, and wire bytes
are bounded. The UI clears its quiet activity disclosure on connection/access loss.
