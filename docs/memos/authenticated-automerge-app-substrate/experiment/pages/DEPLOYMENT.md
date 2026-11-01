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
tag `v3`), `space/<id>` Catalog entries, a `placement` field on Page records and
matching fields on owned Catalog entries, and catalog-index migration 4
(placement columns on `pages_catalog_pages` and a `pages_catalog_spaces`
table). Storage additions are additive. A build from before Spaces ignores the
new fields, keys and tables: the owner lists and opens every Page in a Project
as an ordinary Page, collaborators keep their direct grants, and Project
records wait for a roll forward. Such a build does not refuse to trash a Page
with sub-pages and does not protect home Pages. After rolling forward, a Page
whose parent is in Trash shows at the top level of the Project view, a resumed
creation under such a parent answers `parent_unavailable`, and a trashed home
Page can be restored normally. Index rows an older build inserts have no
placement until the Page reports again or its owner's account reconciles;
changing `PAGES_CATALOG_INDEX` after rolling forward repairs them at once. At
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
- `space_id` in Page placement and owned Catalog entries;
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
stored operation name. A `create_page` whose intent holds placement
`{space_id}` finishes when retried with `project_id`, the same key and the
arguments in the same order. Fingerprints have always covered argument order.
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
