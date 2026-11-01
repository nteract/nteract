# Pages deployment

The current release is qualified for the isolated **Page10** celld target only.
Page9 and earlier services are frozen. Deployment helpers reject mutations to
those targets and check their fingerprints when publishing Page10. Historical
profiles remain in [profiles.mjs](scripts/deployment/profiles.mjs) for inspection
and isolation checks; their presence is not permission to deploy to them.

Page targets are short-lived prototypes. A release that would break existing
clients goes to a new target instead of carrying compatibility code; data is
not copied between targets. Page10 is one of those: a fresh, empty target for
the location and comments redesign, with no compatibility with Page9's data.

## Page10 release

The allowlisted profile owns `page10.runtimed.run`, service `nteract-page10`,
listeners `127.0.0.1:9480` / `127.0.0.1:19480`, and the `standalone/page10`
prefix in the lab1 fleet bucket. It carries every Page9 flag: Wordgard editor,
buffered persistence, lossless cleanup with `CELLD_DURABILITY=bucket`, sharing,
OAuth, the catalog index, and the hashed-asset, Project-link and index routes.
It uses production Anaconda verification.

From `pages`, after review, commit, and a fresh build:

```sh
node scripts/deploy.mjs --target page10 plan
node scripts/deploy.mjs --target page10 prepare
node scripts/deploy.mjs --target page10 upload LOCAL_STAGE
node scripts/deploy.mjs --target page10 install REMOTE_STAGE --apply
node scripts/deploy.mjs --target page10 provision            # inspect
node scripts/deploy.mjs --target page10 provision --apply    # first publication only
node scripts/deploy.mjs --target page10 publish REMOTE_STAGE --apply
```

