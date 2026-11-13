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

Local sign-in uses a loopback-only OIDC issuer that a public deployment can't
enable. State persists under `dist/.celld`. A Page records its storage
mode at creation; changing a persistence flag doesn't migrate local documents.
The notebook `cargo xtask dev` workflow doesn't start Pages.

## Verify changes

From `apps/pages`:

```sh
npm test
npm run build
npx playwright install chromium
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
installs Playwright's Chromium with system dependencies, runs `npm run e2e` with
one retry and a flaky budget of one, and always uploads `test-results/`.
Promotion to `pages.runtimed.run` is manual
([Promote production from the CI artifact](DEPLOYMENT.md#promote-production-from-the-ci-artifact)).
A build of `main` reads format 3 and is refused there. A format 1 fix is built
from the maintenance branch cut from the `pages-format-1` tag. Before promoting,
confirm both workflows are green for the exact source SHA. On a
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
| Projects over MCP and in the browser, `/projects` and `/pages` on a phone-sized screen, the Pages library's tabs, Project filter, sort and groups as an account with shared Pages, breadcrumbs, Trash and restore in a Project | `node scripts/local-sharing-e2e.mjs --projects` | Starts an isolated fixture |
| `list_pages` reports `content_updated_at` after an MCP edit and after typing in a tab, each well after the Page's creation | `node scripts/local-sharing-e2e.mjs --content-activity` | Starts an isolated fixture |
| Grid cards show each edited Page's first content in light, dark and phone layouts; a shared card shows for its member and `page_cards` answers null on the call after removal | `node scripts/local-sharing-e2e.mjs --cards` | Starts an isolated fixture |
| Cold first open of a 300-paragraph Page with images on Fast 3G and 4x CPU, phase by phase (records timings, gates on nothing) | `node scripts/local-sharing-e2e.mjs --cold-open` | Starts an isolated fixture behind a brotli proxy; writes `report.json` |
| Rich comment tables and drafts | `PAGES_ORIGIN=http://localhost:9894 node scripts/rich-comments-smoke.mjs` | Uses the running Wordgard fixture |
| Comments panel placement at 1920/1440/1100/800px | `PAGES_ORIGIN=http://localhost:9894 node scripts/comments-layout-smoke.mjs` | Uses the running Wordgard fixture |
| Comment review at 1440/800px: whole messages through J and Resolve and next, the Page behind holds still under wheel and touch and keeps its scroll after Exit review, Resolve and next hovers green in light and dark | `PAGES_ORIGIN=http://localhost:9894 node scripts/comments-review-smoke.mjs` | Uses the running Wordgard fixture |
| Schema-feature gate: a Page stamped with an unknown feature opens read-only and refuses tool writes | `PAGES_ORIGIN=http://localhost:9894 node scripts/schema-features-smoke.mjs` | Uses the running Wordgard fixture |
| Native table editing | `PAGES_ORIGIN=http://localhost:9894 npm run smoke:tables` | Uses the running Wordgard fixture |
| Passage edits and revision deltas | `PAGES_ORIGIN=http://localhost:9894 node scripts/passages-changes-smoke.mjs` | Uses the running Wordgard fixture |
| Reload banner placement, browser presence labels, leaving a final code block, checkbox indent | `PAGES_ORIGIN=http://localhost:9894 node scripts/editor-chrome-smoke.mjs` | Uses the running Wordgard fixture |
| Heading links: a fragment scrolls to its heading on a cold load, a warm reload and in a fresh context, and holds it while an image above draws late; `#notes-1` picks the second Notes; an unknown anchor stays at the top; table cell links go there read-only and through Go to section; the # copies the link `read_page` names; another Page's heading opens in place; Back and Forward restore each entry's position on the same Page and across Pages; scrolling during the settle, or scrolling the preview while sync is held, stops it | `PAGES_ORIGIN=http://localhost:9894 node scripts/heading-anchors-smoke.mjs` | Uses the running Wordgard fixture |
| Links between Pages and to Projects: the Page glyph only on links to other Pages and the Project glyph on Project links, once per link however its text is formatted, typing and copying around it, the hover card's readable, unavailable and loading faces for Pages and Projects, crossing a formatted link without closing, Escape, Tab into a comment link's card and back, Open in place, chits for bare links (titles, unavailable, hover card, link menu, reveal on caret, paste, undo, paste as plain text, copy, comments), and screenshots light and dark at 1280 and 390 px | `PAGES_ORIGIN=http://localhost:9894 node scripts/page-links-smoke.mjs` | Uses the running Wordgard fixture |
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
