# Pages

Pages is a rich collaborative document product for people and agents: prose,
images, diagrams, tables, task lists, interactive dataframes, and comments
anchored to passages. People write in the Wordgard editor. Agents read and edit
the same content over HTTP and MCP. Projects organize Pages. Code blocks display
source; notebooks execute it.

[DIRECTION.md](DIRECTION.md) is the one direction for this work: where Pages
is going, the order of work, and the rules for deployed targets. Read it
before changing the document model, sync, or agent tools.

## Documents

| Doc | Read it for |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Contributor rules and workflow |
| [DIRECTION.md](DIRECTION.md) | Destination, what changes, order of work, rules for targets |
| [REFERENCE.md](REFERENCE.md) | Current host, viewer and tool behavior on `main` |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Targets, release, rollback, operations |
| [UPSTREAM.md](UPSTREAM.md) | Pinned Repo 3 package, its patches, and setup modes |
| [archive/](archive/) | Superseded design notes, historical only |

## Architecture

| Layer | Owner | What it holds |
| --- | --- | --- |
| Page document | Automerge | Title, a map of blocks keyed by ID, each with a fractional `position` and one rich-text object |
| Comments document | Automerge | Threads and messages anchored by cursors into the Page document |
| Wordgard tree | Memory only | `decode(spans)` of one block; the editor renders it, readers and export walk it |
| Page host | celld Durable Object | Admission, authorization, persistence, durable receipts, plain Automerge sync |
| Catalog | celld Durable Object (source of truth) + D1 projection | Per-account Page and Project entries, Trash, quotas. The D1 `pages_catalog_*` tables are a rebuildable index of them for listing and search |
| Page tags | D1 table `page_tags` (source of truth, no Durable Object) | Each Page's tags. Not a projection and not in the document; searched with `list_pages tags` |
| Agent edge | `/api/tools`, `/mcp` | Markdown and outline reads, node operations, idempotent receipts |

