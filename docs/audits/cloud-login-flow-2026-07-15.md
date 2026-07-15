# Cloud login and notebook-open flow audit

Evidence from a Chrome performance trace of preview.runt.run recorded 2026-07-15: logout, sign in with Anaconda (staging Ory), open a notebook in edit mode. Emulated network: 1 MB/s down, 165 ms RTT. Recorder flow and trace live with the analysis notebook in the maintainer's recording archive; the request waterfall, long-task extraction, and websocket timeline are reproducible from `login-flow-analysis.ipynb` against the trace.

## Headline

The flow takes 12.9 s end to end. Main-thread blocking accounts for 0.51 s (five tasks over 50 ms, worst 148 ms). Everything else is serialized network ceremony. The perceived jank is waiting, not rendering.

## Findings, by cost

### 1. Session ceremony: ~7.2 s across nine `/api/auth/session` calls

- `POST /api/auth/session` at 0.55 s took **4.2 s**, at 8.43 s took **1.9 s**, at 7.10 s (OIDC callback) took 0.8 s, at 10.89 s took 0.3 s.
- `DELETE /api/auth/session` (logout) took **2.8 s** to clear a cookie; the handler body is three lines, so the latency is upstream of the handler (worker scheduling or platform, needs a worker-side trace).
- Four `GET /api/auth/session` calls (~170 ms each) interleave with the POSTs.

Server side (`routeAppSession` in `apps/notebook-cloud/src/index.ts`): the POST path runs `authenticateRequestOrResponse`, which validates upstream against Anaconda auth on every call. The GET path already knows how to bootstrap an app session from the host session cookie (`hostSessionAppSessionCookie`). Client side, page mounts POST rather than GET: the post-OIDC reload at 8.43 s POSTs again 1.3 s after the callback page already established the session at 7.10 s.

Direction (the "session diet"): clients bootstrap with GET only; POST happens exactly once, at the OIDC callback; page mounts never re-validate upstream. Instrument the worker to explain the 2.8 s DELETE and the 4.2 s worst-case POST.

### 2. Three full page loads, each revalidating immutable assets

Full document navigations at 0.01 s (`/n`), 7.89 s (post-OIDC return to `/n`), and 10.35 s (`/n/{id}?mode=edit`). The notebook link is a full navigation, not a client-side route. Each load refetches ~20 content-hashed assets; the third load gets **304 revalidations on every chunk** (~165 ms each, in two to three dependent waves). Content-hashed filenames should ship `cache-control: public, max-age=31536000, immutable` and never revalidate; the notebook open should be an SPA transition. This is the app-shell-local-first doctrine applied to the cloud viewer.

### 3. Room websocket handshake: 1.4 s, serialized behind everything

`WebSocketCreate` at 11.21 s, handshake request at 11.30 s, response at **12.62 s**. Sync frames flow immediately after. The 1.3 s handshake gap is consistent with room Durable Object wake on connect. The socket also opens only after the session POST and alongside `/api/n/{id}` (604 ms) rather than racing them. Directions: open the sync socket concurrently with metadata, and measure DO wake as its own metric (progressive-connect territory).

### 4. Small dedup bugs

- OIDC discovery (`.well-known/openid-configuration`) fetched twice per flow (before redirect and at callback).
- Three output blobs each fetched twice during notebook load; the iframe theme frame (`runtusercontent.com/frame/?nteract_theme=light`) loaded three times.

### 5. The signed-out page design

The first-party signed-out page (the "Sign in with Anaconda" screen) predates the Mono Ledger host-chrome direction and does not match the current component system. Design work, tracked under the unified-site-chrome arc; not a perf item.

## Sequencing

1. Session diet (this audit's companion PRs): client GET-first bootstrap, single POST at OIDC callback, worker instrumentation for the slow POST/DELETE.
2. Immutable cache headers on hashed assets; SPA route for notebook open (app-shell arc).
3. Sync-socket concurrency + DO wake measurement (progressive-connect arc).
4. Dedup fixes (discovery, blobs, theme frame) as they are found in code.
5. Signed-out page redesign (unified-site-chrome arc).
