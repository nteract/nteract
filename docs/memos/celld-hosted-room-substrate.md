# celld as a Hosted Room Substrate

**Status:** Memo / proposal, 2026-09-11. Not an accepted deployment decision.

This memo looks at what changes, and what doesn't, if hosted notebook rooms run
on [celld](https://github.com/denoland/celld) instead of Cloudflare's own
Workers runtime. It follows a two-day proof (`~/projects/sandbox/celld-lab`,
field notes in `NOTES-celld.md`) that ran the real `apps/notebook-cloud`
Workers — app, output-frame shell, renderer-asset sidecar — on a single lab box
behind a Cloudflare Tunnel at `app.runt.run`, with Anaconda OIDC as the identity
provider; S3 was the only external *storage* dependency (the proof still
depends on Cloudflare Tunnel for public ingress and Anaconda for identity).

Related:

- [Deployment Topology](../adr/deployment-topology.md) — Decision 1 names
  Cloudflare as the current hosted document engine and points at
  `aws-rust-room-host.md` as the only proposed alternative.
- [AWS Rust Room Host](aws-rust-room-host.md) — a from-scratch Rust
  reimplementation of the room host on Postgres/S3.
- `~/projects/sandbox/celld-lab/{README.md,NOTES-celld.md}` — the proof's
  terraform, deploy scripts, and verified field notes (not in this repo).

## Why this is a different axis than the Rust room host

The AWS Rust memo asks "should we stop being a Cloudflare Worker?" celld asks
"can the same Cloudflare Worker run somewhere we control?" celld hosts Durable
Objects, D1, and R2 bindings against workerd-compatible semantics on a plain
box, with a bucket as the only durable dependency. The proof shipped the
unmodified `apps/notebook-cloud` build (minus a project-layout export step) and
got working Durable Objects with SQLite storage and hibernatable WebSockets, D1
via `prepare/bind/run/batch`, R2 streaming, and content-addressed deploys: a
0.17s bundle step, one PUT, and a pointer move (the field notes measure the
bundle step, not wall-clock time for the full deploy-and-adopt cycle). That is
a substrate swap, not a rewrite: the document engine, ACL model,
frame protocol, and route contracts in `deployment-topology.md` Decision 1
still hold. Nothing in this memo asks to revisit that decision's ownership
model — it asks where the same document engine can physically run.

That framing matters for scope: this is not a competing candidate to the Rust
room host memo's Postgres/S3 target shape. It is a third point in the same
space — same Worker code, different iron — and it should be evaluated against
what it buys (below), not against feature parity with a hand-built room host.

## What the proof bought

- **Ops control the Cloudflare edge doesn't give us.** Direct SSH, `journalctl`,
  systemd units, and box-level metrics on `lab1`. Verified idle footprint:
  ~90 MB RSS per node with a live room.
- **A path off per-request Workers billing for a fixed fleet**, if that ever
  matters — celld nodes are systemd services on hardware we already pay for.
- **A deployment surface for on-prem or air-gapped hosted rooms**, since celld
  only needs a bucket, not Cloudflare's control plane. This is the most likely
  actual product driver: a BYOC or self-hosted hosted-rooms story without a
  second implementation to maintain.

## What the proof cost

The frictions in `NOTES-celld.md` are the real price of this axis, grouped by
how fixable they are from our side:

**Ours to fix or work around (already did):**
- Worker config must be `wrangler.json[c]`, not `.toml`; multi-Worker deploys
  need three prefixes/processes today; dynamic `import("./x.wasm")` needs a
  static shim; `request.url` needs a `NOTEBOOK_CLOUD_PUBLIC_ORIGIN` env instead
  of forwarded-header trust behind a plain-HTTP tunnel hop.

**celld's to fix, with a workaround in hand:**
- No idle-isolate-retirement knob (76 cold-start/retire pairs in 45 minutes of
  light use, each evaluating a 4.8 MB bundle + 4 MB WASM). No
  `X-Forwarded-Proto`-only trust option (we added a public-origin env instead).
  Log volume defaults to INFO-per-second ship-loop noise per node.

**Open, not yet proven either way:**
- Multi-node failover: bring up a second node, kill the room owner mid-session,
  measure takeover (the August 0.3 proof saw 3–4s takeover, ~30s client
  reconnect — the reconnect gap is ours to shorten, not celld's).
- Whether one celld deployment can host multiple Workers behind host-based
  routing, collapsing the app/outputs/renderer-assets split to one process.
- `celld d1 migrations apply` against a fleet bucket instead of the ~30–120s
  lazy schema bootstrap on first catalog access.

None of these are blocking for a lab proof. Several are blocking for treating
`app.runt.run` as more than a demo box: single-node means unattended-upgrade
restarts are an outage (observed 2026-09-11, 16s down), and the 3–4s/30s
failover numbers are unmeasured on this deployment's Cloudflare Tunnel path.

## Promotion gates

Treating celld as more than a lab/demo substrate requires all of the following
to hold for the exact promoted binary (SHA256-pinned):

- **Activation authority** ([nteract#4295](https://github.com/nteract/nteract/issues/4295)):
  an evicted Durable Object activation must not be able to write storage or
  publish on a retained WebSocket when a sibling activation in the same isolate
  resumes its retained JavaScript callback. The host must bind retained resource
  authority to the activation identity that granted it, validate that identity
  at the native effect boundary (write admission and delayed flush; WebSocket
  publication), and revoke it on release before a replacement activation can
  operate on the same scope — while still allowing a freshly activated handler
  to use hibernated sockets. JavaScript wrapper checks alone are insufficient
  authority. The regression probe
  `apps/preview-python/test/stale-activation-celld.test.mjs` diagnoses retained
  storage and socket effects against an isolated candidate binary. Its immediate
  effects and controls are not proof of delayed-flush fencing or of the complete
  native read/delete, sync KV, SQL, transaction, and alarm boundaries. Missing
  native evidence keeps full qualification blocked. Repository-local room
  checks and socket cleanup are defense-in-depth, not a substitute for host
  revocation. Evidence must identify the exact executable and independently
  observed effects; optional skipped developer tests are not qualification.
  The explicit `qualify:activation` verification is separate from normal service
  launch and preview deployment. A reviewed qualification decision must bind
  source/native release-revocation, delayed-application/flush interleavings,
  individual surface dispositions and build/child-execution evidence to the
  candidate hash/platform and probe configuration. Content-hash verification
  establishes evidence identity, not the authenticity of a claimed human review.
  Unsupported APIs need source-backed unavailability and an explicit reviewed
  policy; they are not automatically passing surfaces. No runtime admission
  manifest, launch refusal or preview hiding is part of this correction.
- **HTTP shared-promise ownership**
  ([nteract#4296](https://github.com/nteract/nteract/issues/4296)) and the
  hard-termination fixes on the Python Workers branch
  (`apps/preview-python` runtime qualification section).

Neither gate has a complete passing record as of 2026-10-02. A local automated
run on SHA256 `91f6d7a470720c300efddf75e666f121c0f51bbaf7a245d9d76efffaefeecf57`
reproduced the #4295 stale storage write and socket publication, including the
timer-first variant. This is local qualification evidence, not a production
incident claim or evidence about every newer binary. The current work changes
only nteract's diagnostics and bounded room behavior, not the celld runtime.
The recorded failure is preserved with its original probe-source identity; it
does not imply that later harness revisions, either historical ticket artifact,
or all supported deployment platforms were retested. Native authority and the
other promotion requirements remain open until reviewed exact-candidate evidence
is complete.

## Open questions

1. Is the product driver for celld actually BYOC/self-hosted, or is it ops
   control over a Cloudflare-hosted fleet we already fully own? The answer
   changes whether celld competes with "run more Workers regions" or with the
   Rust room host memo's target shape.
2. Does a second lab node change the failover story enough to trust celld for
   anything beyond a demo, or does the reconnect gap live in our client code
   regardless of host?
3. Should `apps/notebook-cloud`'s export step (`scripts/celld-local.mjs`)
   become a first-class, tested deploy target, or stay a lab-only script until
   question 1 has an answer?
4. Do we want to push the idle-isolate-retirement knob and the
   `X-Forwarded-Proto`-only trust option upstream to celld, or keep carrying
   local workarounds?

## Non-Goals

- Replacing Cloudflare as the primary hosted document engine. This memo does
  not revisit `deployment-topology.md` Decision 1.
- Deciding between celld and the Rust room host memo's target shape. They
  answer different questions and are not mutually exclusive.
- Running kernels on celld nodes. The runtime-peer boundary in
  `deployment-topology.md` is unchanged; celld only changes where the document
  engine's Worker code executes.
