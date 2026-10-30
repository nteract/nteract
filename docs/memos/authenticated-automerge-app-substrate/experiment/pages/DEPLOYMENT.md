# Pages deployment

The current release is qualified for the isolated **Page8** celld target only.
Page7 and earlier services are frozen. Deployment helpers reject mutations to
those targets and check their fingerprints when publishing Page8. Historical
profiles remain in [profiles.mjs](scripts/deployment/profiles.mjs) for inspection
and isolation checks; their presence is not permission to deploy to them.

## Page8 release

The allowlisted profile owns `page8.runtimed.run`, service `nteract-page8`,
listeners `127.0.0.1:9478` / `127.0.0.1:19478`, and the `standalone/page8` prefix
in the lab1 fleet bucket. Its Wordgard editor, buffered persistence, and lossless
cleanup retain `CELLD_DURABILITY=bucket`. It uses production Anaconda verification.

From `pages`, after review, commit, and a fresh build:

```sh
node scripts/deploy.mjs --target page8 plan
node scripts/deploy.mjs --target page8 prepare
node scripts/deploy.mjs --target page8 upload LOCAL_STAGE
node scripts/deploy.mjs --target page8 install REMOTE_STAGE --apply
node scripts/deploy.mjs --target page8 publish REMOTE_STAGE --apply
```

`plan` is read-only. Use the stage paths returned by the helpers. Preparation
requires clean committed source and a matching build fingerprint. Only explicitly
allowlisted artifacts are staged; credentials, local databases, and development
state are excluded. Target-bound manifests and a deployment lock prevent stages
or simultaneous operator commands from crossing service boundaries.

Each target owns its `/opt`, `/etc`, and `/var/lib` directories, session secret,
service account, firewall table/mark, and release stage. Page8's firewall mark is
`0x00800000`. The installer checks ownership and resource conflicts, preserves
Durable Object bindings/migrations and persistent data, and restarts only the
selected QA service. Installation and publication require lab1 SSH and sudo.

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

The Page8 profile sets `PAGES_CATALOG_INDEX=1`. Changing this epoch label starts
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

Spaces add a `Space` Durable Object class (binding `SPACES`, migration tag
`v3`), `space/<id>` Catalog entries, a `placement` field on Page records and
matching fields on owned Catalog entries, and catalog-index migration 4 (placement
columns on `pages_catalog_pages` and a `pages_catalog_spaces` table). Storage
additions are additive; rollback deployment compatibility is qualified separately
(see below). A rollback build ignores the new fields, keys and tables: the owner
lists and opens every Page in a Space as an ordinary Page, collaborators keep
their direct grants, and Space records wait for a roll forward. An older build
does not refuse to trash a Page with sub-pages and does not protect home Pages.
After rolling forward, a Page whose parent is in Trash shows at the top level of
the Space view, a resumed creation under such a parent answers
`parent_unavailable`, and a trashed home Page can be restored normally. Index rows
an older build inserts have no placement until the Page reports again or its
owner's account reconciles; changing `PAGES_CATALOG_INDEX` after rolling forward
repairs them at once.

### Rollback qualification for Spaces

`scripts/rollback-qualification.mjs` runs this build, the previous build and this
build again on local celld with one persistent data directory. Build the previous
commit in a separate worktree first, then:

```sh
CELLD_BIN=<celld 0.6.3> node scripts/rollback-qualification.mjs --previous <previous pages dir>
```

Against the previous main build (9b8f36dbd) on celld 0.6.3, the Spaces build
created a Space, its home Page and a nested Page. The previous build, whose
config has no `SPACES` binding or `v3` migration, started on the same data,
listed all three Pages, read and edited the nested Page and created another.
At startup celld tried to resume the existing Space cell and logged
`celld runtime start failed for Space:<id>: no Worker exports Durable Object
class Space` once; readiness opened and every request succeeded. The Spaces
build then started again with the Space, its listing, the previous build's edit
and the breadcrumbs intact. So a celld rollback needs no special artifact; expect
that one log line per Space cell celld resumes. On Cloudflare, removing a Durable
Object class takes a `deleted_classes` migration that erases its storage, so a
Cloudflare rollback must keep exporting `Space` and its binding instead.

## Tunnel and DNS provisioning

This is first-publication setup, not a step to repeat for each release. Page8's
existing tunnel and DNS should be inspected and reused.

The profile expects a separate locally managed Cloudflare Tunnel named
`nteract-page8` in account `1cfb529b94b3d6cde3aaf49d1d6ed5e6`. Tunnel creation
requires Tunnel Edit permission and is not performed by `prepare` or `publish`.
After installation creates the owned directory, tunnel credentials belong in
root-owned mode 0600 `/etc/nteract-page8/tunnel.json`. The nonsecret provisioning
receipt at `/etc/nteract-page8/tunnel-provisioning.json` has this form:

```json
{
  "schema": 1,
  "account_id": "1cfb529b94b3d6cde3aaf49d1d6ed5e6",
  "tunnel_id": "VERIFIED_TUNNEL_UUID",
  "name": "nteract-page8",
  "config_src": "local"
}
```

Keep provisioning files outside release artifacts; do not precreate the service
installation directory. Publication rejects reused tunnel IDs, absent credentials,
and conflicting configuration. It installs only Page8's connector and verifies
frozen service/connector configuration and PIDs. Do not use
`cloudflared service install`, which targets the shared connector.

Inspect DNS with:

```sh
node scripts/deployment/dns.mjs --target page8 VERIFIED_TUNNEL_UUID
```

Appending `--apply` creates only an absent owned CNAME; conflicts are rejected.
The operation uses `CLOUDFLARE_API_TOKEN` with DNS read/edit access to `runtimed.run`.
Public ingress allows application, auth, sharing, MCP, asset, and sync routes,
then ends in a catch-all 404. Internal Durable Object routes stay private.

## Telemetry

Service units enable `CELLD_OTEL=1` and `CELLD_OTEL_RETENTION=30d` with celld's
five-minute/5 MiB batching defaults. Verify actual Parquet delivery under
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
select Page8's flags. Do not repoint the existing preview domain as part of a
Page8 release.
