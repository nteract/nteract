# Instant-paint validity and the SSR opening from first-party sessions

Status: memo. Captures a production concern in the cloud viewer's optimistic
early render and the server-bootstrap opening the app-session cookie now creates.

## The concern: early paint keys on session presence, not validity

`cloudInstantPaintPrincipalMatcher` (`apps/notebook-cloud/viewer/instant-paint.ts`)
renders persisted notebook content before the room handshake, deriving a principal
matcher from locally stored auth material. For OIDC its gate is:

```
oidc_expired && hasAppSession === true
```

That checks the app-session cookie's presence, not whether the refresh token is
still valid. The cookie sits in the browser until something actively tries to
refresh it and fails. A session whose refresh token was revoked or expired
server-side still reads `hasAppSession === true`. The viewer then paints the
user's last-known content until the app-session refresh fires, fails, and gates
them.

The matcher's documented backstops all defend against a *wrong-principal*
(cross-user) paint:

- the post-handshake principal guard,
- live materialization replacing the paint, and
- an authoritative empty room displacing it.

None of them addresses a *present-but-dead* session. Because the painted
content is the user's own sub-matched local data, this is not a cross-user
leak. The sharp edge is a revoked or refresh-dead user seeing their last-known
content for a beat before the handshake catches up. This is a "gate on
validity, not presence" problem, in the same family as reconnect stale-write
guards: a present token or cookie is not proof the session is live.

## Why it exists: the viewer renders client-side

The heuristic is a workaround for client-only rendering. Because browser auth
is `localStorage`-based, the Worker cannot server-render authenticated HTML on
first navigation. It ships a shell, and the client optimistically reconstructs
what it can from local material. Instant paint is that optimism. Its validity
gap is inherent to assuming early on the client instead of confirming on the
server.

## The opening: first-party sessions make server bootstrap reachable

The OIDC work added a first-party app-session cookie, which makes server
bootstrap of app-owned routes viable. On the first request, the Worker can read
the app-session, confirm it against the session store, and return correct
content (or a clean gate) for app-shell routes like `/n`. Existing host-shell
boundaries stay intact: room WebSocket upgrades stay origin-checked and
cookie-first with explicit bearer fallback
(`docs/adr/hosted-credential-transport.md` Decision 2), and output frames stay
on the isolated origin. Only the app-owned shell HTML moves server-side.

Server-rendering (or server-bootstrapping) the app shell would dissolve the
present-vs-valid gap for those routes in one move. The server would gate on a
validated session, so no client window paints ahead of validity. Instant paint
would remain the mechanism for the live notebook room (which is inherently a
client handshake), while the dashboard and other app-owned surfaces would not
need to guess.

## Open questions

- **Scope:** which routes are app-owned enough to server-bootstrap (`/n`,
  sharing, home) versus inherently client-handshake (the live room)?
- **Interim:** should we add a client-side validity gate on early paint (probe
  app-session freshness before trusting `hasAppSession`) before any SSR work?
  Or does that add a hot-path request for a case the handshake already
  backstops?
- **Cost:** server bootstrap requires the Worker to render or hydrate the shell
  with session-validated data. How much of the current client bootstrap
  (`loadCloudNotebookListBootstrap`) already models this and can move
  server-side?

Not a decision. A pointer at where the real production correctness lever is, and
why the app-session cookie changed what is reachable.