Each fact has one normative home: a Durable Object, or, for Page tags, quotas
and sign-in state, a D1 table. D1 also holds projections of the Durable Objects,
which can be rebuilt; see [Where state
lives](DEPLOYMENT.md#where-state-lives).

Browser replicas and UI state never confer access or prove durability. The host
decides both. Pages has its own documents; notebook `NotebookDoc`,
`CommentsDoc` and daemon rules don't apply.

Source layout under this directory:

| Path | Contents |
| --- | --- |
| `model/` | Document model, codec, Markdown edge, comments, node and mark registries |
| `viewer/` | Browser app and Wordgard binding |
| `worker/` | Page host, Catalog, auth, HTTP and MCP routes |
| `sync/` | Plain Automerge sync backend and comments sync |
| `shared/` | Code shared by viewer and worker, state machines |
| `scripts/` | Build, E2E harness, deploy, operator tools |
| `upstream/` | `@automerge/automerge-repo` source that `setup.mjs` fetches and patches, linked as that package |

`@automerge/automerge` is nteract's build, not the npm release:
[`js/automerge-3.5.0-nteract.1`](https://github.com/nteract/automerge/releases/tag/js%2Fautomerge-3.5.0-nteract.1)
from branch `nteract/js-3.5.0` of nteract/automerge. It is 3.5.0 plus two
`updateSpans` fixes. Without them, every write to a block re-marked any mark
that spans several text runs, so writes to a block that was edited often got
slower each time. `package.json` names the tarball's URL and `package-lock.json`
its sha512. `setup.mjs` writes the same URL into the automerge-repo copy, so
both resolve one Automerge. Return to an npm release once one carries both
fixes ([automerge/automerge#1664](https://github.com/automerge/automerge/pull/1664)
and the run-merge commit on the branch); `model/span-write-cost.test.mjs`
fails on a release without them.

### Charts

`viewer/vega-chart.mjs` renders Vega-Lite specs over caller-supplied datasets
(rows, Arrow IPC bytes, or an Arrow table). Each `view` node references a
`pages.view` entry containing the spec and source bindings
([viewer/wordgard-views.mjs](viewer/wordgard-views.mjs)). The chart chunk
(`viewer/view-chart.mjs`) lazy-loads near the viewport; cards and previews
render a static figure without loading it.

- **Worker isolation:** All charts on a Page share one Worker
  (`viewer/chart-pool.mjs`) that runs draws serially (first draws ahead of
  redraws) and posts the finished scenegraph back for SVG rendering. The page
  never runs the Vega dataflow directly. Before Vega loads, the Worker strips
  non-allowlisted globals and prototypes, including `navigator`
  (`viewer/chart-lockdown.mjs`), and runs under
  `Content-Security-Policy: default-src 'none'` (`shared/chart-worker-csp.mjs`).
- **Static charts only:** Marks, axes, legends, and Vega's hover tooltip are
  supported. Selections, bindings, `param` predicates, hover encodings, and
  event streams are rejected.
- **Comments on charts:** Readers with comment access can use **Comment on
  chart** (beside Maximize) to open existing threads from the count or start a
  new thread from the comment icon. Threads anchor to the chart node's
  Automerge marker, survive source refreshes, and detach if the node is
  deleted. Charts stay untinted, and comments target the whole chart rather
  than a point or data revision.
- **Untrusted specs and data:** `shared/chart-spec.mjs` allowlists named
  datasets, marks (excluding `image`), encoding types, bounded transforms,
  expression functions, keyword cursors, and rejects CSS `url()` in strings.
  Numbers must be `0` or have magnitude in `[1e-150, 1e150]` to prevent Vega
  bin-loop underflow; smaller data values clamp to `0`, and larger or
  non-finite values become `null`. The Worker rejects compiled dataflows with
  event streams, bindings, or unlisted operators, interprets expressions via
  Vega's interpreter, and denies external loads. The page also rebuilds the
  returned scenegraph from allowlisted mark types and sanitized styles
  (`viewer/chart-scene.mjs`).
- **Budgets and timeouts:** Datasets cap at 100,000 rows and 2,000,000 cells
  (nested values included), with runtime range checks on bin, kde, and
  regression transforms. A draw running past 8 seconds fails with
  `This chart took too long to draw.`, replaces the Worker, and stays skipped
  until its spec or data changes. Hidden tabs pause draws and terminate active
  Workers. A maximum-size chart (100,000 points) draws in ~2 seconds in
  Chromium, Firefox, and WebKit.

### Sources inspector

The **Sources** item in the **…** menu and source names under a Page's title
open a read-only source inspector (sharing the comments dock on desktop, or a
sheet on phones). Selecting a source shows a preview (schema from footer
metadata in a narrow pane, or a Sift table when wider), live metadata, retained
revisions, and placed tables or views (including anywidget inputs) with jumps
to each placement. The preview stays visible when switching between Connections
and Revisions, and search appears when a Page has multiple sources. Run
`npm run e2e -- sources-panel` to verify it against a local host.

## Run locally

Use Node 22.13 or newer, Git, npm, and `celld` 0.6.3 on `PATH`. From
`apps/pages`:

```sh
npm run setup
npm run build
npm run dev
```

Setup fetches and verifies the pinned upstream source, installs locked
dependencies, and builds the Repo packages. Rebuild after source changes. Dev
serves `http://localhost:9894`; `PAGES_PORT` picks another port.

`PAGES_HOST=127.0.0.1` serves the same server as `http://127.0.0.1:9894`. Use
it to connect a native MCP client that listens on `localhost` for its OAuth
callback, such as Claude Code. Pages refuses a callback on its own hostname,
because the browser would send the Pages session cookie there. A client that
listens on `127.0.0.1` needs the default, `localhost`. Sign-in and the `/mcp`
address follow the name: `http://127.0.0.1:9894/mcp`.

Metadata-based OAuth also needs public-only HTTPS egress. Local development
leaves metadata fetching disabled until that network boundary is configured;
see [Outbound requests](DEPLOYMENT.md#outbound-requests). Fixed-client OAuth
and local sign-in do not need metadata fetching.

Local sign-in uses a loopback-only OIDC issuer that a public deployment can't
enable. State persists under `dist/.celld`. A Page records its storage
mode at creation; changing a persistence flag doesn't migrate local documents.
The notebook `cargo xtask dev` workflow doesn't start Pages.

## Verify changes

From `apps/pages`:

```sh
npm test
npm run build
npx playwright install chromium firefox
npm run e2e
```

`npm run e2e` builds once, then runs each curated browser suite in turn against
its own loopback celld 0.6.3 with temporary state and a per-suite timeout. Name
suites to run a subset (`npm run e2e -- wordgard sharing`);
`npm run e2e -- --list` shows them, including opt-in suites that run only
when named. Each suite's log, celld log, report, and screenshots (failure
screenshots and HTML included) land in `test-results/e2e-<timestamp>/<suite>/`.
Any failure exits non-zero. `PAGES_E2E_RETRIES=1` reruns a failed suite once in
a fresh fixture and reports a pass on retry as flaky; more flaky suites than
`PAGES_E2E_MAX_FLAKY` (default 1) also fail the run. Each suite's result is
appended to `results.jsonl` and `summary.json` as it finishes.

The Pages experiment workflow runs setup, the unit suite in shards, and the
Pages build. A green push run of that workflow is the page10 deployment
gate. The separate Pages browser E2E workflow runs on the same changes without
holding that gate. It downloads the official celld 0.6.3 Linux x86_64
release, checks the archive hash and the executable hash in `CELLD_RELEASE`,
installs Playwright's Chromium and Firefox with system dependencies (Firefox runs
only the `output-frame-firefox` suite), runs `npm run e2e` with
one retry and a flaky budget of one, and always uploads `test-results/`.
Promotion to `pages.runtimed.run` is manual
([Promote production from the CI artifact](DEPLOYMENT.md#promote-production-from-the-ci-artifact)).
A build of `main` reads format 3 and is refused there. A format 1 fix is built
from the maintenance branch cut from the `pages-format-1` tag. Before promoting,
confirm both workflows are green for the exact source SHA. On a
fresh Linux runner, install browser system dependencies with
`npx playwright install --with-deps chromium firefox`.

The sharing suite (also `npm run test:e2e:sharing`) builds Pages and starts an
isolated celld process on an available loopback port. Three browser profiles use the real local OIDC
code/PKCE flow to test invitations, viewer/editor roles, edits, promotion,
downgrade, revocation, reload, and reconnect. Generated API keys exercise the
normal validator, MCP, ACL, and sync paths through a test-only provider response.
That fixture rejects external fetches and is absent from the production entry;
it does not qualify Anaconda's live provider or key issuance.

E2E state and credentials are temporary; existing `dist/.dev.vars` and
`dist/.celld` are not reused. Reports, screenshots, and logs remain under
`test-results/sharing-<timestamp>`. `CELLD_BIN` selects the runtime,
`PAGES_E2E_OUTPUT` selects the output directory, and `--skip-build` reuses a build.

Run targeted browser checks from `apps/pages`. `npm run e2e` runs all of these except
the latency check, which records timings without gating, and the opt-in
build-update check.

| Check | Command | Server lifecycle |
| --- | --- | --- |
| Company-domain access | `node scripts/local-sharing-e2e.mjs --domain-view` | Starts an isolated fixture |
| Browser uploads and image permissions | `node scripts/local-sharing-e2e.mjs --images` | Starts an isolated fixture |
| MCP file import, insertion, and retries | `node scripts/local-sharing-e2e.mjs --mcp-images` | Starts an isolated fixture |
| Collaborative checkboxes | `node scripts/local-sharing-e2e.mjs --task-lists` | Starts an isolated fixture |
| Admission codes, celld restart, and reconnect to Saved | `node scripts/local-sharing-e2e.mjs --admission` | Starts and restarts an isolated fixture |
| Reload prompt after a deploy under an open tab | `node scripts/local-sharing-e2e.mjs --build-update` | Starts an isolated fixture and swaps its build |
| Trash, restore, and permanent deletion | `node scripts/local-sharing-e2e.mjs --trash` | Starts an isolated fixture |
| Removed access hides the local copy across a reload, with its download | `node scripts/local-sharing-e2e.mjs --revocation` | Starts an isolated fixture |
| A commenter comments but can't edit; a forged sync edit of another author's message is refused | `node scripts/local-sharing-e2e.mjs --commenter` | Starts an isolated fixture |
| Projects over MCP and browser, `/projects` and `/pages` mobile layouts, library tabs/filters/sort/groups, breadcrumbs, Project Trash/restore | `node scripts/local-sharing-e2e.mjs --projects` | Starts an isolated fixture |
| `list_pages` `content_updated_at` after MCP and browser edits | `node scripts/local-sharing-e2e.mjs --content-activity` | Starts an isolated fixture |
| Library grid cards in light/dark/phone layouts, shared visibility, and null removal | `node scripts/local-sharing-e2e.mjs --cards` | Starts an isolated fixture |
| Boot preload timing for `/`, `/pages`, and direct Page loads (WASM and editor chunks) | `node scripts/local-sharing-e2e.mjs --home-boot` | Starts an isolated fixture |
| Library grid LCP on Fast 4G (24 Pages, card images, first-click editor open; non-gating; env: `PAGES_LCP_RUNS`, `PAGES_LCP_PAGES`, `PAGES_LCP_HTTP=1.1`, `PAGES_LCP_OPEN=page`) | `node scripts/local-sharing-e2e.mjs --library-lcp` | Starts an isolated fixture behind an HTTP/2 brotli proxy (needs `openssl`); writes `report.json` |
| Cold first open of a 300-paragraph Page on Fast 3G and 4x CPU (non-gating) | `node scripts/local-sharing-e2e.mjs --cold-open` | Starts an isolated fixture behind a brotli proxy; writes `report.json` |
| Standalone Vega-Lite chart renderer: CSP, tooltips, light/dark/phone, Maximize, `url()` blocking, hung-chart timeout, max-size timing (`PAGES_CHART_ENGINES=chromium,firefox,webkit`) | `node scripts/chart-smoke.mjs` | Builds and serves its own fixture page; no celld |
| Rich comment tables and drafts | `PAGES_ORIGIN=http://localhost:9894 node scripts/rich-comments-smoke.mjs` | Uses the running Wordgard fixture |
| Comments panel placement at 1920/1440/1100/800px | `PAGES_ORIGIN=http://localhost:9894 node scripts/comments-layout-smoke.mjs` | Uses the running Wordgard fixture |
| Comment review mode at 1440/800px: `J` navigation, Resolve and next, scroll lock and restore | `PAGES_ORIGIN=http://localhost:9894 node scripts/comments-review-smoke.mjs` | Uses the running Wordgard fixture |
| Schema-feature gate: unknown feature opens read-only and refuses tool writes | `PAGES_ORIGIN=http://localhost:9894 node scripts/schema-features-smoke.mjs` | Uses the running Wordgard fixture |
| Native table editing | `PAGES_ORIGIN=http://localhost:9894 npm run smoke:tables` | Uses the running Wordgard fixture |
| Passage edits and revision deltas | `PAGES_ORIGIN=http://localhost:9894 node scripts/passages-changes-smoke.mjs` | Uses the running Wordgard fixture |
| Reload banner placement, browser presence labels, leaving a final code block, checkbox indent | `PAGES_ORIGIN=http://localhost:9894 node scripts/editor-chrome-smoke.mjs` | Uses the running Wordgard fixture |
| Heading links: cold/warm scroll stability, late images, duplicate `#notes-1`, table links, copy `#`, cross-Page anchors, Back/Forward, and user-scroll cancel | `PAGES_ORIGIN=http://localhost:9894 node scripts/heading-anchors-smoke.mjs` | Uses the running Wordgard fixture |
| Page and Project links: glyphs, locked inaccessible links, hover cards, bare-link chits, keyboard/paste/copy/undo flows, and light/dark screenshots at 1280 and 390 px | `PAGES_ORIGIN=http://localhost:9894 node scripts/page-links-smoke.mjs` | Uses the running Wordgard fixture |
| Local creation and navigation | `PAGES_ORIGIN=http://localhost:9894 node scripts/navigation-smoke.mjs` | Uses the running Wordgard fixture |
| Editing, comments, links, diagrams, and recovery | `PAGES_ORIGIN=http://localhost:9894 npm run smoke:editor` | Uses the running Wordgard fixture |
| History growth and typing latency | `PAGES_ORIGIN=http://localhost:9894 node scripts/latency-smoke.mjs` | Uses the running Wordgard fixture |
| One keystroke, a hard line break, and one remote character through the Wordgard binding on 115 KB marked, 16 KB marked and 118 KB plain blocks, base revision against this checkout (records timings, gates on nothing) | `node scripts/binding-benchmark.mjs` | Node only, no server or DOM; `PAGES_BINDING_BASE` picks the base (default `origin/main`); writes `test-results/binding-benchmark.json` |
| `list_pages` for 50 shared Pages with cold and warm Page hosts, p50/p95 (records timings, gates on nothing) | `node scripts/local-sharing-e2e.mjs --listing-bench` | Starts an isolated fixture and restarts it between cold samples; writes `listing-benchmark.json` |

The editor checks exercise the same Wordgard path used by deployed Pages.

Choose one `local-sharing-e2e.mjs` feature flag per run. Its image importer fixture
supplies a synthetic ChatGPT download response; actual client file handoff needs
live verification. Synthetic browser tests also do not establish real OS IME,
mobile-keyboard, object-store failover, or deployment reliability.
