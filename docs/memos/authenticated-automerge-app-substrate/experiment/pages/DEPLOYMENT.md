# Pages deployment

The current release is qualified for two isolated celld targets: **Pages**
(`pages.runtimed.run`) and **Page10**. Page9 and earlier services are frozen.
Deployment helpers reject mutations to those targets and check their
fingerprints when publishing Pages or Page10. Historical profiles remain in
[profiles.mjs](scripts/deployment/profiles.mjs) for inspection and isolation
checks; their presence is not permission to deploy to them.

Numbered page targets are short-lived prototypes. A release that would break
existing clients goes to a new target instead of carrying compatibility code;
deployment never copies data between targets. Page10 is one of those: a fresh,
empty target for the location and comments redesign, with no compatibility with
Page9's data. Page10 stays deployable until its Projects are copied to Pages; a
later release freezes it.

## Pages release

The `pages` profile owns `pages.runtimed.run`:

| Field | Value |
| --- | --- |
| Hostname | `pages.runtimed.run` |
| Service and user | `nteract-pages-live` |
| Prefix | `standalone/pages-live` in the lab1 fleet bucket |
| Listeners | `127.0.0.1:9481`, internal `127.0.0.1:19481` |
| Firewall | table `nteract_pages_live`, mark `0x00100000` |
| Tunnel connectors | `cloudflared-pages-live-a.service` (metrics `127.0.0.1:29481`) and `cloudflared-pages-live-b.service` (`127.0.0.1:29491`), tunnel `nteract-pages-live`; see [Connector handoff](#connector-handoff) |
| Frozen neighbors | `page7`, `page8`, `page9` |

It carries every Page10 flag, the Page quota default and D1 binding, and the
same celld 0.6.3 runtime and OIDC client. Like Page10, it creates new Pages
with plain Automerge sync; see [Moving pages off
Subduction](#moving-pages-off-subduction) for the Pages created before that.
Both serving targets set `memory` in their profile:
celld sheds cells above `CELLD_MAX_RSS_MB=2560`, and systemd caps the unit at
`MemoryMax=4G`. At the earlier 768 MB threshold production shed its D1 cell
repeatedly, and signed-in requests failed with 503 while it restored. Changing
either value changes the unit, so the next install restarts the service. The service and prefix end in `-live`
because lab1 still holds a disabled `nteract-pages.service` and
`/etc/nteract-pages` from an earlier prototype. The installer refuses any path,
user or prefix it does not own, so the target must not share those names.

Pages starts empty. Projects arrive from Page10 (or any older target) through
[project-transfer.mjs](scripts/project-transfer.mjs); see
[Copying a Project to a new target](#copying-a-project-to-a-new-target).

Before anyone signs in, add `https://pages.runtimed.run/oidc` as a redirect URI
on OIDC client `1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0`. The installer derives
`NOTEBOOK_CLOUD_OIDC_REDIRECT_URI` from the hostname; the identity provider has
to allow it.

From `pages`, after review, commit, and a fresh build:

```sh
node scripts/deploy.mjs --target pages plan
node scripts/deploy.mjs --target pages prepare
node scripts/deploy.mjs --target pages upload LOCAL_STAGE
node scripts/deploy.mjs --target pages install REMOTE_STAGE --apply
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target pages provision            # inspect
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target pages provision --apply    # first publication only
node scripts/deploy.mjs --target pages publish REMOTE_STAGE --apply
```

`provision --apply` refuses a `pages.runtimed.run` DNS record it does not own,
including one an earlier prototype left behind. Remove such a record in
Cloudflare by hand, after checking nothing serves from it, then rerun.

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
is `0x00200000`, the next bit below Page9's `0x00400000`; Pages takes the next,
`0x00100000`. The installer checks
ownership and resource conflicts, preserves Durable Object bindings/migrations
and persistent data, and touches only the selected service. Installation and
publication require lab1 SSH and sudo.

Each installation copies `firewall.mjs` and `profiles.mjs` into its own
`/opt/<service>`, and its unit's `ExecStartPre` runs that copy. A frozen service
keeps the copy that qualified it, so Page9 keeps restarting after qualification
moved to Page10 and Pages.

### App-only and full deploys

`install` always runs `celld deploy`, which uploads the release and moves the
fleet's deployment pointer. A running node adopts the new pointer at its next
poll (`CELLD_DEPLOY_POLL_S`, 30 s) without restarting. Resident Durable Objects
move to the new code within `CELLD_DEPLOY_MAX_AGE_S` (60 s). Open WebSockets
stay up.

A restart is different: celld drains, answers 503 while it hands cells off,
and on a one-node fleet the handoff cannot succeed, so a restart is downtime.
The installer therefore restarts only when something the process reads at
startup changed ([activation.mjs](scripts/deployment/activation.mjs)). The
unit counts as systemd loads it: the rendered fragment plus every drop-in in
`DropInPaths`, by path and content.

| Changed since the process started | Install does | `restart_reasons` |
| --- | --- | --- |
| Nothing but the release (app-only) | Adopt: no restart | |
| `firewall.mjs` or `profiles.mjs` only | Adopt, and apply the firewall in place | |
| Rendered unit fragment | Stage, verify, rename, `daemon-reload`, restart | `unit` |
| A drop-in under `<unit>.d/` added, edited or removed | `daemon-reload` if pending, restart | `unit` |
| `NeedDaemonReload=yes` before install (anything on disk not loaded) | `daemon-reload`, restart | `reload` |
| celld executable (SHA-256) | Copy, restart | `celld` |
| Configured `wrangler.json` (bindings, migrations, vars) | Restart | `config` |
| No record and the process cannot be observed | Restart | `unknown` |
| `install ... --apply --restart` | Restart | `requested` |
| Service not active | Start | `inactive` |

The installer renders the unit into a temporary directory under `/etc/systemd`
with the same basename, runs `systemd-analyze verify` on it there, and only
then renames it over `/etc/systemd/system/<service>.service`. A failed verify
leaves the old file, the loaded definition and the fleet pointer untouched.
It runs `daemon-reload` when the text changed or systemd reports
`NeedDaemonReload=yes`, which also covers a unit an interrupted run renamed
into place but never loaded. If systemd still reports `NeedDaemonReload=yes`
after the reload, install stops before `celld deploy` and before any restart.
All of this happens before `celld deploy`, so a unit problem never leaves the
pointer moved.

The firewall rules name the service cgroup, which lives as long as the process,
so `ExecStartPre` does not need to run per deploy. A changed helper runs
directly with `node /opt/<service>/firewall.mjs --target <target>`.

`--restart` (`node scripts/deploy.mjs --target <target> install <stage> --apply
--restart`) restarts even when nothing changed: to roll a node by hand, or
after changing something outside the unit that the process reads only at
start.

### Serving: local node, then the fleet

After the restart or adoption, install waits twice:

1. **Local node.** It polls `http://<listen>/health` every 2 s until `build`
   equals the manifest's `build_receipt.build_id`, for up to 120 s after an
   adoption or 240 s after a restart. This proves only the gateway of the node
   on this host. The output reports it as `local_serving_after_ms`.
2. **Every live node.** It lists the fleet's node leases
   (`<prefix>/nodes/*.json`), skips expired ones, keeps the newest lease per
   listener address (a restarted node's old lease lingers up to 10 s), and polls
   `GET http://<addr>/state` on each lease's internal listener every 3 s until
   every node's `deployment.version` equals the version `celld deploy`
   reported, for up to 120 s. Nodes poll the pointer on their own schedules:
   with two Page10 nodes, one adopted 9 s after the pointer moved and the other
   26 s. The output reports `deployment_version`, `fleet_nodes` and
   `fleet_serving_after_ms`. Peers must accept the probe on their internal
   port from this host; see the second-node runbook in the sandbox
   `celld-lab` README.

After the local wait succeeds, install writes `/etc/<service>/running.json`:
the SHA-256 of the unit (fragment plus loaded drop-ins), executable,
configured `wrangler.json` and firewall helpers the process now runs with,
keyed by its `MainPID` and start second. The next install compares against
that record. A restart that fails, or never serves, leaves the old record; a
retry restarts again as long as the same process is still running. If the
process changed in between (a crash restart, a manual restart), the record no
longer matches and the installer observes the new process instead.

Without a record for the current process, the installer observes the
process. Installers write their files before they restart, so it trusts a file
only if it is older than the process start (`ExecMainStartTimestamp`): the
fragment, each loaded drop-in, the configured `wrangler.json` from the newest
earlier rollout, and the firewall helpers. `/proc/<pid>/exe` must hash to the
executable. Anything else counts as `unknown` and restarts.

`systemctl show --timestamp=unix` needs systemd 248 or later. lab1 and
pages-node2 run systemd 255. On an older systemd the call fails and install
stops before it changes anything.

### When a wait times out

Either timeout fails the install after `celld deploy` has moved the pointer.
The error names both deployments and the way back:

```text
... did not serve within 120000 ms; last: <detail>. The fleet pointer names
<new version>; the previous deployment <old version> is recorded in
/etc/<service>/rollout-<sha>/previous-deployment.json. Roll back with:
sudo runuser -u <service> -- /opt/<service>/celld deploy
/opt/<service>/releases/<previous sha> --bucket s3://<bucket>/<prefix>
--region us-east-1 --json
```

The installer finds `<previous sha>` as the earlier rollout whose
`deployment.json` names the previous version. The rollback moves the pointer
back; nodes adopt it the same way, without a restart. A first deployment has no
previous one, and the error says so.

celld 0.6.3 bounds the drain with `CELLD_SHUTDOWN_TOTAL_MS` (40 s); the
handoff gives up after 5/8 of it without progress (25 s). The profiles leave
it at the default. Lowering it shortens a one-node restart by at most that
interval, but it changes the unit (one restart to roll it in) and cuts the
handoff budget once a fleet has a second node, where the handoff succeeds and
the survivor would otherwise have to recover the stopped node's log. With
app-only deploys, a restart is rare: a celld upgrade, a unit change, or a
binding change.

### Restore points

The fleet bucket is versioned and keeps noncurrent versions for 14 days, so
every object as of a moment stays recoverable without copying it. A restore
point records the current version id of every key under the prefix, and
taking one does not stop the service:

```sh
aws s3api list-object-versions --bucket nteract-celld-lab-621741996708 \
  --prefix standalone/<prefix>/ \
  --query 'Versions[?IsLatest].{Key:Key,VersionId:VersionId,Size:Size}' \
  --output json > versions.json
aws s3 cp versions.json \
  s3://nteract-celld-lab-621741996708/standalone/<prefix>-snapshots/<date>-<label>/versions.json
```

Take one before a release that changes storage. To restore, stop the service on
every node of the fleet, copy each listed version back over its key
(`aws s3api copy-object --copy-source '<bucket>/<key>?versionId=<id>'`), delete
current keys under the prefix that the manifest does not list, move each node's
`/var/lib/<service>` contents aside so no node resumes from newer local state,
and start the nodes. A restore point is worth 14 days; after that its versions
expire.

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

The Page8, Page9, Page10 and Pages profiles set `PAGES_CATALOG_INDEX=1`. Changing this epoch label starts
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
with sub-pages and does not protect a Project's content document. After rolling
forward, a Page whose parent is in Trash shows at the top level of the Project
view and a resumed creation under such a parent answers `parent_unavailable`.
Rolling back that far is no longer possible (see the rollback rule below). At startup a build without the `Space` class logs `celld runtime start failed for
Space:<id>: no Worker exports Durable Object class Space` once per Project cell
celld resumes, then serves normally. On Cloudflare, removing a Durable Object
class takes a `deleted_classes` migration that erases its storage, so a
Cloudflare rollback must keep exporting `Space` and its binding instead.

A Project's content is its own document, not a Page in the tree. `get_project`
names it as `document_id`; the Page tools address it by `project_id` in place of
`page_id`; `list_pages` never lists it; `move_page`, `delete_page` and
`purge_page` refuse it with `project_content_protected`. `create_page
{project_id}` makes a top-level Page with `parent_id: null`, and `list_pages
{project_id, parent_id: null}` lists those. In the owner's Catalog the content
document keeps its `page/<document_id>` entry (so its title, quota slot, D1 owner
row and any direct grants stay where they were) marked `project_content:
<project_id>` with no location fields; `space/<id>` records name it as
`document_id`. This is location shape 2 (`LOCATION_SHAPE_VERSION` in
`worker/location-shape.mjs`, stamped in `host/location/shape`).

Shape 1, which builds before #4853 wrote, kept the content as a Page: a root
entry flagged `home: true` whose children were the Project's top level, and
`space/<id>.home_page_id` naming it. Nothing in this build reads or checks for
that shape. An owner-run one-shot migration converted production's only account
with Projects on 2026-11-05; no other production account held a Project. On
page10, which deploys main automatically, the same migration had already run:
every Project there carries `document_id`. The
one other trace is D1 migration 4's historical `CREATE TABLE`, which migration 8
rebuilds without the column.

**Rollback rule.** Never roll back past #4853. An older build's location pass
takes shape 2 for shape 1 and would move a Project's root Pages back under its
content document; its D1 Space upserts also fail against schema 8. Any future
rewrite of location entries must bump `LOCATION_SHAPE_VERSION` (to 3) and check
for the shape it retires before stamping a Catalog.

`scripts/migration-inventory.mjs` audits offline Catalog evidence: a `space/` record with `document_id` is counted as
`content`, one with the retired field as `legacy_content` with the issue
`project_content_unmigrated`, and one with both or neither is invalid.

Rollback past #4712. Builds before #4712 can't replay a `move_page` receipt
for a request with `parent_id: null`. The move already landed, so after such a
rollback a client should read or list the Page instead of retrying the move.

### Rollback and Page record storage

A Page keeps the record storage it was created with. A build that doesn't
know a Page's mode refuses to open it ("Unsupported Page record storage
mode"), and builds before a2c9d5dde don't know `automerge`. So a target that
has created plain Automerge Pages can't run such a build.

Each build receipt lists the modes its Worker opens as `record_storage`
(`shared/record-storage.mjs`); the release manifest carries the receipt. A
receipt without the list counts as opening only the native modes, which
covers every build before the list existed, including a2c9d5dde and #4770.

Plain targets also require `plain_storage_formats` to include
`doc-store-v2-host-actor-prefix`, from the same shared module. This capability
covers DocStore v2 and host actor namespace admission. A missing list, even
with `automerge` in `record_storage`, is refused by every entrypoint below.
Older builds can discard incremental history or admit forged host actors.

DocStore writes manifests only at `sync/<doc>/m2`. New readers prefer `m2`
over legacy `m`; the legacy key is removed only after `m2` is durable. Old
viewer bundles sharing IndexedDB see no manifest for upgraded documents and
must resync, rather than interpreting a v2 manifest as a v1 document.

A target may hold a mode when `RECORD_STORAGE_HISTORY` in
`scripts/deployment/profiles.mjs` lists it, its profile sets `recordStorage`,
or a release installed on the host was configured with that
`PAGES_RECORD_STORAGE`. History outlives the profile flag: turning
`recordStorage` off stops new plain Pages, but the existing ones remain.

A release that lacks one of those modes is refused, naming the target, the
release and the reason, by:

- `deploy.mjs prepare` and `upload`, from the local manifest;
- `deploy.mjs install`, which reads the staged manifest over SSH before
  running the stage's installer. A stage brings its own `install.mjs`, and
  one from before this check never runs it, so install an older release
  from a current checkout;
- `install.mjs` itself, before any write, which also reads the configured
  `wrangler.json` of every release under `/opt/<service>/releases`;
- the timeout message, which doesn't name a `celld deploy` rollback to such a
  release.

There is no override. A direct `celld deploy` of a release directory bypasses
every check. Page10 holds `automerge` Pages, so it can't roll back past
a2c9d5dde, and can't install a2c9d5dde or #4770 through deploy.mjs either,
because their receipts predate the list. Builds listing `automerge` but lacking
`doc-store-v2-host-actor-prefix` are also unsafe and refused. Pages is held to
the same floor: `RECORD_STORAGE_HISTORY` lists `automerge` for it from the
commit that set its `recordStorage`, before any plain Page exists there.

### Moving pages off Subduction

The `pages` profile sets `recordStorage: "automerge"`. Merging that changes
nothing on `pages.runtimed.run`: the running process keeps its configuration
until an install writes the new `PAGES_RECORD_STORAGE` var and restarts it.
After that, new Pages use plain Automerge sync and existing Pages stay on
Subduction. Converting them is a separate canary, listed by Page ID. Run these
steps from `pages`.

1. **Deploy the profile.** Take a [restore point](#restore-points), then
   `prepare`, `upload` and `install --apply` as in [Pages release](#pages-release).
   The configured `wrangler.json` changes, so install restarts with
   `restart_reasons: ["config"]`. On a one-node fleet that is a short outage
   (the drain, up to 40 s, then boot). Note when the plain release took over.
   `running.json` is written once the restarted process serves; the old process
   kept creating native Pages until then, so use this time, not the rollout's
   `deployment.json`, which is written before the restart:

   ```sh
   ssh lab1 sudo date -u -r /etc/nteract-pages-live/running.json +%FT%TZ
   ```

   `--plain-since` takes only ISO 8601 with `Z` or an offset. Pages created
   before that time are native. Check one new Page and one old
   one: `GET /api/connect?page=<id>` answers `recordStorage: "automerge"` for a
   plain Page and a `serverPeerId` for a Subduction Page.

2. **Inventory.** Export the D1 rows and classify them offline with
   [record-storage-inventory.mjs](scripts/record-storage-inventory.mjs):

   ```sh
   node scripts/d1.mjs --target pages \
     "SELECT page_id, owner, state, created_at FROM pages_catalog_pages" > pages.jsonl
   node scripts/record-storage-inventory.mjs --target pages --d1 pages.jsonl \
     --plain-since <time from step 1> > inventory.json
   ```

   It prints each Page's `storage` (`native`, `automerge` or `unknown`) and the
   `basis` for it. `--connect` adds `/api/connect` bodies, one per line; those
   are direct evidence and outrank the creation time. A connect call boots the
   Page host but never makes it eligible to convert; only a browser socket
   does. An API key reaches only Pages its account can open:

   ```sh
   for id in $(node scripts/record-storage-inventory.mjs --d1 pages.jsonl \
       --plain-since <time> --only native,unknown --format ids); do
     curl -sS -H "Authorization: Bearer $PAGES_API_KEY" \
       "https://pages.runtimed.run/api/connect?page=$id"; echo
   done > connect.jsonl
   ```

   The D1 rows are a projection: an account whose index hasn't reconciled has
   no rows. List Page cells with `celld cell list Page ... --all --json` and
   pass IDs the rows lack as `--page-ids`.

   A Page created within a minute after `--plain-since` is worth probing too:
   the cutoff is the first served request on the new process, and clocks on the
   host and in D1 differ slightly.

   Installing a stage built before this profile change turns
   `PAGES_RECORD_STORAGE` off again, so new Pages go back to Subduction until the
   next plain install. Existing plain Pages keep opening.

3. **Canary 3 to 5 Pages.** Pick active native Pages you can open in a
   browser: one with comments, one large buffered Page, one shared Page.
   Qualify the conversion locally first, on the same source SHA:
   `node scripts/local-sharing-e2e.mjs --migration`
   ([record-storage-migration-smoke.mjs](scripts/record-storage-migration-smoke.mjs)).
   Then write the list on the host, root-only, beside the session secret:

   ```sh
   ssh lab1 'sudo install -m 0600 -o root -g root /dev/stdin \
     /etc/nteract-pages-live/record-storage-migration.json' <<< \
     '{"enabled":true,"pageIds":["<id>","<id>","<id>"]}'
   node scripts/deploy.mjs --target pages install REMOTE_STAGE --apply
   ```

   Reinstalling the same stage is allowed when only the configured vars
   changed; it restarts with `restart_reasons: ["config"]`. The stage must
   come from this commit or later: an older staged installer ignores the file.
   Then open each canary in a browser, close the tab, and leave it unused for
   30 s.

4. **Verify.** For each canary:
   - `/api/connect` answers `recordStorage: "automerge"`.
   - The Worker logs a `record_storage.migration` line with
     `outcome: "converted"` and `from: "buffered"`. Look in the OTEL logs under
     `standalone/pages-live/telemetry/logs` (see [Telemetry](#telemetry)) and
     in `journalctl -u nteract-pages-live`. The line's fields don't name the
     Page, so close one canary at a time when attribution matters. A
     `skipped` line names its reason; three in a row pause that Page until a
     new browser session.
   - The Page's `host/document` now carries `recordStorageMigratedFrom` and
     `recordStorageMigratedAt`. No route serves that record; confirm it from an
     exported record with `record-storage-inventory.mjs --records`, which
     reports `migrated_from` and `migrated_at`.
   - The Page opens, takes an edit, keeps its comments, and `read_page` over
     MCP returns the edit.

5. **Widen.** Add IDs to the file (at most 500, unique, lowercase UUIDs; the
   installer refuses anything else, including `*`) and reinstall. Each change
   is one restart, so widen in batches. Rerun the inventory with `--canary`
   for every list you installed: a listed Page without direct evidence is
   `unknown` until probed.

6. **Rollback floor.** Once step 1 has run, `pages` holds `automerge` Pages.
   Every entrypoint refuses a build whose receipt lacks `automerge` and
   `doc-store-v2-host-actor-prefix` ([Rollback and Page record
   storage](#rollback-and-page-record-storage)). To stop conversions, delete
   the file or set `enabled: false` and reinstall. Converted Pages stay plain:
   conversion is one-way, and a restore point from before it drops every edit
   made since. Taking `recordStorage` out of the profile stops new plain Pages;
   the history entry stays.

The file may stand in only for a disabled, empty profile policy: the installer
refuses a profile canary and a host file together. It must be a regular file,
not a symlink, and not group- or world-writable.

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

Stored intents keep the Space names. A `create_space` interrupted before its
content document finishes when retried as `create_project` with the same key
and payload: the fingerprint still uses the stored operation name. A
`create_page` interrupted before its Page finishes when retried with
`project_id`, the same key and the arguments in the same order: its pending
Catalog entry holds the location. Fingerprints have always covered argument
order.

Clients with a cached tool list or bundle are refused before anything runs, so
no idempotency key is consumed. The old tool names answer
`` `create_space` was renamed `create_project` `` (code `tool_renamed`, and the
same for the other three). A `space_id` argument answers
`` `space_id` is now `project_id` `` (`argument_renamed`).

Rolling back to 3548b9750 is not supported: it predates #4853 (see the rollback
rule above).

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

### Stored forms this build refuses

Every Page on pages and page10 was rewritten to the current stored forms on
2026-11-05: rich-text blocks, comments in their own document, `comments_doc`
in every live or trashed host record. On pages, the verifying dry run at 19:27
UTC reported 137 Pages unchanged, 1 deleted, 0 writes pending and 0 problems,
with `comments_doc` on every host record. On page10, the run from 22:24 to
22:27 UTC reported 86 unchanged, 19 deleted (their tombstones finished), 0
problems, no preserved blocks and no pending comments move.

This build doesn't read the earlier forms. A Page that still holds one answers
`409 stored_form_unsupported` on the read or write that meets it, and a live or
trashed Page's host record without `comments_doc` fails at boot. A deleted
Page's record needs none: it names no comments document and answers as deleted.
page10 holds one such record (59361b99-fc53-40ec-a733-a74a4db24630). Don't
restore a backup taken before 2026-11-05 onto a target running this build.

### Plain sync on pages.runtimed.run

<<<<<<< HEAD
Every Page on pages.runtimed.run is on plain Automerge sync: an operator
conversion on 2026-11-05 left 136 active and 3 trashed Pages on `automerge`, 0
remaining and 0 unreadable. That operator route is gone; this build has no
operator routes and the installer writes no operator secret. A Subduction Page
on another target converts only through the passive canary (README,
"Migrating existing Pages").
=======
A run that fails before anything is reserved, for a reason that won't pass
(the change is too large, the conversion throws, or a request-shaped
refusal), retries once converting each source as plain text. If that fails
too, the host logs one line:

```json
{"service":"nteract-pages-native","event":"page.preserved_markdown_stuck","page_id":"…","reason":"history_capacity","timestamp":"…"}
```

`reason` is a bounded code (`history_capacity`, `conversion_error`, an error
code, or `status_<n>`); the line carries no content. After a deploy, search the
target's logs for `page.preserved_markdown_stuck`. If the Page is still
fenced (reads work, edits get `preserved_markdown_converting`), it is retrying
a reserved run: free storage or capacity as above. Otherwise the Page is stuck
and not fenced: it edits normally, and its preserved blocks stay read-only with a notice. The next
load tries again. To recover a Page now, as its owner or with an agent:

1. `read_page` the Page. A preserved block reads as the Markdown it would
   convert to.
2. `edit_page` with `replace_block_markdown` on that block, passing the
   Markdown from step 1. If it's refused with `unsupported_markdown` or for
   size, simplify or split the Markdown and retry.

The replacement removes the preserved block, so nothing is left to convert.

### Content migration

One owner-run pass puts every Page document in the forms this build writes,
so the readers of older forms can be deleted. The code lives in
`model/content-normalization.mjs` (what changes in a document) and
`worker/content-migration.mjs` (the run), both marked for deletion after
production has migrated, with `scripts/content-migration.mjs`,
`scripts/content-migration-operator.mjs`, the `/api/admin/content-migration`
and `/api/operator/content-migration` routes and their Catalog and Page
routes and the content listener's `contentMigrating` flag in `worker/index.mjs`.
The operator gate (`worker/operator-gate.mjs`, `scripts/operator-ssh.mjs`) and
the installer's `operatorMigration` secret go with the last operator route
(see [Operator conversion to plain sync](#operator-conversion-to-plain-sync)).

Per Page, in one journaled host change (`host/operation/internal:content_norm_<digest of
heads>`):

- each rich block body is rewritten to the editor's canonical spans,
  `encode(decode(spans).doc)`, with `A.updateSpans`, so unchanged text and
  markers keep their identity (comment anchors, cursors, node ids). The old
  forms it removes: an explicit marker before a top-level first paragraph
  (`first_marker`), a quote without its own marker (`quote_marker`), `\n` in
  prose instead of a hard break (`prose_newline`), marks on code text
  (`code_marks`) and missing default attrs (`attrs`);
- a Markdown-era block (no `format`) becomes rich text (`markdown_block`),
  already in the editor's form after this one pass. One with no `kind` at
  all is refused as `kind_missing` and one of another kind as `not_prose`,
  so the dry run shows whether production holds any;
  its selection comments detach, and the report counts them first;
- the schema stamp is repaired to name what the content needs.

A block is refused when its decode is lossy or throws, when it still holds a
preserved block, when the rewrite would delete any character other than a
prose `\n` (`identity_lost`) or add text (`text_changed`), or when it would
detach a comment anchor (`anchors_detached`). Every character is checked,
from the rewrite's own delete operations (a 256 KiB block plans in about
100 ms). A Page
with any refused block, or with on-load work still to do, is `partial`, and
`apply` writes nothing to it: the gate holds in the Page host at apply time,
against the Page as it is then, whatever its dry run said. Comment message
bodies aren't touched. Preserved
blocks, the comments move and the record's `comments_doc` field are the Page
host's existing on-load work; the migration reports them and refuses a Page
whose conversion fence is up (`held`). A Page with a live socket is skipped
(`busy`) and visited again on the next pass, unless the run passes
`include_connected: true` (script flag `--include-connected`).

**Connected peers.** With `include_connected`, the host writes while browsers
or agents are connected. The change reaches them over sync like any host
change: the editor re-decodes the block, unchanged text and markers keep their
identity, so carets and comment anchors stay put. No peer is disconnected and
no fence goes up: the change adds no schema feature, so a stale tab from an
earlier build keeps editing (the schema gate refuses a tab only for a feature
its build lacks, and a stamp repair adds only a feature the content already
uses), and build freshness is untouched because nothing is deployed. A peer's
own edit either merges (made before the write and synced after it, or made
after it) or, if it reaches the host between the plan and the write, fails
the write's exact-heads check: the Page answers `stale`, nothing is written,
and the next pass plans again. Default to skipping; use `include_connected`
for Pages that stay `busy` because a tab is left open.

**Half-finished permanent deletions.** A build without Trash could delete a
trashed Page for good and leave its `trash/` entry beside the Catalog's
`host/deleted/<id>` tombstone, with the Page record still trashed. `dry_run`
lists each under `tombstones` (`{page_id, trash_entry, finalize}`) and on the
Page's row (`tombstone`). `apply` finishes it the way the current build does
when it meets such a tombstone: the operation-intent machine's `tombstone`
effects, `forget_trash` (drop the `trash/` entry) and `notify_tombstone`
(the Page host records the deletion as `deleted_by_earlier_build`, drops its
document, withdraws access and retires its index row). A tombstone whose
`trash/` entry a Trash listing already pruned is finished too when the Page
still reports itself trashed. Before the first change, the Catalog saves the
`trash/` entry and `host/count/trash` under `host/content-migration/before/`
(`{content_migration_absent: true}` for a key that didn't exist), once. Until
the Page reports `deleted`, the visit stays `tombstone_pending`. To undo the
Catalog side, put each before-image back through the Catalog's counted storage;
the Page side can't be undone: the earlier build already deleted the document.

**Operator run (lab targets: every account).** On the celld lab targets
(`pages`, `page10`; profiles with `operatorMigration`), an operator runs it for
every account from an operator machine over SSH:

```sh
cd docs/memos/authenticated-automerge-app-substrate/experiment/pages
node scripts/content-migration-operator.mjs --target pages --mode dry_run > dry-run.json
node scripts/content-migration-operator.mjs --target pages --mode apply \
  --include-connected > apply.json
```

Each call is one SSH command to lab1. It reads the root-only
`/etc/<service>/operator-secret` with `sudo -n` and posts, as the service user,
to `http://<listen>/api/operator/content-migration` on loopback. The secret
reaches curl in its config on stdin, never on a command line. The script lists
the accounts, drives each account's Catalog until it covered every Page (the
same `dry_run`/`apply` responses as the owner run below), then lists the Page
cells with `celld cell list Page` (read-only), and probes every cell no run
reached for its `page_id`, `owner` and `state`. The report holds per-account
totals and progress, `reached`, `page_cells` and `unreached`. Each response,
refusals included, is appended to a JSON-lines log as it arrives
(`--log`, default `content-migration-operator-<target>-<mode>-<time>.jsonl`). A
leftover with an owner can be passed to that owner's run (`--principal <owner>`
here runs one account; `page_ids` in the route body adds Pages). Options:
`--principal` (repeatable), `--include-connected`, `--limit`, `--no-cells`,
`--ssh-host`.

How the route is gated:

- celld's internal listener (`internalListen`, 19481 for `pages`) answers its
  own operator routes and never forwards to the Worker (on lab1, `GET /health`
  and any other path there return celld's `{"error":"not_found"}`), so the
  Worker can't gate on how a request arrives. It gates on a secret instead.
- The installer creates `/etc/<service>/operator-secret` (48 random bytes,
  root-only, kept across installs) on profiles with `operatorMigration` and
  passes it to the Worker as `PAGES_OPERATOR_SECRET`. The route exists only
  when that variable holds at least 32 characters: a Cloudflare deployment, or
  any profile without the flag, answers the gateway's plain
  `404 {"error":"Not found"}`.
- The request must carry the secret in `x-pages-operator-secret`, compared in
  constant time, and must carry none of `cf-ray`, `cf-connecting-ip`,
  `cf-visitor`, `cdn-loop`. The Cloudflare edge adds those to everything it
  forwards through the tunnel, and a client can't remove them, so even a leaked
  secret doesn't open the route from the public hostname. Every refusal is the
  same 404 as an unknown path.
- The listeners' firewall admits only root and the service user, which is why
  the script runs curl as the service user.

The operator selects a Catalog; it doesn't bypass Page authority. The route
forwards to that account's Catalog on a host-only path, and the run acts for
the Catalog's own account: each Page host still answers `not_owner` unless its
record names that account. Accounts come from the D1 catalog projection
(`pages_catalog_pages` and `pages_catalog_spaces` owners, and
`pages_catalog_accounts`), because the Worker can't list Catalog cells; the
cell diff above is the cross-check. The secret needs an install of a build
with this route; the route is deleted with the migration.

**Owner run (alternative, any deployment).** The owner runs it for their own
account with an API key that has write access. It reaches only that account's
Pages: every `page/` (Project content included), `trash/` and `host/deleted/`
key in the owner's Catalog, plus any `page_ids` in the body, which the Page host
checks against its record's owner.

```sh
cd docs/memos/authenticated-automerge-app-substrate/experiment/pages
PAGES_API_KEY=$ANACONDA_API_KEY node scripts/content-migration.mjs \
  --origin https://pages.runtimed.run --mode dry_run > dry-run.json
```

The script calls the endpoint until it has covered every Page and prints one
report. It appends every response, refusals included, to a JSON-lines log
(`--log`, by default `content-migration-<mode>-<time>.jsonl`) as it arrives;
for `apply` that log is where the per-block detail lives. A failed call stops
the script, which still prints the report so far. One call by hand:

```sh
curl -sS https://pages.runtimed.run/api/admin/content-migration \
  -H "Authorization: Bearer $ANACONDA_API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"dry_run","limit":10}'
```

`dry_run` writes nothing of its own (booting a Page runs its on-load work, as
any read does) and answers `{mode, targets: {total, page, trash, deleted,
extra}, tombstones: [{page_id, trash_entry}], pages, visited, next, totals,
progress}`. Pass `next` back as `after` until it is null. Each page reports
`status` (`would_normalize`, `unchanged`, `partial`, `held`, `unavailable`,
`record_pending`, `missing`, `deleted`, `not_owner`, `error`), `state`,
`record_comments_doc`, `conversion`, `connected`, `heads`, `report` (per-block
`forms`, markers kept, removed and added by type, characters before and
after with `lost`, `newlines` and `unexpected`, anchors attached and detached; page `forms`, `refused`, `stamp_repair`,
`preserved_blocks`, `comments_move_pending`, `refused_reasons`) and
`problems`. `totals` counts pages by status, blocks by form and refusals by
reason. Before `apply`, read the report: `partial` Pages won't be written, and
`markdown_block` conversions detach the selection comments their `anchors`
count.

Page cells no Catalog key names don't appear in an owner run. `celld cell list
Page` lists cells by Durable Object id, not page id; each visited page reports
its `cell_id` when the runtime exposes `idFromName`, and the operator script
diffs and probes the rest. Pass a leftover as `--page-id` in its owner's run.

Then `apply`, after Kyle approves the dry-run reports:

```sh
PAGES_API_KEY=$ANACONDA_API_KEY node scripts/content-migration.mjs \
  --origin https://pages.runtimed.run --mode apply > apply.json
```

Each call visits up to `limit` Pages (at most 25, and none after 60 s), so it
stays inside the Catalog queue's 120 s bound. Progress is in
`host/content-migration/state` (`{phase: applying | incomplete | done, ids,
next, pass, pending}`), and each Page's latest result in
`host/content-migration/result/<page_id>`. A pass ends `done` when every Page
settled (`normalized`, `unchanged`, `deleted`, `missing`, `not_owner`),
otherwise `incomplete` with `pending`; the next `apply` visits only those. A
Page that changed between its plan and its write answers `stale` and is
written on a later pass. An interrupted `apply` resumes at its cursor. A crash
inside the Page's write replays the journaled change at its next boot. `done`
is terminal: run `dry_run` again to verify. It should report
`would_normalize: 0`, no `partial`, and `problems: []` on every Page.

**Revert records.** Every write is recorded twice, durably, as `{key,
before_heads, after_heads, blocks: [{block_id, action}]}`: in the Page's
`host/content-migration/revert`, copied from its journal receipt before
anything can drop that receipt, and in the Catalog's `result/<page_id>`
`revert` list, which every later visit carries forward. The journal receipt
itself is not a restore source: the next internal host intent deletes it.

**Restore.** Page documents keep their history, so there are no before-images.
To revert a Page, take each record from its `revert` list, newest first, and,
as a host change, write `A.spans(A.view(doc, before_heads), path)` back to
each listed `normalize` block with `A.updateSpans`; for an `enable_rich`
block, delete `format` and `richText` (`markdown` still holds the source).
This also undoes later edits to those blocks. Removed first-paragraph markers
come back as new markers, so those nodes get new ids. To run the migration
again, delete only `host/content-migration/state`; keep `result/*`, which
holds the revert records.

**Rollback rule.** No schema feature is added, so earlier builds still edit a
migrated Page. Every Page-body writer in this build and the one before writes
the editor's form, so a rollback doesn't reintroduce old forms.

### Operator conversion to plain sync

The passive migration (README, "Migrating existing Pages") converts a listed
Page only after its last tab closes and it's quiet for 30 s. The operator
conversion converts named Pages now, open tabs or not, through the same Page
host machine and conversion. It's lab only, behind the operator gate above,
and marked for deletion with `worker/record-storage-operator.mjs`,
`scripts/record-storage-operator.mjs`, the `requested` event in
`worker/record-storage-migration.mjs` and its routes in `worker/index.mjs`.

**Prerequisite.** An installed release whose profile sets
`recordStorage: "automerge"` (and lists `automerge` in
`RECORD_STORAGE_HISTORY`), so the target's hosts run with
`PAGES_RECORD_STORAGE=automerge`. That's the switch: a host without it
refuses with `switch_off`, and the script stops before converting anything.
The same profile makes deployment refuse a rollback past #4795, the floor for
a target holding plain Pages (see
[Rollback and Page record storage](#rollback-and-page-record-storage)).
Changing those vars restarts the service on install. The passive canary
(`recordStorageMigration` or its operator file) isn't needed; the two compose,
since both drive the same machine and a converted Page is plain for both.

Per Page, in the host's serial request queue:

1. The host checks the switch, the Page id, the owner the script names (from
   the host's own status) and its record (`active` or `trashed`, Subduction
   storage, a document).
2. It steps its migration machine with `requested` and runs the conversion
   inside `blockConcurrencyWhile`. It first closes every native socket with
   close code 4503 (`temporarily_unavailable`, internal reason
   `record_storage_migrating`); new sockets and frames wait behind the block.
3. The existing conversion runs: flush, snapshot both documents into
   `plain/`, flip `host/document` to `recordStorage: "automerge"` with
   `recordStorageMigratedFrom` and `recordStorageMigratedAt`, retire, reset.
   It refuses to flip if the live heads moved after the snapshot
   (`heads_moved`). A skip or failure (`journal_pending`, `record_pending`,
   `deadline_margin`, …) arms no retry: the Page stays on Subduction until the
   operator asks again.

Each attempt logs one `record_storage.migration` line with its `page_id` and
`"trigger":"operator"`.

What people see: a tab on a converted Page reconnects, its discovery names
plain storage, and it reopens the Page in place on a plain replica from the
tab's checkpoint, then sends the host any edit it lacks. It shows "This Page's
storage changed" with a reload only if that reopen fails. Tabs on other Pages are untouched. MCP and HTTP tool calls that
land during a conversion get a 503 and retry; agent harnesses need a restart
only if one parks on that 503.

Run it from `pages`, after a restore point (see
[Restore points](#restore-points)). Read-only first:

```sh
node scripts/record-storage-operator.mjs --target pages --mode status --all > status.json
```

`--all` lists every `Page` cell with `celld cell list Page` (read-only) and
reads each host's record without booting it. It also lists every account's
Catalog (`page/` and `trash/`, so Project content and Trash are included)
from the D1 projection; `catalog_only` names Pages a Catalog lists that no
cell holds. `remaining` lists every `active` or `trashed` Page not yet plain.

A canary, then everything:

```sh
node scripts/record-storage-operator.mjs --target pages --mode convert --page-id <uuid> --page-id <uuid>
node scripts/record-storage-operator.mjs --target pages --mode convert --all --max 5
node scripts/record-storage-operator.mjs --target pages --mode convert --all
```

`--principal P` (repeatable) limits a run to one account's Catalog. `--max N`
stops after N conversions; `--pause-ms` paces them (default 500). Under
`--all` each conversion addresses its cell id, which the route resolves to
the Page its record names; the other scopes address the Page id. Each
`convert` call answers `{cell_id, page_id, outcome, status}`. A converted
object resets under its own request, so `outcome` may be an error; `status`
is read from the next object and is what counts. The script converts every
target its host calls convertible, reads them all again, and prints
`converted`, `failed`, `not_converted`, `remaining`, `unreadable` (statuses
that came back as errors: those Pages may still be on Subduction) and `done`.
`done` is true only when `remaining` and `unreadable` are both empty. Either
mode exits 0 only when `done` and no conversion failed, otherwise 2; run it
again to retry. Every request and response is
in the JSON-lines log (`--log`, default
`record-storage-operator-<target>-<mode>-<time>.jsonl`).

Verify:

```sh
node scripts/record-storage-operator.mjs --target pages --mode status --all > after.json
ssh lab1 'sudo -n journalctl -u nteract-pages-live --since -1h | grep -c "\"trigger\":\"operator\""'
```

`after.json` must say `"done": true` (empty `remaining` and `unreadable`), and
the script must exit 0; only `deleted` and `missing` cells may still name
Subduction storage. Locally,
`node scripts/e2e.mjs migration` runs both paths against celld and Chromium:
a tab on a passively converted Page, and a tab open on a Page the operator
converts, which reloads plain and keeps editing.
>>>>>>> origin/main

## Page quotas

Each account may hold a limited number of active Pages and, separately, the
same number in Trash. The profile's `pageQuota` sets the target's default, which
the installer writes as `PAGES_DEFAULT_PAGE_QUOTA`; Page10's and Pages' are 250. Without the
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

Every command names its target. There is no default, so a command rerun from
shell history after a new target ships still writes where it said it would.
A command without `--target` exits 2 before it sends anything.

```bash
node scripts/quota-rules.mjs --target pages check      # tables, schema version, rule count
node scripts/quota-rules.mjs --target pages list
node scripts/quota-rules.mjs --target pages get    email rgbkrk@gmail.com
node scripts/quota-rules.mjs --target pages set    email rgbkrk@gmail.com 1000 --note "design partner"
node scripts/quota-rules.mjs --target pages set    domain anaconda.com 500
node scripts/quota-rules.mjs --target pages set    email someone@example.com 0
node scripts/quota-rules.mjs --target page10 delete domain anaconda.com
```

| Option | Meaning |
| --- | --- |
| `--target NAME` | Required for every command: `pages` or `page10`. Only a profile with `pageQuota` and `d1` is accepted. |
| `--ssh-host HOST` | SSH destination, the profile's host (`lab1`) by default, for example `root@lab1`. |
| `--dry-run` | Print the remote script and every SQL step, and write nothing. `delete` runs its read-only preflight to show the stored rows it would remove; every other command sends nothing. |
| `--create-only` | `set` only: refuse when the rule already exists. |
| `--note TEXT` | `set` only: a note of at most 200 characters. |

Run it with Node 22.18 or later, which loads `sharing.ts` without a build step.
The SSH user must be root or able to `sudo -n -u` the target's service user
(`nteract-pages-live`, `nteract-page10`): the service's
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
- **Receipts name the target.** Every `set` and `delete` result, every
  failure and read-back message, and the dry-run header name the target and
  its prefix, for example `on pages
  (s3://nteract-celld-lab-621741996708/standalone/pages-live)`. Commands the
  script suggests, such as the `get` to reconcile with, carry the same
  `--target` and `--ssh-host`.
- **Five-minute cache.** Each Worker isolate reads the rule table at most once
  every five minutes. A change can take that long to apply, and different
  isolates can disagree until then. Poll `list_pages` for `quota.limit` rather
  than expecting it at once.

For anything other than quota rules, use `scripts/d1.mjs` ([Querying
D1](#querying-d1)).

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
  find out who else changed the rule, and decide from the current state. The
  message names the target and prints the exact `get` to run, with its
  `--target`.
- **Read-back failed.** The state is unknown. Run the printed
  `node scripts/quota-rules.mjs --target <target> get …` and reconcile before
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

## Querying D1

The lab targets are test deployments for the team, so operators can read and
write their D1 database by hand. `scripts/d1.mjs` sends SQL to the same fixed
remote command `quota-rules.mjs` uses: it checks the celld version, refuses to
run unless the database's cell already exists (celld creates an empty database
for an id it hasn't seen), and runs `celld d1 execute` as the service user,
through the database's live owner, in one transaction.

```bash
node scripts/d1.mjs --target pages "SELECT name FROM sqlite_master WHERE type = 'table'"
node scripts/d1.mjs --target pages "SELECT owner, state, COUNT(*) AS n FROM pages_catalog_pages GROUP BY owner, state"
node scripts/d1.mjs --target page10 --file query.sql
echo "SELECT 1" | node scripts/d1.mjs --target pages -
```

`--target` is required, as for quota rules. Rows print one JSON object per line
on stdout; the database, target and storage prefix print on stderr.

- **The catalog tables are projections.** Each account's Catalog cell is
  authoritative; the Worker writes the `pages_catalog_*` rows from it, so an
  edit to a row can be overwritten. Change Pages through the Worker.
- **Auth lives here too.** `pages-next-auth` holds the OIDC sessions and OAuth
  grants, codes and tokens beside the catalog, quota and invitation tables.
  Deleting rows there signs people out or revokes agents.
- **A failed write may have committed.** celld can report an error for a write
  that landed, as in [After a failed write](#after-a-failed-write). Read the
  row back before running it again.

The production Cloudflare deployment will not allow this; these steps are for
the celld lab targets.

## Tunnel and DNS provisioning

This is first-publication setup for a new target, not a step to repeat for each
release. `deploy.mjs provision` runs between `install` and `publish`. It calls
the tunnel helper, then the DNS helper with the tunnel UUID the first step
reports. It inspects by default; `--apply` creates only what is absent and never
adopts, updates or deletes. Both steps are idempotent, so a rerun after a
partial failure picks up where the last one stopped.

```sh
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target pages provision
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target pages provision --apply
```

Inspection prints the tunnel and DNS state. Before the tunnel exists there is no
UUID to check DNS against, so `dns` is `null`. With `--apply` it prints the new
tunnel UUID and CNAME, never the tunnel secret or the token. The two helpers it
calls still run on their own:

```sh
node scripts/deployment/tunnel.mjs --target pages [--apply]
node scripts/deployment/dns.mjs --target pages TUNNEL_UUID [--apply]
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
  node scripts/deploy.mjs --target pages provision --apply
```

The tunnel step creates a locally managed tunnel named after the service
(`nteract-pages-live`). Cloudflare returns a tunnel secret only when it is set, so the
same run writes it over SSH to root-owned mode 0600 `/etc/nteract-pages-live/tunnel.json`
and writes the nonsecret receipt `/etc/nteract-pages-live/tunnel-provisioning.json`.
Both writes require the directory that installation created and refuse to
replace an existing file. The command prints the tunnel UUID, never the secret.
A tunnel that exists without credentials on the host must be deleted in
Cloudflare before retrying. The receipt has this form:

```json
{
  "schema": 1,
  "account_id": "1cfb529b94b3d6cde3aaf49d1d6ed5e6",
  "tunnel_id": "TUNNEL_UUID",
  "name": "nteract-pages-live",
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
Page10 serves Page9's route set on its own hostname and listener, plus Sift's
WASM route. Its only predecessor is its own config without that route; the
publisher refuses any other installation receipt, including Page9's earlier
ones. The
route migrations below are Page9's history; Page10 starts at the end of them.
Pages serves Page10's route set on `pages.runtimed.run` and `127.0.0.1:9481`,
with the same single predecessor, and refuses Page10's installation receipts.

All three admit the viewer's content-hashed chunks, `/chunks/` followed by
eight base32 characters and `.js`. `build-receipt.json` maps each chunk to the
sha256 of its bytes in `viewer_chunks`. `prepare` stages exactly those chunks,
checks each one's bytes against its digest first, and refuses a changed chunk or
a `public/chunks` directory that holds any other file.

The shell's own files are hashed the same way: `app-<hash>.js`,
`app-<hash>.css`, `theme-<hash>.js`, `mermaid-<hash>.js`,
`automerge-<hash>.wasm`, `subduction-<hash>.wasm` and `sift-<hash>.wasm`. All
three admit each name with its own extension only. `viewer_assets` in the
receipt maps each to its sha256, and the name's hash must be the first 40 bits
of that digest. `prepare` stages exactly those seven files, checks their bytes
first, and refuses any other file of that shape in `public`.

The receipt's `files` maps every file the release carries, except
`build-receipt.json` itself, to its sha256: `index.js`, both WASM modules,
`wrangler.json`, `public/index.html`, `public/connect.js`, `public/_headers`,
and the hashed chunks and shell assets above. Staging refuses a receipt whose
`files` lists anything else or leaves one out, and a file whose bytes changed
since the build. The gate workflow's `release` job builds from a clean
checkout, stages the bundle this way, and uploads it as the `pages-release`
artifact.

Page10 and Pages admit `sift-<hash>.wasm` through their own route group, which
Page9 never had. Each publisher migrates only from its config without that
group, so the first release with Sift tables hands off that target's connector
once; later releases are no-ops.

All three admit Project links: `/project/<id>` and the older `/s/<id>`, where the
ID is `prj_` or `sp_` followed by a lowercase v4 UUID, with an optional
trailing slash. These are the paths `shared/routes.mjs` opens as a Project;
the viewer rewrites `/s/<id>` to `/project/<id>`. Page9's publisher migrates only
from its hashed-asset config to this one, so an older installation must
publish the hashed-asset release first.

All three admit the viewer's index routes, `/projects` and `/pages`, as exact
paths with an optional trailing slash. `/pages` keeps its search in `?q=`;
ingress matches the path only. These are the paths `shared/routes.mjs` opens
as index routes. Page9's publisher migrates only from its Project-link config
to this one, so an older installation must publish the Project-link release
first.

The OIDC client must allow `https://<hostname>/oidc` as a redirect URI before
sign-in works on a new target. For Pages, add
`https://pages.runtimed.run/oidc` to client
`1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0`. That change is made in the identity
provider; no helper here does it.

### Connector handoff

Page10 and Pages run their tunnel on two connector units, slots `a` and `b`
(`cloudflared-page10-a.service`, `cloudflared-page10-b.service`, and the same
with `pages-live` for Pages). One is live. Cloudflare balances a tunnel's
traffic across every connector it holds, so two connectors can serve at once.

cloudflared reads its ingress only at startup. Restarting a lone connector to
load new routes leaves the edge with no origin: on SIGTERM cloudflared
unregisters every edge connection at once, then waits out its grace period
(30 s by default) before it exits, and systemd starts the new process only
after that. The edge answers 530 the whole time (#4791). So publication never
stops the last connector. When the routes on disk differ from the ones the
live slot started with, it:

1. Renames the validated config into place. The live slot keeps its old routes
   in memory.
2. Starts the idle slot. Each slot is `Type=notify`, and cloudflared reports
   ready once its first edge connection registers.
3. Polls the slot's metrics listener, `http://<metrics>/ready`, until it
   answers 200 with all four of cloudflared's default edge connections
   (30 tries, 1 s apart). If the tries run out with two or three, the slot
   counts as ready: one lost connection still leaves an origin, and one
   degraded edge location shouldn't block a deploy. Fewer than two fails the
   handoff.
4. Enables the slot, then keeps both connectors up for 5 s.
5. Checks once more that the new slot runs and holds at least two
   connections, then stops and disables the old unit. Slots run with
   `--grace-period 10s`, so a stop finishes requests in flight within 10 s.

`/etc/<service>/tunnel-connector.json` records which unit is live and which
step is in flight (`starting`, `stopping`, `reverting`). The record is written
before each step, so a retry resumes that step and never repeats a reported one.
A resumed step checks the units first. If the new slot died before the old
unit stopped, it starts again while the old one serves. If the old unit died,
a running new slot is used as it is rather than restarted, since it is then
the only connector.
[connector-slots.mjs](scripts/deployment/connector-slots.mjs) holds the
transitions, and its tests cover every state and event.

If the new slot never becomes ready, publication stops it, restores the old
config and installation receipt, and exits with the error. The old connector
never stopped, so nothing restarts; if it died meanwhile, publication starts it
again after the old config is back. While both connectors run, a request can
reach either one: for those few seconds a new route can still answer 404 from
the old connector's catch-all.

Releases before slots ran one unit per target, `cloudflared-page10.service` and
`cloudflared-pages-live.service`. The first publication from this release takes
that unit as live and hands off to slot `a` the same way, with or without a
route change. The old unit's file stays in `/etc/systemd/system`, stopped and
disabled. A record that is missing while a slot runs, a record that doesn't
parse, or a slot unit file with other bytes stops publication before it writes
anything; inspect both slots with `systemctl status` before fixing it by hand. Publishing a release from before
slots onto a migrated target is refused, because it doesn't know the slot
receipt; app rollback with `install` never publishes.

To check a route-changing publish, probe health once a second from outside the
host while `publish` runs, and confirm every sample is 200:

```sh
while :; do
  printf '%s %s\n' "$(date -u +%T)" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 https://pages.runtimed.run/health)"
  sleep 1
done
```

The publish result names the live unit (`service`, `connectorSlot`) and says
whether a handoff ran (`connectorHandoff`). On the host,
`journalctl -u cloudflared-pages-live-a.service -u cloudflared-pages-live-b.service`
shows the new slot registering its connections before the old one logs
`Initiating graceful shutdown`.

## Telemetry

Service units enable `CELLD_OTEL=1` and `CELLD_OTEL_RETENTION=30d` with celld's
five-minute/5 MiB batching defaults. Page8 through Page10 and Pages also set
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
Usage events are `pages.usage.v1` JSON log lines from
[worker/usage.mjs](worker/usage.mjs), with principal, surface, driver, agent,
client and model:

- `mcp.initialize` on `/mcp`.
- `tool.call` for each tool call on `/mcp` (surface `mcp`) and `/api/tools`
  (surface `http-tools`, which includes the browser UI's own calls with
  driver `Browser`). MCP resource lists and reads are `tool.call` with
  `kind: "resource"`.
- `page.create` once per created Page: from `create_page` on either tool
  surface, and from browser registration on `/api/pages/register` (surface
  `browser-sync`). A retry that replays a stored receipt records none.
- `sync.open` once per browser sync connection, after the admission decision:
  `admitted: true` after the connection joins the Page, or `admitted: false`
  with the refusal reason as `outcome`. `sync.close` follows only an admitted
  session, with its duration as `latency_ms`.

They inherit the 30-day log retention. celld 0.6.3 did not export lines still
buffered at shutdown in a local OTLP run, so expect a restart to drop up to
one flush interval of events. A line the Worker fails to build or write is
counted, and the next line carries the count as `dropped`.
[scripts/usage-report.sql](scripts/usage-report.sql) summarizes them with
duckdb straight from the log Parquet.

Pages on plain Automerge sync add two lines from
[worker/plain-sync-log.mjs](worker/plain-sync-log.mjs), with the Page id but
no principal: `page.sync_refused` for a browser frame the host refused
(`reason`, and for a fatal refusal the close `code`, `status` and `close`;
repeats on one connection, including frames refused after its close, are
counted into one line once it has nothing left running), and
`page.sync_rounds`, a per-connection summary of the time from a frame's
arrival to its ack for frames that stored changes (`latency_ms_sum`,
`latency_ms_max`, `wait_ms_sum` and `latency_ms_buckets` by inclusive upper
bound), every 256 rounds and at close.
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
public `/mcp` endpoint and asset routes of each target, from outside the
Worker. It copies the Project's content, each Page's title and Markdown body,
their images and dataframes with their bytes, the Page tree and sibling order.
It does not copy comments, sharing, Trash or history.

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
use an API key for anything that runs unattended. Only an API key can use the
asset routes. Export with an OAuth token skips dataframe bytes, says so, and
those dataframes import as links. Import with an OAuth token refuses a bundle
that carries bytes before it writes anything; use an API key, or delete the
bundle's `assets` to import those dataframes as links. Only the source Project's owner can
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
  "version": 5,
  "bundle_id": "<uuid>",
  "source": { "origin": "https://page9.runtimed.run", "project_id": "prj_…", "document_id": "…" },
  "exported_at": "2026-11-01T00:00:00.000Z",
  "project": {
    "title": "…",
    "description": "…",
    "content": {
      "source_document_id": "…",
      "title": "…",
      "markdown": "…",
      "preserved_markdown": false,
      "private_images": [],
      "images": [],
      "comment_threads": 0
    }
  },
  "pages": [
    {
      "source_page_id": "…",
      "parent_source_id": null,
      "position": "a0",
      "title": "…",
      "markdown": "…",
      "blocks": ["…", "…"],
      "preserved_markdown": false,
      "private_images": [],
      "images": [],
      "dataframes": [{ "asset_id": "<sha256>", "src": "/api/pages/…/assets/<sha256>", "media_type": "application/vnd.apache.parquet", "title": "…" }],
      "comment_threads": 0
    }
  ],
  "assets": { "<sha256>": { "media_type": "application/vnd.apache.parquet", "size": 1234, "data": "<base64>" } }
}
```

`project.content` is the Project's content document, read on the source with
`read_page {project_id}` and named by `source.document_id` (the two must agree).
It has the same body fields as a Page entry and no placement. `pages` holds the
Page tree only, in tree order: each top-level Page (`parent_source_id: null`)
with its subtree depth first, siblings by source position, so parents always
come before children. Version 5 is the only version this tool reads. Bundles
from before it described the content as a Page flagged at the root; import
refuses them (`bundle_version_unsupported`) without reading them. Export the
Project again from a source running the current Pages. A source whose
`get_project` returns no `document_id` is refused the same way
(`source_unsupported`), as is a target whose `create_project` returns none
(`target_unsupported`).
`markdown` is the body: the Page's blocks joined by a blank line. `blocks`
appears only when a Page has more than one block. Each block is written
separately. A Page10 target refuses math and HTML with `unsupported_markdown`,
so import writes such a block as the literal text it reads as, as the
target's literal Markdown import would. If you edit a Page's
`markdown`, edit `blocks` to match or delete it; import refuses a mismatch.

`dataframes` lists a Page's dataframes from its outline, and `assets` holds each
one's bytes once, checked against its SHA-256 `asset_id` on export and again on
import. Import stores the bytes on the target Page (the same content gets the
same `asset_id`), then writes each dataframe whose read-back line stands alone
as its own block with `insert_node`. A dataframe inside a block splits that
block there; one inside a quote or list stays a link. Import never rewrites a
block holding a dataframe, so rerunning over a body an earlier run wrote
converges. Before its first write, import asks the target's tool list for
`insert_node` and refuses a target without it. The client sends its credential
only to `/api/pages/<id>/assets/<sha256>` paths on the target's own origin; a
dataframe whose `src` isn't one is skipped. A dataframe whose asset is missing on
the source, or one inside a quote or list, imports as a link and is reported in
`dataframes_not_copied`. A bundle carries at most 256 MiB of asset bytes; export
stops with a message past that.

The report lists Pages with `preserved_markdown` (the source stored preserved
blocks or non-Markdown blocks; check that they read as intended),
Pages with `private_images` (their
`/api/pages/<id>/assets/<sha256>` references point at the source Page's assets
and will not load on the target), `dataframes_not_copied` (dataframes the bundle
has no bytes for), comment threads that stay behind, and links to source Pages
outside the Project.

### Import

```sh
node scripts/project-transfer.mjs import --bundle guide.bundle.json --dry-run
PAGES_TARGET_TOKEN_FILE=~/.config/pages/anaconda-api-key \
  node scripts/project-transfer.mjs import \
  --target https://pages.runtimed.run \
  --bundle guide.bundle.json
```

Moving Page10's Projects to Pages is one export from
`https://page10.runtimed.run` and one import into `https://pages.runtimed.run`
per Project, run by each Project's owner.

`--dry-run` checks the bundle and prints where each Page lands without a
network call. Import compares normalized origins and refuses the bundle's own
source, however it is spelled (case, trailing slash, explicit default port). It
runs in this order:

1. `create_project` with the bundle's title and description. Its content
   document (`document_id` in the result) is the source content's counterpart:
   import fills it in through `project_id` and never creates a Page for it.
2. `create_page` for every Page in bundle order: a top-level Page with
   `project_id` alone, so it lands with `parent_id: null`; any other by
   `parent_id`. `targetPlacement` is the only function that decides this. New
   Pages append after their siblings, so bundle order is sibling order.
3. After every Page exists, one guarded `edit_page` per document that needs it:
   the content's title and body, addressed by `project_id` (its assets upload to
   `/api/pages/<document_id>/assets`, which the content's asset URLs name), the
   remaining blocks of a multi-block Page, images, dataframes and internal
   links. A source link to the content document's own `/p/<document_id>` URL
   rewrites to the target's. Source links `/p/<id>`, `/?page=<id>`, `/project/<id>` and
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
   parent (`null` for the top level), in source order, that the content
   document is not listed as a Page, and that `get_project` still names the
   `document_id` the content was written to. Import exits 1 if not.

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
  create's title under its parent (or at the recorded Project's top level),
  or Projects with its title, each with its ID, `created_at` and URL, oldest
  first. Open them before choosing. The content document is never a candidate.
- `--adopt ID` records one candidate and continues. It refuses an ID that is
  not under the recorded parent or at the recorded top level, has another
  title, already maps to a bundle document, or was created before
  `requested_at`, allowing two minutes of clock skew (`ADOPT_CLOCK_SKEW_MS`).
  An adopted Project must return a `document_id`.
- `--accept-missing` sends the create again with a new key. Use it when the
  target has no such Page.

An expired body edit needs none of these: the run rereads the Page and writes
its whole body again, which gives the same result whether or not the edit
applied.
