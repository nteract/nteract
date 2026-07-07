# Store Refactor: Bundle and Timer Measurements

**Status:** Measurement, 2026-07-06.

Before/after evidence for the cloud viewer store refactor (#3906, #3909,
#3910): what the RxJS store layer and the `/workstations` route split actually
changed in shipped bytes and runtime timer load. BEFORE is `4b4ed8420` (the
commit before #3906); AFTER is main at `0e05a4e86`. Both sides were built,
not estimated.

## Method

```bash
# AFTER: in place on main
pnpm --dir apps/notebook-cloud build:viewer

# BEFORE: disposable worktree
git worktree add /tmp/nteract-before 4b4ed8420
cd /tmp/nteract-before && pnpm install --frozen-lockfile
CARGO_TARGET_DIR=$HOME/.cache/runt-agent-target \
  cargo xtask artifacts ensure runtime,sift,renderer
pnpm --dir apps/notebook-cloud build:viewer
```

Chunk sizes come from vite's rollup report. Route payloads are the static
closure of each route's chunk graph, traced by grepping `from "./x.js"` /
`import("./x.js")` specifiers out of the built files and walking the graph -
this matches what a browser fetches on a cold visit but was not captured via a
live network trace.

## Bundle results

| Metric | Before | After |
|---|---|---|
| Entry chunk `notebook-cloud-viewer.js` (raw) | 334.71 kB | 302.79 kB (-9.5%) |
| Entry chunk (gzip) | 84.99 kB | 77.37 kB (-9.0%) |
| Workstations code location | in the entry's static closure, every route (269.45 kB raw / 70.09 kB gzip incl. bundled icons) | two lazy chunks, `/workstations` only (55.90 kB raw / 14.35 kB gzip) |
| Cold `/n` payload (JS+CSS, gzip) | 222.81 kB | 220.86 kB (-1.95 kB) |
| Cold `/workstations` payload (gzip) | 222.81 kB | 235.97 kB (+13.16 kB) |
| Chunks in `/n` load path | 10 | 12 |
| notebook-route lazy chunk (gzip) | 255.67 kB | 251.94 kB (noise-level) |

## Reading the numbers honestly

The headline win is **scope isolation, not raw bytes**. The workstations
surface (store + management page UI) no longer ships to notebook and dashboard
visitors, and the code that moved is now 14.35 kB gzip instead of riding
inside a 70 kB chunk on every route.

The byte-level win on `/n` is small (-1.95 kB gzip) because vite's rechunking
simultaneously hoisted a large shared chunk (`icons-*.js`, 273.28 kB raw /
70.35 kB gzip) into the entry's static closure - before, that weight lived
inside the workstations chunk that every route loaded anyway, so the swap nets
out. Cold `/workstations` is +13.16 kB gzip versus the old monolith: it now
pays entry + that shared chunk + its two route chunks + several small split
chunks.

**The `icons-*.js` name is a bundler artifact, not a description** (re-measured
at `7a5ce4d14`). rolldown names an auto-generated chunk after one of the ~130
source regions it bundles together, and here it picked a lucide module - but the
chunk's weight is shared viewer/runtime infrastructure: RxJS, `packages/runtimed`
store and projection modules, cloud auth/session code, and the dashboard stores.
Only 6 lucide icon definitions live in it. Tree-shaking is working bundle-wide
(73 lucide icon factories total, 23 in the entry's first-load closure), so
per-icon tree-shaking or chunk hints would not move first-load bytes. An earlier
draft of this memo called this "the always-loaded icons chunk, the single
biggest lever left"; that was reading the chunk's name, not its contents.

**Follow-up, first cut landed (#3918):** the 70 kB gzip always-loaded chunk is
real, and the lever is what pulls RxJS, the `runtimed` store/projection code, and
the cloud dashboard stores into the entry's static closure
(`apps/notebook-cloud/viewer/index.tsx`, `notebook-dashboard.ts`), not icon import
style. PR #3918 took the first cut: it split the store-consumption seam so the
three non-auth source stores (access-request, catalog, workstations) load with
their lazy routes instead of the `/n` cold path. Measured 8.6 kB gzip off the
shared always-loaded chunk (69.4 -> 60.8 kB); the entry chunk is unchanged. An
earlier ~13 kB estimate was optimistic - the shared runtime deps stay because the
always-loaded auth and dashboard code uses them too, so only the store-specific
code leaves. Deferring more route-specific store/projection code out of the
first-load closure is the remaining lever.

## Timer and listener census

Method: `git grep` at `4b4ed8420` vs the current checkout, non-test viewer
code; runtime sets counted by reading the old hook bodies and the new
`activate()` drivers.

| Metric | Before | After |
|---|---|---|
| Wall-clock timer call sites (viewer, non-test) | 23 | 16 (+3 RxJS `timer()` in stores) |
| Auth timer/listener installs per page | 7 (2 intervals + 5 DOM listeners), rebuilt on every view mount, duplicated in source across 4 views | 2 timers + 3 driver subscriptions in one `activate()`; 3 DOM listeners are app-lifetime shared singletons (`browser-signals.ts`) |
| Chained-`setTimeout` poll loops | 3 (two of them independent hand-rolled copies of the same registry poll) | 0 |
| `createPoll` call sites | 0 | 3 (one collapses the duplicate registry polls, one migrates the pairing poll, one is the new access-request poll) |
| Dedicated store tests | 0 | 69 across 4 suites (virtual-time driver contracts) |

Two honest notes. First, the views are separate routes, so only one mounted at
a time: the per-page runtime cost before was 7 installs, not 7x4 - the x4 was
source duplication (four hand-maintained copies of the same wiring), which is
a maintenance win more than a runtime one. Second, the transport-layer timers
(`live-sync.ts`, `runtimed-wasm-client.ts`, `sync-heal.ts` - 16 sites) are
deliberately untouched; this refactor only claimed the view/hook layer.

The coverage delta is the sharpest number: of the three poll loops, only the
rail registry poll had any tests before. The pairing poll and the standalone
page poll shipped with zero coverage; both now sit behind `createPoll` inside
stores with 29- and 20-test suites.

## Measured locally (wrangler + Playwright)

`pnpm --dir apps/notebook-cloud profile:local` (scripts/profile-local.mjs)
drives local wrangler with Playwright: cold-route timing, long-task and
event-timing proxies, WebSocket census, render commits via the `?profile=1`
`<Profiler>` hook (needs `NOTEBOOK_CLOUD_PROFILE_REACT=1 build:viewer` - the
default react-dom keeps `<Profiler>` inert), and a reconnect-stability check.

Results on this machine (profiling build, 10s settle):

- **Reconnect stability, the property the auth store must hold:** on a live
  notebook room, two focus/visibility refresh cycles produced
  `openedNewWebSocket=false, reloaded=false` - one socket before, one after.
  The reference-held `appSession$` does its job in a real browser, not just
  in virtual time.
- Render commits after settle: `/n` 7, `/workstations` 7, notebook room 16.
  - Re-measured 2026-07-07 on main 4281c7851 (post store-consolidation
    #3906/#3909/#3910, CloudUserStore #3923, copy pass #3954), two runs,
    identical: `/n` 8, `/workstations` 7, notebook room **14**. The room
    dropped two commits; `/n` gained one (unattributed - within a commit of
    band, watch on the next measurement). Reconnect probe PASS (ws 1->1,
    reload nonce survived); renewal probe PASS (`tokenRotated=true`,
    `appSession=true`, ws 1->1).
- Notebook-route marks: `viewer-start@~490ms`, `live-room-ready@~525`,
  `live-initial-cells@~615`, `live-ready@~635` (fresh empty notebook, so the
  live path fires rather than instant paint).
- TBT proxy 0 (no >50ms long tasks during load+settle); INP proxy sits at the
  Event Timing API's 16ms floor for the scripted interactions.

Harness limits: wrangler dev serves uncompressed (byte figures there are raw,
not gzip - use the bundle table above for payload comparisons); headless
cannot truly background a tab, so the reconnect check drives synthetic
focus/visibility events; instant-paint marks need a notebook with a persisted
snapshot.

## Renewal path

Renewal-path behavior against a real OIDC issuer (token rotation ->
`authState$` identity -> live-room key stability) is now exercised end to end by
the dev OIDC issuer (`@nteract/local-oidc`, #3914), which the local wrangler
mounts; the loopback-trust auth mode alone does not drive the OIDC refresh
driver. The `profile-local.mjs` renewal probe measures it, and holds green only
when a real app-session was established, a live room socket existed before
rotation, the token actually rotated, and the post-rotation reconnect stayed
stable - a vacuous 0-to-0-socket pass no longer counts.
