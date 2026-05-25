# Hosted Notebook Sharing And Invites

**Status:** Draft, 2026-05-24.

This note designs the product and data path from "share with email" to
principal-backed `notebook_acl` rows. The important rule is unchanged from the
identity docs: email is useful for lookup and display, but it is not the room
principal.

Related docs:

- `docs/architecture/identity-and-trust.md`
- `docs/architecture/hosted-room-authorization.md`
- `docs/architecture/hosted-credential-transport.md`
- `docs/architecture/hosted-access-anaconda-demo-runbook.md`

Prototype code:

- `apps/notebook-cloud/src/sharing.ts`
- `apps/notebook-cloud/src/sharing-storage.ts`
- `apps/notebook-cloud/test/sharing.test.ts`
- `apps/notebook-cloud/test/sharing-storage.test.ts`

## What The Older Prototype Already Proved

The older [`runtimed/intheloop`](https://github.com/runtimed/intheloop)
prototype has useful shape:

- `users` stores provider/user profile fields including email and names.
- `notebook_permissions` grants notebook access by internal `user_id`.
- `shareNotebook` grants a `writer` relation to an existing user.
- `userByEmail` lets the UI find an existing user before sharing.
- The Anaconda Projects permission provider grants `writer` by Anaconda
  `user_id`.
- Public user data intentionally omits email in collaborator responses.

That prototype did not need pending invites because sharing targeted an
existing user record. For nteract cloud, we need an owner to type an email
before the recipient has ever logged in, and we need the eventual ACL row to
use the recipient's stable provider principal instead of the typed email.

## Canonical Objects

### Principal Profile

`principal_profiles` is display and lookup metadata for authenticated
principals.

```sql
CREATE TABLE principal_profiles (
  principal TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_subject TEXT,
  email_normalized TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  avatar_url TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  raw_claims_json TEXT
);

CREATE INDEX principal_profiles_email_idx
  ON principal_profiles(provider, email_normalized)
  WHERE email_verified = 1;
```

`principal` is the key used in `notebook_acl.subject`, for example:

```text
user:cloudflare-access:<encoded-access-sub>
```

Email and display name are not authorization keys. They can change without
rewriting ACL rows.

### Pending Invite

`notebook_invites` stores email-addressed invitations that have not yet
resolved to a principal.

```sql
CREATE TABLE notebook_invites (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  provider_hint TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('viewer', 'editor')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_actor_label TEXT NOT NULL,
  accepted_by_principal TEXT,
  token_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  accepted_at TEXT,
  revoked_at TEXT,
  revoked_by_actor_label TEXT,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)
);

CREATE INDEX notebook_invites_pending_lookup_idx
  ON notebook_invites(provider_hint, email_normalized, status);

CREATE INDEX notebook_invites_notebook_idx
  ON notebook_invites(notebook_id, status);
```

`provider_hint` is normalized to lowercase provider ids. It should be
`cloudflare-access` for the Access + Anaconda demo. It may be `NULL` only when
the invite intentionally allows resolution by any trusted login provider that
proves the same verified email.

`scope` is limited to `viewer` and `editor` for invite UX. `owner` transfer and
`runtime_peer` grants need explicit owner/admin flows, not email invites.

The existing `notebook_acl` table remains the authorization source of truth:

```text
notebook_acl(notebook_id, subject_kind, subject, scope)
```

Pending invites are not ACL rows and cannot authorize a socket.

## Share Flow

1. Owner opens the share dialog for a notebook.
2. Owner enters `recipient@example.com` and chooses `Viewer` or `Editor`.
3. The API normalizes the email:

   ```text
   trim + lowercase
   ```

4. The API looks for a verified `principal_profiles` row with the same
   provider hint and normalized email.
5. If a matching profile exists, the API inserts the principal ACL row
   immediately:

   ```json
   {
     "subject_kind": "principal",
     "subject": "user:cloudflare-access:<encoded-access-sub>",
     "scope": "editor"
   }
   ```

6. If no matching profile exists, the API creates a `pending` invite row and
   sends or exposes an invite link.
7. The share dialog shows:
   - resolved collaborators by display name;
   - pending invites by email;
   - public viewer as a separate "Anyone with the link" row.

The API may create an accepted invite audit row even for immediate grants, but
the ACL subject is still the resolved principal.

## First Login Resolution

When a user authenticates:

1. Validate the provider credential.
2. Produce a stable principal, provider name, optional provider subject,
   verified email, and display name.
3. Upsert `principal_profiles`.
4. If the login has no verified email, do not resolve email invites.
5. Find pending invites whose:
   - `email_normalized` equals the login email;
   - `provider_hint` is either the login provider or `NULL`;
   - `status = 'pending'`;
   - `expires_at` is null or in the future.
6. In one transaction, for each matching invite:
   - insert the `notebook_acl` principal row for `login.principal`;
   - mark the invite `accepted`;
   - set `accepted_by_principal = login.principal`;
   - set `accepted_at`.

The invite resolution actor should be an explicit system actor:

```text
system/invite-resolution
```

The resulting ACL row should never contain the email:

```text
subject_kind = principal
subject      = user:cloudflare-access:<encoded-access-sub>
scope        = editor
```

This keeps authorization stable even if the user later changes email.

## Public Viewer Flow

Public viewing is not an email invite. It is an explicit room ACL row:

```json
{
  "subject_kind": "public",
  "subject": "anonymous",
  "scope": "viewer"
}
```

UX:

- Show a toggle labeled "Anyone with the link can view".
- Enabling the toggle inserts the public ACL row.
- Disabling the toggle deletes the public ACL row.
- Anonymous public viewers appear as aggregate/local viewer state, not as named
  collaborators.
- Anonymous public viewers cannot edit, upload blobs, mutate runtime state, or
  publish revisions.

Network topology still matters. A hostname fully protected by Cloudflare Access
will block anonymous public viewers before the Worker sees the request. Public
published notebooks need either a public hostname, an Access bypass policy for
public viewer routes, or a separate public deployment that still checks the
Worker ACL row.

## Display Names And Privacy

Collaborator list rendering should prefer:

1. `principal_profiles.display_name`
2. verified profile email
3. principal string

Pending invites render the normalized invited email because no principal exists
yet. That email should be visible to notebook owners and collaborators with ACL
management rights, but it should not leak to anonymous public viewers.

Public viewer displays as:

```text
Anyone with the link
```

The room presence layer should not promote anonymous public sessions to named
collaborators. If product later wants public cursor presence, define whether it
is aggregate-only or full per-session presence before enabling it.

## Revocation And Expiry

Revoking a resolved collaborator deletes or replaces the principal ACL row. It
does not delete `principal_profiles`.

Revoking a pending invite marks the invite `revoked`; it does not need an ACL
mutation because pending invites are not authorization rows.

Expired invites should either be marked by a scheduled cleanup job or treated as
expired at query time. Resolution must ignore expired rows.

Owner protection stays in the ACL helper. Neither invite acceptance nor revoke
flows may leave a notebook without an `owner` ACL row.

## API Sketch

Owner-only APIs:

```text
GET    /api/n/{notebookId}/shares
POST   /api/n/{notebookId}/shares
DELETE /api/n/{notebookId}/shares/{shareId}
POST   /api/n/{notebookId}/public-viewer
DELETE /api/n/{notebookId}/public-viewer
```

`POST /shares` request:

```json
{
  "email": "alice@example.com",
  "scope": "editor",
  "provider_hint": "cloudflare-access"
}
```

Possible responses:

Existing verified profile:

```json
{
  "kind": "principal",
  "principal": "user:cloudflare-access:access-sub",
  "display_name": "Alice Example",
  "scope": "editor"
}
```

New pending invite:

```json
{
  "kind": "pending_invite",
  "invite_id": "inv_...",
  "email": "alice@example.com",
  "scope": "editor",
  "status": "pending"
}
```

First-login resolution can happen inside the auth/session endpoint or the first
room/API request after authentication. It should be idempotent: rerunning it for
the same login must not create duplicate ACL rows.

## Implementation Notes

The checked-in TypeScript prototype models the core transition:

- `normalizeInviteEmail(email)` trims and lowercases invite lookup email.
- `inviteLookupKey(provider, email)` shows the provider-plus-email lookup key.
- `resolvePendingInvitesForLogin(...)` accepts only pending, non-expired invites
  matching a verified login email and provider.
- The generated `aclGrants` use `login.principal`, not email.
- `publicViewerAclGrant(...)` returns the explicit public ACL row.
- `shareTargetDisplay(...)` maps principal profiles, pending invites, and
  public viewer rows into UI labels.

The checked-in storage foundation now creates the `principal_profiles` and
`notebook_invites` D1 tables and exposes helpers that upsert profiles, create
pending invites, and resolve first-login invites into principal ACL rows. HTTP
routes should come after the Access demo proves principal shape and after we
choose the final share API names.

## Open Decisions

1. **Provider subject source.** For the first Access demo, the principal is
   Access-scoped. If Access can pass a stable Anaconda subject claim, decide the
   claim and migration before switching to `user:anaconda:*`.
2. **Invite delivery.** Email delivery, invite-token links, and resend behavior
   are product work. ACL resolution does not depend on delivery mechanism.
3. **Organization policy.** Some deployments may restrict invites to an
   Anaconda org, email domain, or Access group. That should be a share API
   validation rule, not a different ACL subject type.
4. **Owner transfer.** Owner transfer needs confirmation and orphan protection.
   It should not be hidden inside invite-by-email.
5. **Public hostname.** Decide whether public viewers use the same hostname
   with an Access bypass rule or a separate public viewer host.
