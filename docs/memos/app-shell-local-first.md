# The app shell should be local-first too

**Status:** Memo, 2026-07-06. Policy statement for cloud app-shell surfaces; the
notebook document layer already works this way.

## The pattern behind a season of bugs

Every shell-loading bug found while hardening the cloud viewer was the same
defect in a different organ: **a durable fact held hostage by a liveness
signal.**

- The OIDC callback spun forever because the token exchange had no deadline -
  fixed in #3930 with library-layer timeouts and a retryable error state.
- `/n` skeletons indefinitely when app-session establishment persistently
  fails: `waitingForAppSession` in `notebook-list-view.tsx` has no timeout, no
  fallback fetch, no error exit (#3928, reproduced live).
- The post-expiry cold load serializes OIDC refresh -> session establish ->
  list fetch, each gating the next, with a skeleton the whole way - even though
  the list content did not change while the cookie aged out (#3928).
- Identity display used to be re-derived per surface, each one independently
  deciding whether it "knew who this is yet" - unified by the cloud user store
  (#3923, `docs/adr/cloud-user-store.md`).

Who you are, what your notebook list looks like, and what a collaborator is
called are durable facts. Whether a token is fresh *right now* is a liveness
signal. The notebook layer already renders durable state and syncs in the
background; the shell around it has been strictly server-first: no session, no
pixels.

## Policy

1. **Render from last-known-good; revalidate in the background.** A shell
   surface that has ever shown content for this principal should reopen with
   that content (marked stale if needed), not a skeleton. Skeletons are for
   "we genuinely know nothing," not "we are re-proving what we knew."
2. **Every async gate gets three exits.** Success, deadline (fall through to
   the next-best source: cached content, a direct fetch with existing
   credentials), and error (visible, with a retry that actually restarts the
   work). A gate with only the success exit is a bug even when the happy path
   is fast - #3930's callback and #3928's session gate both shipped that way.
3. **Cache validity is principal-keyed and matcher-gated.** Cached shell state
   is only paintable for the principal that produced it, using the same rules
   `cloudInstantPaintPrincipalMatcher` already encodes. A present-but-dead
   session may paint cached content in the renewal window
   (`docs/memos/instant-paint-validity-ssr.md`); a *different* principal never
   inherits a cache.
4. **Liveness signals gate actions, not paint.** Authorization decisions, room
   credentials, mutations, and anything that grants capability stay strictly
   liveness-gated - no cached ACL answers, no optimistic capability. The cache
   only ever stands in for content the principal had already been shown.

## What this implies next (#3928 levers)

- Persist the `/n` list cache (today window-scoped in
  `writeCachedCloudNotebookListToWindow`) to localStorage, principal-keyed, as
  stale-while-revalidate.
- Bound the `waitingForAppSession` gate: deadline, then attempt `/api/n` with
  whatever credentials exist, then an error state with retry.
- Race the list fetch with OIDC refresh instead of serializing behind it.
- Server bootstrap remains the best case (cookie valid -> full content in the
  HTML); the cache covers the window where the cookie is dead and the refresh
  is in flight; the skeleton survives only for genuinely-new principals.

New shell surfaces (workstations, sharing ledgers, future dashboards) should be
built against this policy from the start rather than retrofitted.

## Boundaries

- This is app-shell policy. Notebook and runtime documents already have a
  stronger model (Automerge, `docs/adr/local-first-notebook-state.md`).
- Nothing here weakens `docs/adr/hosted-credential-transport.md`: tokens,
  cookies, and room tickets keep their existing custody and freshness rules.
  The change is what the *pixels* wait on, not what the *capabilities* require.
