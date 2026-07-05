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
simultaneously hoisted a lucide-icons vendor chunk (`icons-*.js`, 273.28 kB
raw / 70.35 kB gzip) into the entry's static closure - before, that weight
lived inside the workstations chunk that every route loaded anyway, so the
swap nets out. Cold `/workstations` is +13.16 kB gzip versus the old
monolith: it now pays entry + icons + its two route chunks + several small
split chunks.

**Identified follow-up:** the always-loaded icons chunk is the single biggest
lever left. The entry-graph views use a handful of icons; if the 70 kB gzip
chunk is mostly workstations/notebook iconography that per-icon tree-shaking
or chunk hints could keep out of the entry closure, `/n` cold load drops by
tens of kB gzip. Needs its own investigation (why rollup groups these icons
into one shared chunk) before any config change.

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

## Not measured here

Runtime render counts (React Profiler), INP/TBT, and reconnect behavior under
auth renewal need a live browser session against a hosted or wrangler-served
build - the store suites cover the semantics in virtual time, but interactive
timing needs the browser. Candidate harness: the hosted smoke scripts plus a
profiler pass, or a nightly-gremlins run.
