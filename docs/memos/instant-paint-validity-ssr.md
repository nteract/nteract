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

That is a check on the app-session cookie's presence, not on the refresh token
still being valid. The cookie sits in the browser until something actively tries
to refresh it and fails. So a session whose refresh token was revoked or expired
server-side still reads `hasAppSession === true`, and the viewer paints the user's
last-known content in the window before the app-session refresh fires, fails, and
gates them.

The matcher's documented backstops - the post-handshake principal guard, live
materialization replacing the paint, an authoritative empty room displacing it -
all defend against a *wrong-principal* (cross-user) paint. None of them addresses
a *present-but-dead* session. The painted content is the user's own sub-matched
local data, so this is not a cross-user leak. The sharp edge is a user whose
access was revoked, or whose refresh is dead, seeing their last-known content for
a beat before the handshake catches up. That is a "gate on validity, not
presence" problem, the same family as the reconnect stale-write guards: presence
of a token or cookie is not proof the session is live.

## Why it exists: the viewer renders client-side

The heuristic is a workaround for client-only rendering. Browser auth is
localStorage-based, so on first navigation the Worker cannot server-render
authenticated HTML - it ships a shell and the client optimistically reconstructs
what it can from local material. Instant paint is that optimism. Its validity gap
is inherent to assuming early on the client instead of confirming on the server.

## The opening: first-party sessions make server bootstrap reachable

The OIDC work added a first-party app-session cookie. That is precisely the layer
that makes server bootstrap of app-owned routes viable: the Worker can read the
app-session on the first request, confirm it against the session store, and hand
back correct content (or a clean gate) for app-shell routes like `/n`. The room
WebSocket credentials stay explicit/ticketed and output frames stay on the
isolated origin, per the existing host-shell boundaries - only the app-owned
shell HTML moves server-side.

Server-rendering (or server-bootstrapping) the app shell would dissolve the
present-vs-valid gap for those routes in one move: the server gates on a validated
session, so there is no client window that paints ahead of validity. Instant paint
would remain the mechanism for the live notebook room (which is inherently a
client handshake), but the dashboard and other app-owned surfaces would not need
to guess.

## Open questions

- Scope: which routes are app-owned enough to server-bootstrap (`/n`, sharing,
  home) versus inherently client-handshake (the live room)?
- Interim: is a client-side validity gate on the early paint (probe app-session
  freshness before trusting `hasAppSession`) worth doing before any SSR work, or
  does it add a request on the hot path for a case the handshake already backstops?
- Cost: server bootstrap needs the Worker to render or hydrate the shell with
  session-validated data; how much of the current client bootstrap
  (`loadCloudNotebookListBootstrap`) already models this and could move server-side?

Not a decision. A pointer at where the real production correctness lever is, and
why the app-session cookie changed what is reachable.