`provision` creates the target's tunnel and DNS record; see
[Tunnel and DNS provisioning](#tunnel-and-dns-provisioning). A later release
skips it, or runs it without `--apply` to confirm both are still in place.

`plan` is read-only. Use the stage paths returned by the helpers. Preparation
requires clean committed source and a matching build fingerprint. Only explicitly
allowlisted artifacts are staged; credentials, local databases, and development
state are excluded. Target-bound manifests and a deployment lock prevent stages
or simultaneous operator commands from crossing service boundaries.

Each target owns its `/opt`, `/etc`, and `/var/lib` directories, session secret,
service account, firewall table/mark, and release stage. Page10's firewall mark
is `0x00200000`, the next bit below Page9's `0x00400000`. The installer checks
ownership and resource conflicts, preserves Durable Object bindings/migrations
and persistent data, and restarts only the selected QA service. Installation and
publication require lab1 SSH and sudo.

Each installation copies `firewall.mjs` and `profiles.mjs` into its own
`/opt/<service>`, and its unit's `ExecStartPre` runs that copy. A frozen service
keeps the copy that qualified it, so Page9 keeps restarting after this release
moves qualification to Page10.

The runtime must match the official celld 0.6.3 Linux x86_64 executable at
`/usr/local/bin/celld-v0.6.3`, including the SHA-256 in `CELLD_RELEASE`. Services
run private copies; deployment does not replace the shared executable. The
installer refuses a downgrade from a newer runtime or replacement of a custom
build carrying the same version. Session secrets are generated on the host.

After publication, verify the exact release/build hashes (`/health` reports
`build` equal to the manifest's `build_receipt.build_id`), anonymous denial,
real OIDC, MCP/API-key operations, live peers, durable receipts, and frozen-service
fingerprints. Check reconnect and restart recovery with disposable QA Pages.
A process restart is not proof of power-loss or object-store failover recovery.
Existing documents, sessions, ACLs, and assets must be preserved.

Open tabs from an earlier build show a reload banner after publication and keep
working until the person reloads. A release that raises `MIN_VIEWER_PROTOCOL`
pauses editing in tabs that read the floor until they reload; it does not stop
older viewers or API clients (see the Build updates policy in the README). A
rollback publishes a different build id too, so open tabs see the banner again.

Rollback must retain binary record readers and the `PageRecords` binding and
buffered-storage implementation. A legacy hex-only build cannot read updated
records, and an older synchronous-only build cannot read buffered Pages.
Causal record ordering changes only the order and grouping of writes; keys and
frames are unchanged, so earlier builds read the result. A rollback build still waits
forever on stored history whose parent never became durable; startup recovery
from that shape needs this build or later.

The Page8, Page9 and Page10 profiles set `PAGES_CATALOG_INDEX=1`. Changing this epoch label starts
account reconciliation on the next listing. Reconciliation may take several
listings. Unsetting the variable turns the index off, and listings read Catalog
entries directly.

The D1 catalog index (`PAGES_CATALOG_INDEX`) is additive: Catalog entries keep
their keys and shape, and older builds ignore the `pages_catalog_*` tables. After
a rollback, accounts repair their index within six hours of their next listing, or
immediately when the `PAGES_CATALOG_INDEX` value changes. Index migrations run
lazily on first use and must stay additive so a rollback build keeps working
against the newer schema. Listing cursors are sealed with a key derived from the
session secret and expire after 24 hours; rotating that secret invalidates
outstanding cursors. Migration 2 adds per-principal title snapshots and clears the
reconcile markers, so each account rebuilds its rows on its next listings. Migration 3
adds `lifecycle_revision` to Page rows; older builds ignore it. Lifecycle state
changes, retirements and access writes apply only from a revision at least as
new as the row's, so a delayed trash retirement cannot undo a restore.

Trashed Pages keep `deleted: true` in the Page record, so a build without Trash
returns `404` to every caller, including the owner, and never loads or serves
the document. Its listing ignores `trash/` catalog entries, and its Catalog
rejects replays of Trash receipts as idempotency conflicts. Its delete path sees
a deletion record with a different fingerprint: a retried trash request
conflicts, and an owner delete with a fresh key deletes the Page permanently.
That older delete removes the document and writes the owner's `host/deleted`
tombstone, but leaves the Page record and the `trash/` entry unchanged. After
rolling forward, the Trash listing drops entries with a tombstone and the
Catalog refuses every lifecycle request for that Page with `404` before
forwarding, including resumed ones. It also tells the Page about the tombstone
on a host-only route, and the Page records the deletion and answers like a
missing Page from then on. Until the Catalog has done so, a direct open finds no
document, answers `503`, and tries again on the next request. The Page never
calls its owner's Catalog. Copying
a document or its assets between targets is separate from deployment; publishing
does not migrate another environment's data.

Projects add a Durable Object class (`Space`, binding `PROJECTS`, migration
tag `v3`), `space/<id>` Catalog entries, location fields on owned Catalog
entries (Page records carry none), and catalog-index migration 4 (placement
columns on `pages_catalog_pages`, which nothing writes or reads now, and a
`pages_catalog_spaces` table). Storage additions are additive. A build from before Spaces ignores the
new fields, keys and tables: the owner lists and opens every Page in a Project
as an ordinary Page, collaborators keep their direct grants, and Project
records wait for a roll forward. Such a build does not refuse to trash a Page
with sub-pages and does not protect home Pages. After rolling forward, a Page
whose parent is in Trash shows at the top level of the Project view, a resumed
creation under such a parent answers `parent_unavailable`, and a trashed home
Page can be restored normally. At
startup a build without the `Space` class logs `celld runtime start failed for
Space:<id>: no Worker exports Durable Object class Space` once per Project cell
celld resumes, then serves normally. On Cloudflare, removing a Durable Object
class takes a `deleted_classes` migration that erases its storage, so a
Cloudflare rollback must keep exporting `Space` and its binding instead.

### Projects and their storage identity

Projects were called Spaces through 3548b9750, which Page8 runs. Callers now see
Projects: tool names, `project_id`, error codes, routes and viewer labels.
Storage keeps every Space name exactly as 3548b9750 writes it:

- the `Space` Durable Object class, now behind the `PROJECTS` binding;
- `space/record` with `space_id` inside each Project's object;
- `space/<id>` Catalog entries with `space_id`;
- `space_id` on owned Catalog entries (Page records carry no location);
- journal intents (`spaceId`, `space_recorded`), receipts and fingerprints
  (`create_space`, `update_space`);
- the D1 `pages_catalog_spaces` table, the `space_id` column and the
  `host/index/spaces-*` markers. There is no migration 5.

`worker/project-api.mjs` is the only place the names meet. The gateway maps each
call's tool name and `project_id` to the stored names, and each result's
`space_id`, `space`, `spaces` and `kind: "space"` back. Messages and error
codes aren't stored, so they say Project at the source.

Two reasons. A rollback build must read the same records, and every key or
table move is a window where one build writes where the other doesn't look.
And celld already ties storage identity to the class name, so the class can't
be renamed anyway. A probe on celld 0.6.3 with one persistent data directory
and a Durable Object that stores one value showed:

- A Wrangler `renamed_classes` migration (`Space` to `Project`) does not deploy:
  ``celld deploy` does not support these migration keys: renamed_classes. Class
  rename, delete, transfer, and non-SQLite migration semantics need an explicit
  persisted-state contract before deployment.`` The old build then started again
  with its value intact.
- A new `Project` class beside `Space` (`new_sqlite_classes` in `v4`) starts
  empty. celld keys Durable Object storage by `Class:ID`.
- Renaming only the binding (`SPACES` to `PROJECTS`, `class_name: "Space"`)
  reads the existing value back.

New Projects get `prj_` IDs; `sp_` IDs stay valid. IDs aren't key names, so a
`prj_` Project is stored under `space/prj_<uuid>` like any other.

Because stored intents are unchanged, work 3548b9750 left pending resumes here.
A `create_space` interrupted before its home Page finishes when retried as
`create_project` with the same key and payload: the fingerprint still uses the
stored operation name. A `create_page` interrupted before its Page finishes
when retried with `project_id`, the same key and the arguments in the same
order: its pending Catalog entry holds the location. Fingerprints have always covered argument order.
Both cases are tested by writing the intent through the Catalog exactly as the
3548b9750 gateway does, then retrying through the Project API. So Page8 needs no
cleanup of pending intents before this build deploys.

Clients with a cached tool list or bundle are refused before anything runs, so
no idempotency key is consumed. The old tool names answer
`` `create_space` was renamed `create_project` `` (code `tool_renamed`, and the
same for the other three). A `space_id` argument answers
`` `space_id` is now `project_id` `` (`argument_renamed`).

Rolling back to 3548b9750 serves every Space and every Page, including updates
this build made. That build can't address `prj_` IDs: `get_space` on one answers
`Invalid space_id`, and its `list_spaces` skips them. It refuses a child under a
Page in a `prj_` Project rather than file it elsewhere. Its
restore-to-top-level path rejects a `prj_` placement, because its
`validatePlacement` accepts only `sp_` IDs, so a Page never drops out of its
Project. Rolling forward serves everything again.

### Rollback qualification for Projects

`scripts/rollback-qualification.mjs` runs four phases on local celld 0.6.3 with
one persistent data directory: the previous build, this build, the previous
build, this build. Build the previous commit in a separate checkout first. A
`git archive` of the experiment and the sources it imports (`src`,
`apps/notebook-cloud/src`, `packages/local-oidc`, `packages/runtimed/src`, the
root `package.json` and `pnpm-lock.yaml`), committed into a scratch repository
so the build receipt can read it, works. Then:

```sh
CELLD_BIN=<celld 0.6.3> node scripts/rollback-qualification.mjs --previous <previous pages dir>
```

Against 3548b9750 (build `9ae4ed83e44e`), with the catalog index on:

1. The previous build created a Space with a Page and listed both, so D1 held
   Space rows.
2. This build listed that Space as a Project with its `sp_` ID and both Pages,
   and updated its title (revision 1). It created a `prj_` Project, a top-level
   Page and two Pages nested under it.
3. The previous build read the Space with this build's title at revision 1,
   updated it again (revision 2) and listed it. It listed, read and edited the
   nested Page and trashed the other one. `get_space` on the `prj_` ID answered
   `Invalid space_id`, and a child under the `prj_` Project's top-level Page was
   refused. It created a second Space with two nested Pages.
4. This build listed all three Projects. The first showed the previous build's
   title at revision 2 and took another update (revision 3). The second Space
   answered `get_project` with `org: null`, listed its three Pages, and showed
   breadcrumbs Project › parent. A new Page landed in it by `project_id`. The
   `prj_` Project kept its Pages, the edit and its breadcrumbs, and the refused
   child existed nowhere. The trashed child restored under its parent, and
   trashing either parent was refused with `page_has_children`.

celld logged no errors (only its usual allocator and `fleet_sample_failed`
lines), and nothing crashed.

### Creation intent conflicts

A Page writes `host/creation` before it imports a new document and deletes it
once the new record is durable. Earlier builds installed that intent's metadata
again whenever it was still present, at boot or on a create or register replay.
If a creation's flush failed and the Page changed afterwards (an ACL grant,
Trash, a restore), that reinstall dropped the change and reset
`lifecycleRevision` to 0. This build always keeps the installed record.

At boot, a Page that holds both an intent and an installed record that disagree
logs one line:

```json
{"service":"nteract-pages-native","event":"page.creation_intent_conflict","page_id":"…","fields":["lifecycleRevision","acl"],"timestamp":"…"}
```

`fields` names which of `lifecycleRevision`, `acl`, `deleted`, `trash`,
`purged`, `deletion` and `placement` differ, never their values. Such a Page was
at risk, not damaged: this build keeps its installed record. An active Page then
finishes the creation and drops the intent; a trashed or deleted Page keeps the
intent and logs again on each cold start. After a deploy, search the target's logs
for `page.creation_intent_conflict` to see whether any Page is affected.

A Page that an earlier build already reinstalled has no intent left, because the
reinstall deleted it, so it never logs this line. Its record shows a
`lifecycleRevision` below the highest `revision` in its `host/lifecycle/*`
receipts, or below the owner Catalog entry's `lifecycle_revision`, or it is
active while the owner's Catalog lists it in Trash.

There is no repair tool. To repair a Page:

1. Copy the Page's Durable Object storage before changing anything.
2. Restore the record from the newest backup taken before the reinstall. If
   there is none, rebuild the lifecycle fields by hand. Set `lifecycleRevision`
   to the larger of the highest receipt revision and the Catalog's
   `lifecycle_revision`. Then set `deleted`, `trash` and `deletion` to match the
   newest receipt.
3. Never infer an ACL from the creation intent, the Catalog's shared entries or
   the receipts. Restore it from a backup, or ask the owner to grant access
   again.

### Preserved Markdown conversion

Older builds stored Markdown they couldn't import as one read-only preserved
block. The Page host converts each one when it loads, creates, registers or
restores a Page (README, "Preserved blocks"). While it converts, the Page is
read-only: native connections get `temporarily_unavailable` and back off, and
HTTP edits get `503 preserved_markdown_converting`.

The conversion journals in its own key space (`host/operation/internal:`),
outside the client receipt budgets, so a full legacy receipt store can't
block it. A run that fails for a reason that passes (storage, a pending edit)
retries with backoff, 5 seconds doubling to 5 minutes, and on every refused
connection or edit. A run that applied but couldn't finish replays under the
same key until its journal entry is terminal, whatever the failure: the
fallback below waits until no reservation remains. After five permanent
failures of a reserved run, the host abandons it (its journal entry is marked
`abandoned` and recovery never replays it, and the reservation is released),
then falls back.

A run that fails for a reason that won't pass (the change is too large, the
conversion throws, or a request-shaped refusal) retries once converting each
source as plain text. If that fails too, the host logs one line:

```json
{"service":"nteract-pages-native","event":"page.preserved_markdown_stuck","page_id":"…","reason":"history_capacity","timestamp":"…"}
```

`reason` is a bounded code (`history_capacity`, `conversion_error`, an error
code, or `status_<n>`); the line carries no content. After a deploy, search the
target's logs for `page.preserved_markdown_stuck`. A stuck Page is not fenced: it edits
normally, and its preserved blocks stay read-only with a notice. The next
load tries again. To recover a Page now, as its owner or with an agent:

1. `read_page` the Page. A preserved block reads as the Markdown it would
   convert to.
2. `edit_page` with `replace_block_markdown` on that block, passing the
   Markdown from step 1. If it's refused with `unsupported_markdown` or for
   size, simplify or split the Markdown and retry.

The replacement removes the preserved block, so nothing is left to convert.

## Page quotas

Each account may hold a limited number of active Pages and, separately, the
same number in Trash. The profile's `pageQuota` sets the target's default, which
the installer writes as `PAGES_DEFAULT_PAGE_QUOTA`; Page10's is 250. Without the
variable the Worker uses 250. Changing the default needs a new install.

Rules in D1 override the default for one account or one email domain:

```sql
CREATE TABLE pages_quota_rules (
  match_kind TEXT NOT NULL CHECK (match_kind IN ('email', 'domain')),
  match_value TEXT NOT NULL,
  page_limit INTEGER NOT NULL CHECK (page_limit >= 0),
  note TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (match_kind, match_value)
);
```

| Precedence | Rule | Example |
| --- | --- | --- |
| 1 | `email` equal to the account's server-verified email | `('email', 'rgbkrk@gmail.com', 1000)` |
| 2 | `domain` equal to that email's domain, lowercased | `('domain', 'anaconda.com', 500)` |
| 3 | the target default | `PAGES_DEFAULT_PAGE_QUOTA` |

A rule replaces the default: it can be lower. `0` pauses the account: it can't
create, restore or add sub-pages or Projects, but it can still move Pages to
Trash, and its Pages stay readable. Store emails lowercased and
trimmed, and domains lowercased with no `@`; the resolver normalizes them the
same way, and a value that can't match is ignored. An account with no verified
email always gets the default. The Worker creates the table on first use (its
own `pages_quota_schema` version table) and reads it once per isolate every five
minutes, so a change takes up to five minutes to apply. If D1 fails, accounts get
the default and the Worker logs a `page-quota` failure. A failed read is retried
after 30 seconds; a schema setup that hangs is abandoned after 30 seconds, so a
recovered D1 applies the rules again without a restart.

With no rules, every account gets the default.

### Changing quota rules

`scripts/quota-rules.mjs` lists, sets and deletes rules from an operator
machine. It builds the SQL locally and sends it over SSH stdin to one fixed
command on the target's host. That command runs `celld d1 execute`, which goes
through the live owner of `pages-next-auth`, under its fence and in one
transaction. The host, service, binary, bucket and database come from the
target's deployment profile.

```bash
node scripts/quota-rules.mjs check                     # tables, schema version, rule count
node scripts/quota-rules.mjs list
node scripts/quota-rules.mjs get    email rgbkrk@gmail.com
node scripts/quota-rules.mjs set    email rgbkrk@gmail.com 1000 --note "design partner"
node scripts/quota-rules.mjs set    domain anaconda.com 500
node scripts/quota-rules.mjs set    email someone@example.com 0
node scripts/quota-rules.mjs delete domain anaconda.com
```

| Option | Meaning |
| --- | --- |
| `--target NAME` | Deployment profile, `page10` by default. Only a profile with `pageQuota` and `d1` is accepted. |
| `--ssh-host HOST` | SSH destination, the profile's host (`lab1`) by default, for example `root@lab1`. |
| `--dry-run` | Print the remote script and every SQL step, and write nothing. `delete` runs its read-only preflight to show the stored rows it would remove; every other command sends nothing. |
| `--create-only` | `set` only: refuse when the rule already exists. |
| `--note TEXT` | `set` only: a note of at most 200 characters. |

Run it with Node 22.18 or later, which loads `sharing.ts` without a build step.
The SSH user must be root or able to `sudo -n -u nteract-page10`: the service's
loopback firewall resets connections from any other uid.

- **Values.** The script never accepts SQL. The kind is `email` or `domain`.
  Values are normalized as the Worker normalizes them
  (`worker/quota-rule-match.mjs`, shared by both), and a value no account could
  match is refused. The limit is a whole number from 0 to 10,000. Values and
  notes reach the SQL only as `CAST(X'<hex>' AS TEXT)`.
- **Limit 0** pauses Page creation for the match: the account can't create or
  restore Pages, or add sub-pages or Projects. It keeps its Pages, can read
  them, and can still move them to Trash.
- **`set` writes the whole rule.** Leaving out `--note` clears the note. The
  script reads the row back in the same transaction and prints it. It refuses a
  new rule when the table already holds 1,000, because past that the Worker
  ignores every rule.
- **Stored spellings.** The Worker normalizes stored values again, so a row
  written by hand as `Example.COM` still matches `example.com`. `get` and `list`
  print stored values quoted, and flag a row that isn't canonical or that a
  newer row for the same match shadows. `delete` removes every stored row the
  Worker reads as the named rule, however it is spelled. `set` writes the
  canonical form; an older spelling stays stored but no longer applies.
- **Guards.** Before it reads any SQL, the remote command checks that the binary
  is celld 0.6.3 and that the cell `__D1Database:c131e246…` is already in the
  target's bucket. celld creates an empty database for a `database_id` it
  hasn't seen, so a wrong id would otherwise write somewhere no Worker reads.
  Before every write, `set` and `delete` run the `check` query: both
  `pages_quota_rules` and `pages_quota_schema` must exist, at schema version 1.
  The script never creates a table. The Worker's migration owns both, so after
  deploying a quota build, call `list_pages` once before the first rule.
- **Five-minute cache.** Each Worker isolate reads the rule table at most once
  every five minutes. A change can take that long to apply, and different
  isolates can disagree until then. Poll `list_pages` for `quota.limit` rather
  than expecting it at once.

Never run `celld d1 execute` by hand against `pages-next-auth`. It also holds
the auth and OIDC tables, and celld reports some errors misleadingly.

#### After a failed write

An error doesn't prove that nothing was written. In qualification, a write
that returned an error during an owner restart had committed. After any failed
`set` or `delete`, the script reads the rule back once and never re-sends on
its own.

- **Requested state observed.** The read-back shows exactly the change asked
  for: for `set`, the row carrying this run's `updated_at`; for `delete`, no
  stored row for the rule. The script says the write landed and exits 0.
- **Requested state not observed.** The script prints the current state and
  exits 1. That state doesn't show the write failed. The write may have
  committed, lost its response, and been replaced by a newer change before the
  read-back; running it again would overwrite that change. Reconcile first:
  find out who else changed the rule, and decide from the current state.
- **Read-back failed.** The state is unknown. Run `get` and reconcile before
  running anything again.

A `delete` also reports "requested state not observed" without any error when
a row changed between its preflight read and its write. Each row is deleted
only if its `updated_at` still matches the preflight, so the changed row
survives and is shown.

A listing that finds a Catalog's stored Page counts wrong rewrites them and logs
one line without the account:

```json
{"service":"nteract-pages-native","event":"catalog.count_repaired","active":3,"trash":0,"timestamp":"…"}
```

Expect it after a rollback build has written Catalog entries. Without a rollback,
it points at a write path that skips the counts.

## Tunnel and DNS provisioning

This is first-publication setup for a new target, not a step to repeat for each
release. `deploy.mjs provision` runs between `install` and `publish`. It calls
the tunnel helper, then the DNS helper with the tunnel UUID the first step
reports. It inspects by default; `--apply` creates only what is absent and never
adopts, updates or deletes. Both steps are idempotent, so a rerun after a
partial failure picks up where the last one stopped.

```sh
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target page10 provision
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target page10 provision --apply
```

Inspection prints the tunnel and DNS state. Before the tunnel exists there is no
UUID to check DNS against, so `dns` is `null`. With `--apply` it prints the new
tunnel UUID and CNAME, never the tunnel secret or the token. The two helpers it
calls still run on their own:

```sh
node scripts/deployment/tunnel.mjs --target page10 [--apply]
node scripts/deployment/dns.mjs --target page10 TUNNEL_UUID [--apply]
```

`provision` reads `CLOUDFLARE_API_TOKEN` from the environment only and never
writes it. It is an account token for `1cfb529b94b3d6cde3aaf49d1d6ed5e6` with
Cloudflare Tunnel edit and DNS edit on `runtimed.run`. Set it for the one command;
never write it to a file. An operator can read it from a password manager. A
1Password service account lets provisioning run without a person at the
keyboard: with `OP_SERVICE_ACCOUNT_TOKEN` set in the runner's environment,
`op read` fetches the token for the one command. The runner still needs lab1
SSH and sudo, because the tunnel step writes its files on the host.

```sh
CLOUDFLARE_API_TOKEN="$(op read 'op://<vault>/<item>/<field>')" \
  node scripts/deploy.mjs --target page10 provision --apply
```

The tunnel step creates a locally managed tunnel named after the service
(`nteract-page10`). Cloudflare returns a tunnel secret only when it is set, so the
same run writes it over SSH to root-owned mode 0600 `/etc/nteract-page10/tunnel.json`
and writes the nonsecret receipt `/etc/nteract-page10/tunnel-provisioning.json`.
Both writes require the directory that installation created and refuse to
replace an existing file. The command prints the tunnel UUID, never the secret.
A tunnel that exists without credentials on the host must be deleted in
Cloudflare before retrying. The receipt has this form:

```json
{
  "schema": 1,
  "account_id": "1cfb529b94b3d6cde3aaf49d1d6ed5e6",
  "tunnel_id": "TUNNEL_UUID",
  "name": "nteract-page10",
  "config_src": "local"
}
```

Publication rejects reused tunnel IDs, absent credentials, and conflicting
configuration. It installs only the target's connector and verifies frozen
service/connector configuration and PIDs. Do not use `cloudflared service
install`, which targets the shared connector.

The DNS step creates only an absent owned CNAME; conflicts are rejected.
Public ingress allows application, auth, sharing, MCP, asset, and sync routes,
then ends in a catch-all 404. Internal Durable Object routes stay private.
Page10 serves Page9's route set on its own hostname and listener. It has no
predecessor config, so the publisher installs its tunnel configuration fresh and
refuses any other installation receipt, including Page9's earlier ones. The
route migrations below are Page9's history; Page10 starts at the end of them.

Both admit the viewer's content-hashed chunks, `/chunks/` followed by
eight base32 characters and `.js`. `build-receipt.json` maps each chunk to the
sha256 of its bytes in `viewer_chunks`. `prepare` stages exactly those chunks,
checks each one's bytes against its digest first, and refuses a changed chunk or
a `public/chunks` directory that holds any other file.

The shell's own files are hashed the same way: `app-<hash>.js`,
`app-<hash>.css`, `theme-<hash>.js`, `mermaid-<hash>.js`,
`automerge-<hash>.wasm` and `subduction-<hash>.wasm`. Both admit each name
with its own extension only. `viewer_assets` in the receipt maps each to its
sha256, and the name's hash must be the first 40 bits of that digest.
`prepare` stages exactly those six files, checks their bytes first, and refuses
any other file of that shape in `public`.

Both admit Project links: `/project/<id>` and the older `/s/<id>`, where the
ID is `prj_` or `sp_` followed by a lowercase v4 UUID, with an optional
trailing slash. These are the paths `shared/routes.mjs` opens as a Project;
the viewer rewrites `/s/<id>` to `/project/<id>`. Page9's publisher migrates only
from its hashed-asset config to this one, so an older installation must
publish the hashed-asset release first.

Both admit the viewer's index routes, `/projects` and `/pages`, as exact
paths with an optional trailing slash. `/pages` keeps its search in `?q=`;
ingress matches the path only. These are the paths `shared/routes.mjs` opens
as index routes. Page9's publisher migrates only from its Project-link config
to this one, so an older installation must publish the Project-link release
first.

The OIDC client must allow `https://<hostname>/oidc` as a redirect URI before
sign-in works on a new target. For Page10, add
`https://page10.runtimed.run/oidc` to client
`1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0`. That change is made in the identity
provider; no helper here does it.

## Telemetry

Service units enable `CELLD_OTEL=1` and `CELLD_OTEL_RETENTION=30d` with celld's
five-minute/5 MiB batching defaults. Page8 through Page10 also set
`OTEL_TRACES_SAMPLER=always_on`. Requests reach it with a `traceparent` whose
sampled flag is clear. For a request with an unsampled parent, celld's default
`parentbased_always_on` sampler records nothing, including the Worker's
`console` lines.

Spans record outbound fetch URLs in full. `import_page_image` fetches the
caller's download URL, which can carry a short-lived signature in its query.
Telemetry lives under the fleet bucket's `telemetry/` prefix, so it has the same
readers as the Page documents and storage beside it. Restrict bucket read access
accordingly; retention is 30 days. Verify actual Parquet delivery under
`<fleet-prefix>/telemetry/{traces,logs}`; configuration alone is not evidence of
delivery. Retention collects dated partitions, not an exact rolling-hour cutoff.
See the [pinned runtime telemetry contract](https://github.com/denoland/celld/blob/8702f6d186c77698dbfb30cf29e3b1922a88f008/docs/telemetry.md).

## Cloudflare packaging fixture

[cloudflare-stage.mjs](scripts/cloudflare-stage.mjs) remains a tested packaging
path, **not a currently qualified deployment of this release**. It produces Worker
WASM/assets, SQLite Durable Object bindings, D1 auth configuration, and a private
`nteract-pages-images` R2 binding. Its fixed configuration targets
`preview.runt.run` / `nteract-pages-next` with Anaconda staging authentication;
production API keys are not interchangeable.

From `experiment`, clean committed source and a matching Pages build can be
inspected without publishing:

```sh
node pages/scripts/cloudflare-stage.mjs /tmp/pages-cloudflare-release D1_DATABASE_UUID
node_modules/.bin/wrangler deploy --config /tmp/pages-cloudflare-release/wrangler.json --dry-run
```

Use a new destination directory and the intended D1 database UUID. The helper
neither provisions resources nor attaches a domain. Live use needs explicit
resource, auth, persistence, memory, and recovery qualification, plus configuration
of the current editor/persistence profile; this staging configuration does not
select Page10's flags. Do not repoint the existing preview domain as part of a
Page10 release.

## Copying a Project to a new target

Deployment never copies data. When a new target needs a Project from an older
one, [project-transfer.mjs](scripts/project-transfer.mjs) copies it through the
public `/mcp` endpoint of each target, from outside the Worker. It copies each
Page's title and Markdown body, the Page tree and sibling order. It does not
copy comments, sharing, Trash, history or private image bytes.

### Credentials

Each step reads a bearer token from the environment and sends it only in the
`Authorization` header. Nothing prints it.

| Step | Variable | Needs |
| --- | --- | --- |
| export | `PAGES_SOURCE_TOKEN` or `PAGES_SOURCE_TOKEN_FILE` | read access to the source Project (`cloud:read`) |
| import | `PAGES_TARGET_TOKEN` or `PAGES_TARGET_TOKEN_FILE` | write access on the target (`cloud:read` + `cloud:write`) |

Use an Anaconda API key from the provider environment the target verifies
against (production for Page9 and later). Create it at
https://anaconda.com/app/profile/api-keys, linked from each target's `/connect`
page: User Resources read-only for export, read and write for import, Platform
Channels no access. Save it with the `/connect` instructions, which write
`~/.config/pages/anaconda-api-key`, and point `*_FILE` at that file so the key
stays out of shell history. A Pages OAuth access token (`pages_…`) also works on
`/mcp`, but it expires after ten minutes and the script does not refresh it, so
use an API key for anything that runs unattended. Only the source Project's owner can
list it. The target Project belongs to the account that imports it.

### Export

```sh
PAGES_SOURCE_TOKEN_FILE=~/.config/pages/anaconda-api-key \
  node scripts/project-transfer.mjs export \
  --source https://page9.runtimed.run \
  --project prj_797f9475-6855-4ce5-8203-9f66cfc417c1 \
  --out guide.bundle.json
```

The bundle is JSON for review before import:

```json
{
  "format": "nteract-pages-project-bundle",
  "version": 1,
  "bundle_id": "<uuid>",
  "source": { "origin": "https://page9.runtimed.run", "project_id": "prj_…", "home_page_id": "…" },
  "exported_at": "2026-11-01T00:00:00.000Z",
  "project": { "title": "…", "description": "…" },
  "pages": [
    {
      "source_page_id": "…",
      "parent_source_id": null,
      "position": "a0",
      "home": true,
      "title": "…",
      "markdown": "…",
      "blocks": ["…", "…"],
      "preserved_markdown": false,
      "private_images": [],
      "comment_threads": 0
    }
  ]
}
```

`pages` is in tree order: the home Page first, then each subtree depth first,
siblings by source position, so parents always come before children.
`markdown` is the body: the Page's blocks joined by a blank line. `blocks`
appears only when a Page has more than one block. Each block is written
separately. A Page10 target refuses math and HTML with `unsupported_markdown`,
so import writes such a block as the literal text it reads as, the same text
the target's own conversion of a preserved block produces. If you edit a Page's
`markdown`, edit `blocks` to match or delete it; import refuses a mismatch.

The report lists Pages with `preserved_markdown` (the source stored preserved
blocks or non-Markdown blocks; check that they read as intended),
Pages with `private_images` (their
`/api/pages/<id>/assets/<sha256>` references point at the source Page's assets
and will not load on the target), comment threads that stay behind, and links to
source Pages outside the Project.

### Import

```sh
node scripts/project-transfer.mjs import --bundle guide.bundle.json --dry-run
PAGES_TARGET_TOKEN_FILE=~/.config/pages/anaconda-api-key \
  node scripts/project-transfer.mjs import \
  --target https://page10.runtimed.run \
  --bundle guide.bundle.json
```

`--dry-run` checks the bundle and prints where each Page lands without a
network call. Import compares normalized origins and refuses the bundle's own
source, however it is spelled (case, trailing slash, explicit default port). It
runs in this order:

1. `create_project` with the bundle's title and description. Its home Page is
   the source home Page's counterpart: import fills it in and never creates a
   sibling for it.
2. `create_page` for every other Page in bundle order, by `parent_id`. A Page at
   the source Project's top level goes under the target home Page, because a
   Project is its home Page on Page10 and later. `targetPlacement` is the only
   function that decides this. New Pages append after their siblings, so bundle
   order is sibling order.
3. After every Page exists, one guarded `edit_page` per Page that needs it: the
   home Page's title and body, the remaining blocks of a multi-block Page, and
   internal links. Source links `/p/<id>`, `/?page=<id>`, `/project/<id>` and
   `/s/<id>`, and root-relative `](/p/<id>` destinations, point at the new IDs.
   Links are read as whole tokens: a Markdown link destination `](...)`, read
   as CommonMark does (balanced parentheses, backslash escapes, or `<...>`), an
   autolink `<...>`, or a bare URL running to whitespace. A token is rewritten
   only when the whole token is a source URL, so a longer ID or a source URL
   nested inside another URL is left alone. A path, query or fragment after
   the ID is kept, and sentence punctuation after a bare URL stays outside it.
   A root-relative `/p/<id>` counts only as a link destination. Links to Pages
   outside the bundle stay as they are and are reported.
4. A listing of the target Project checks that every Page is under its expected
   parent, in source order. Import exits 1 if not.

Every write uses the repository's retry contract. Creates use the catalog
`retry_token` from `list_pages` with a key of its `retry_key_prefix` plus a
nonce hashed from `(bundle_id, source_page_id)`. Edits use the `read_page`
token the same way. The state file (`<bundle>.state.json` by default, or
`--state`, mode 0600) records the source-to-target ID map, finished steps,
the catalog token, and the exact arguments of the request in flight before it
is sent. A failed or interrupted import resumes when you rerun the same command:
an uncertain request is resent with the identical token, key and payload, which
replays its receipt rather than creating a second Page. A finished import sends
no writes on rerun. Keep the state file until the import reports success. If it
is lost, a fresh import refuses a target that already has a Project with the
bundle's title; delete the partial Project or pass `--allow-existing-title`.
Retry tokens last seven days. A create still uncertain after that answers
`retry_expired`: it may have been applied, and nothing can replay it. The
importer records it as `reconciliation_required` in the state file (operation,
step, idempotency key, arguments, and `requested_at`, when the create was first
sent) and refuses every further write until it is resolved. A same-title Page
may be unrelated, so nothing is adopted automatically:

- `--reconcile` writes nothing. It lists candidates: unmapped Pages with the
  create's title under its parent, or Projects with its title, each with its
  ID, `created_at` and URL, oldest first. Open them before choosing.
- `--adopt ID` records one candidate and continues. It refuses an ID that is
  not under the recorded parent, has another title, already maps to a bundle
  Page, or was created before `requested_at`, allowing two minutes of clock
  skew (`ADOPT_CLOCK_SKEW_MS`).
- `--accept-missing` sends the create again with a new key. Use it when the
  target has no such Page.

An expired body edit needs none of these: the run rereads the Page and writes
its whole body again, which gives the same result whether or not the edit
applied.
