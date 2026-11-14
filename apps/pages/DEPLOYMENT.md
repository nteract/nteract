# Pages deployment

The deployment helpers know four isolated celld targets: **Pages**
(`pages.runtimed.run`), **Page10**, **Pages2** (`page2.runtimed.run`, on its
own host, lab2) and **Page11** (`page11.runtimed.run`, also on lab2).
[profiles.mjs](scripts/deployment/profiles.mjs) lists the profiles, and the
deployment helpers reject any other target name.

A build of `main` reads `pages.page` format 3 and `pages.comments` format 2,
and only Page10 takes it ([Document formats](#document-formats)). Pages, Pages2 and Page11 hold format 1
documents. They take a build of the maintenance branch cut from the
`pages-format-1` tag.

A release that would break existing clients goes to a fresh target instead of
carrying compatibility code. Deployment never copies data between targets.

| Target | Rule ([DIRECTION.md](DIRECTION.md#rules-for-the-work)) |
| --- | --- |
| pages | Holds documents people use. No reset and no migration from it. A format 1 release is built from the maintenance branch and promoted by hand; a build of `main` never deploys here |
| pages2, page10 | Demos. Reset freely; confirm the target a command addresses first |

These are the targets the helpers deploy. A deployment an operator makes from
the [release package](#deployment-neutral-release-package) is not one of them
and is not a demo: it can hold documents people use, so nothing here is
permission to reset it.

The procedures below promote a format 1 release to `pages`. Run them from a
checkout of the maintenance branch. They are not
permission to reset it or to deploy later formats to it; that work uses a
separate target. Confirm
application state, auth/catalog storage, deployment pointers, and routes are
isolated. Project transfer alone is not a complete archive of loose Pages,
comments, sharing, or history.

## Where state lives

A target stores state in two systems, and they do not play the same role.
Durable Objects and D1 are both durable. Being in D1 does not make a table an
index, and being a Durable Object does not make it the only copy of a fact.
Every table or key has one **normative** home: the place whose content is the
truth. Anything else that holds the same fact is a **projection** and can be
rebuilt from the normative home. Before you clear, repair, migrate or hand-edit
state, find out which kind it is.

| Kind | Where | What | If lost or wrong |
| --- | --- | --- | --- |
| Normative, in a Durable Object | Page host, per-account Catalog, Project (`Space`) objects | The Page's host record, access list, lifecycle, receipts and its documents; each account's `page/<id>`, `shared/<id>`, `trash/<id>` and `space/<id>` entries | Restore point only ([Restore points](#restore-points)) |
| Projection, in D1 | `pages_catalog_pages`, `pages_catalog_access`, `pages_catalog_spaces`, `pages_catalog_accounts` | A copy of the Durable Object state above, written from it for listing and search | Rebuild: reconciliation regenerates the rows from the Durable Objects. Never edit by hand |
| Normative, in D1 only | `page_tags` | Every Page's tags | Restore point only. Nothing can rebuild it |
| Normative, in D1 only | `pages_quota_rules`, `kilo_memberships`, `pages_project_invitations`, and the session and `pages_oauth_*` tables | Quota overrides, Kilo organization evidence, invitations, sign-in sessions and OAuth grants | Restore point. Sessions, grants and memberships also renew when the person signs in again; deleting session or grant rows signs people out or revokes agents |

For the first two rows the Durable Object is the source of truth and D1 is kept
in sync with it as a projection; D1 chooses listing candidates and never grants
access ([Catalog index](REFERENCE.md#catalog-index)). The `pages_catalog_`
prefix means projection: those tables share one migration chain, and the
reconcile, repair and cooling code may clear them because the Durable Objects
can regenerate their rows.

`page_tags` is the opposite case, by design. Tags have no real-time part and
are not in the document, so they need only ordinary request/response access:
a REST-style write and a searchable read. D1 is where they can be searched
across Pages, so the D1 table is their source of truth. There is **no Durable
Object that holds tags, and none is planned**: no Catalog entry, Page host
record or Automerge document carries a copy, and no projection step exists for
them. The Page host only decides whether a caller may edit; it keeps no tag
state. The table is named `page_tags`, without the `pages_catalog_` prefix, so
it is not mistaken for part of the index. It shares the D1 database and the
`PAGES_CATALOG_INDEX` gate with the projection tables, but not their migration
chain: its schema versions are in their own table, `page_tags_schema`
(`PAGE_TAGS_MIGRATIONS`), and `pages_catalog_schema` records only the projection. That gate controls whether the
worker has the D1 binding; with it unset, tag writes and tag filters answer `tags_unavailable`
and the rows stay as they are. Nothing may clear or rewrite `page_tags` except
a Page's permanent deletion: the Page host deletes that Page's rows itself,
after the catalog tombstone and whether or not `PAGES_CATALOG_INDEX` is set (the
projection never touches them). Trash keeps them. Reconciliation, a migration that resets
`pages_catalog_accounts`, a cooled index and a dropped projection table leave
them alone.

Where `page_tags` is read together with the projection, the projection only
supplies candidates (a Page the caller can see) and the tag table decides
whether a candidate matches. See [Page tags](REFERENCE.md#page-tags).

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

It carries every Page10 flag, the Page quota default and D1 binding, and the
same celld 0.6.3 runtime and OIDC client. Like Page10, every Page syncs with
plain Automerge sync ([Stored forms and rollback rules](#stored-forms-and-rollback-rules)).
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

From `apps/pages`, after review, commit, and a fresh build:

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

### Promote production from the CI artifact

The gate's artifact is a build of `main`, which reads `pages.page` format 3.
`install` refuses it for `pages`, which holds format 1
([Document formats](#document-formats)). A format 1 fix is built locally from
the maintenance branch with the commands above. This section describes the
artifact path as `deploy.mjs` implements it.

Every green push to `main` uploads the gate's `pages-release` artifact. Page10
deploys from it, and its `build_id` equals a local build of the same commit.
Production can take the same bytes. Pick the gate run whose release Page10
qualified, then check that browser E2E passed for its SHA. From `apps/pages`, with
`gh` signed in:

```sh
git fetch origin main
node scripts/deploy.mjs --target pages plan
node scripts/deploy.mjs --target pages prepare --from-artifact GATE_RUN_ID --worktree
node scripts/deploy.mjs --target pages upload LOCAL_STAGE
node scripts/deploy.mjs --target pages install REMOTE_STAGE --apply
node scripts/deploy.mjs --target pages publish REMOTE_STAGE --apply
```

`--attempt N` names a rerun attempt; the default is the run's latest.

GitHub provenance is the trust root for the bytes. Before anything is written,
`prepare --from-artifact` uses `gh api --hostname github.com` to require:

- The run is `.github/workflows/authenticated-automerge-spike.yml` in
  `nteract/nteract` (repository and owner checked by id), a `push` to `main`,
  and green at that attempt. Its head SHA is the release's source.
- The run holds exactly one `pages-release` artifact. It is unexpired, at most
  64 MiB, and created while that attempt's `Pages release bundle` job ran
  successfully.

The artifact metadata is read again just before download and must keep the
same id, digest and size. The ZIP downloads to a temp file, and its sha256
must equal that digest before it is parsed. Extraction refuses symlinks,
absolute paths, `..` or `.git` segments, more than 64 entries, or more than
128 MiB. The file set must be exactly the receipt's `files` plus
`build-receipt.json`, and each file must match its sha256. The receipt must
name the run's SHA and a clean tree.

These follow the lab1 controller's provenance and archive checks; change both
together. The controller also requires allowlisted GitHub actors for the run.
This command has no actor check: the operator choosing the run replaces it.

The existing `prepare` then runs on a checkout at the run's SHA, so code and
source are the same commit. Its fingerprint check binds the receipt to that
source, as for a local build. Without `--worktree`, that is this checkout: it
must be clean, at the run's SHA, and have no `dist`; a failure after extraction
removes the `dist` it wrote. `--worktree` creates a detached worktree at
`.context/pages-promote/<sha>` and runs that worktree's own
`scripts/deploy.mjs prepare --from-artifact GATE_RUN_ID --attempt N`, which
checks the run and artifact again and does the download, extraction and
staging. The worktree has no `node_modules`, so `NODE_PATH` lends it this
checkout's TypeScript, which the fingerprint uses only to follow imports. If
that fails, the worktree is removed. Either way the gate SHA must already
contain `--from-artifact`; an older SHA's `deploy.mjs` refuses the arguments.
The handoff runs the worktree's `deploy.mjs` at this checkout's Pages path, so
the gate SHA must hold Pages at the same path. Promote a gate SHA from before
a directory move from a checkout that predates the move.

The stage manifest records the artifact as `release_artifact`: repository,
run, attempt, artifact id, digest, size, creation and expiry times, `build_id`,
receipt sha256, and `code_sha`, the commit whose scripts staged it. `prepare`
refuses a `release_artifact` whose `head_sha` or `code_sha` is not its HEAD. The
stage is the printed `prepared` path: `.context/pages-deploy/<sha>` of the
checkout that ran `prepare`, which with `--worktree` is inside the worktree.
Remove the worktree with `git worktree remove` after publishing.

This removes two constraints. Production no longer needs a build on an
operator's laptop. Production also no longer has to be promoted from Page10's
build directory on lab1 before the next Page10 deploy prunes it. The artifact
lasts 30 days, so promote within that window or rebuild locally.

## pages2 on lab2

The `pages2` profile is a fresh, empty target on its own host:

| Field | Value |
| --- | --- |
| Host | `lab2` (m7i.large, 8 GB) |
| Hostname | `page2.runtimed.run` |
| Service and user | `nteract-pages2` |
| Prefix | `standalone/pages2` in the lab fleet bucket |
| Listeners | `127.0.0.1:9482`, internal `127.0.0.1:19482` |
| Firewall | table `nteract_pages2`, mark `0x00080000` |
| Tunnel connectors | `cloudflared-pages2-a.service` (metrics `127.0.0.1:29482`) and `cloudflared-pages2-b.service` (`127.0.0.1:29492`), tunnel `nteract-pages2` |
| Frozen neighbors | none |

It carries every Pages flag, memory limit, Page quota default and D1 binding.
Every Page it creates uses plain Automerge sync, and `RECORD_STORAGE_HISTORY`
lists `automerge` for it. Its ports, table, mark and tunnel names differ from
every lab1 profile; `deployment.test.mjs` checks that across all profiles.

The D1 binding is Pages' `AUTH_D1` (`pages-next-auth`). Nothing needs creating
by hand: celld keeps the database under `standalone/pages2` and creates it
empty on first use, so pages2 has its own sessions, OAuth grants and quota
rules. `quota-rules.mjs` and `d1.mjs` refuse to run until that first use has
created the cell; one sign-in is enough.

lab2 runs no shared cloudflared connector. The profile says so with
`sharedTunnel: false`, and publication then checks that
`/etc/cloudflared/config.yml` stays absent. If one appears, publication treats
it like lab1's: a different tunnel ID, unchanged during the run.

### Before the first install

1. Provision the host with the sandbox's `provision-remote lab2`, and add lab2
   to the `celld-lab` `node_hosts` so its instance role can read and write the
   fleet bucket. Operator SSH must reach `lab2` with sudo.
2. Install `/usr/local/bin/celld-v0.6.3` (the pinned sha256 in
   [profiles.mjs](scripts/deployment/profiles.mjs)), `node`,
   `/usr/local/bin/aws`, `nft`, `curl` and `/usr/bin/cloudflared` on lab2.
3. Have a Cloudflare account token for `1cfb529b94b3d6cde3aaf49d1d6ed5e6` with
   Tunnel edit and DNS edit on `runtimed.run`, the same token as the lab1
   targets.
4. Nothing on the identity provider: OIDC client
   `1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0` accepts redirect URIs under
   `*.runtimed.run`, which covers `https://page2.runtimed.run/oidc`.

### Deploy

From `apps/pages`, after review, commit, and a fresh build:

```sh
node scripts/deploy.mjs --target pages2 plan
node scripts/deploy.mjs --target pages2 prepare
node scripts/deploy.mjs --target pages2 upload LOCAL_STAGE
node scripts/deploy.mjs --target pages2 install REMOTE_STAGE --apply
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target pages2 provision            # inspect
CLOUDFLARE_API_TOKEN=... node scripts/deploy.mjs --target pages2 provision --apply    # first publication only
node scripts/deploy.mjs --target pages2 publish REMOTE_STAGE --apply
```

`install` refuses a non-empty `standalone/pages2` prefix, an occupied
listener, table or mark, and any existing `nteract-pages2` path or user.

### Smoke checks

```sh
curl -fsS https://page2.runtimed.run/health                        # {"ok":true,"prototype":"pages-celld-native",...}
curl -s -o /dev/null -w '%{http_code}\n' https://page2.runtimed.run/whoami   # 401 without a session
```

Then sign in at `https://page2.runtimed.run/` in a browser, create a Page, and
check `/whoami` from that session returns the account.

## Page10 release

The allowlisted profile owns `page10.runtimed.run`, service `nteract-page10`,
listeners `127.0.0.1:9480` / `127.0.0.1:19480`, and the `standalone/page10`
prefix in the lab1 fleet bucket. It enables
lossless cleanup with `CELLD_DURABILITY=bucket`, sharing,
OAuth, the catalog index, and the hashed-asset, Project-link and index routes.
It uses production Anaconda verification.

From `apps/pages`, after review, commit, and a fresh build:

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
is `0x00200000` and Pages' is `0x00100000`. The installer checks
ownership and resource conflicts, preserves Durable Object bindings/migrations
and persistent data, and touches only the selected service. Installation and
publication require SSH and sudo on the target's host (lab1, or lab2 for pages2).

Each installation copies `firewall.mjs` and `profiles.mjs` into its own
`/opt/<service>`, and its unit's `ExecStartPre` runs that copy. A service keeps
the copy of the release that installed it, so it restarts the same way until its
next install.

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

The prefix holds the Durable Object storage and the celld D1 database
(`pages-next-auth`), so one restore point covers both, and restoring one
returns them to the same moment. That includes the normative D1 tables, `page_tags`
among them: tags set after the restore point are gone, and no other source can
rebuild them. The projection tables come back as of that moment too, and
reconciliation repairs any drift from the Durable Objects. Take one before a release that changes storage. A release that changes only the
app does not need one: it rolls back by moving the fleet pointer to the previous
release ([When a wait times out](#when-a-wait-times-out)). To restore, stop the service on
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
older viewers or API clients (see [Build updates](REFERENCE.md#build-updates)). A
rollback publishes a different build id too, so open tabs see the banner again.

A rollback build must open plain Automerge Pages; see [Rollback and Page
record storage](#rollback-and-page-record-storage).

Every profile sets `PAGES_CATALOG_INDEX=1`. Changing this epoch label starts
account reconciliation on the next listing. Reconciliation may take several
listings. Unsetting the variable turns the index off, and listings read Catalog
entries directly. It also takes away the D1 binding that tags use: tag writes and
tag filters answer 503 `tags_unavailable` until it is set again. The `page_tags`
rows are untouched, because they are the only record of tags and the Catalog
entries hold none.

The D1 catalog index (`PAGES_CATALOG_INDEX`) is additive: Catalog entries keep
their keys and shape, and older builds ignore the `pages_catalog_*` projection
tables. After a rollback, accounts repair their projection within six hours of
their next listing, or immediately when the `PAGES_CATALOG_INDEX` value changes.
That repair rebuilds projection rows only; it never touches `page_tags`, which is
not a projection ([Where state lives](#where-state-lives)). Index migrations run
lazily on first use and must stay additive so a rollback build keeps working
against the newer schema. Listing cursors are sealed with a key derived from the
active session key and expire after 24 hours; a cursor opens under any key in
the keyring (see [Session key rotation](#session-key-rotation)). Migration 2 adds per-principal title snapshots and clears the
reconcile markers, so each account rebuilds its rows on its next listings. Migration 3
adds `lifecycle_revision` to Page rows; older builds ignore it. `page_tags` is not
part of that chain: it is the normative record of Page tags, with its own `page_tags_schema` version table, and the tag migration only adds. A pre-release build
recorded the table as catalog migration 9; a database that did keeps its rows, because
the tag migration is `CREATE ... IF NOT EXISTS`, and the catalog chain skips a recorded
version 9 it no longer lists. Older builds ignore the table, and
its rows persist across a rollback. A build from before tags does not delete a Page's tags
when it deletes the Page, so a Page deleted by such a build leaves orphan rows. They are
invisible (a listing starts from the caller's access rows, and a deleted Page has none) and
harmless. Lifecycle state
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

Rollback past #4712. Builds before #4712 can't replay a `move_page` receipt
for a request with `parent_id: null`. The move already landed, so after such a
rollback a client should read or list the Page instead of retrying the move.

### Rollback and Page record storage

A Page's host record names its record storage. This build opens only
`automerge` (plain Automerge sync) and refuses any other mode with
"Unsupported Page record storage mode", except on a deleted Page, which serves
nothing. Builds before a2c9d5dde don't know `automerge`, so a target that holds
plain Automerge Pages can't run them.

Each build receipt lists the modes its Worker opens as `record_storage`
(`shared/record-storage.mjs`); the release manifest carries the receipt. A
receipt without the list counts as opening only the Subduction modes, which
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
`scripts/deployment/profiles.mjs` lists it, or a release installed on the host
was configured with that `PAGES_RECORD_STORAGE`. Page10 and Pages list
`automerge`.

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
the same floor.

### Projects and their storage identity

Storage names Projects as Spaces. Callers see
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

### Document formats

`TARGET_DOCUMENT_FORMATS` in [profiles.mjs](scripts/deployment/profiles.mjs)
names the format of each document type that a target holds. Install and
rollback refuse a release whose build receipt does not list that format under
`document_formats`.

| Target | `pages.page` | `pages.comments` |
| --- | --- | --- |
| page10 | 3 | 2 |
| pages, pages2, page11 | 1 | 1 |

A build of `main` reads `pages.page` format 3 and `pages.comments` format 2
only, so only page10 accepts it. The controller checks out the commit it
deploys and reads this table from it, so a commit that changes page10's
formats installs on page10 with no change on the host. The same check stops a
revert to a build that reads earlier formats.

The table is the operator's statement of what a target holds, and it gates
the release only. The Page host checks each Page's own record: a record
stores its documents' formats as `documentFormats`, from creation or
registration on. Discovery reports those formats, the socket requires them,
and a record in any format the running build doesn't write is refused with
`409 document_format_unsupported` on every document route while its owner can
still list, trash, restore and permanently delete it
([REFERENCE.md](REFERENCE.md#document-formats-in-the-host-record)).

A record without the stamp, or stamped with `pages.page` 2 and
`pages.comments` 1, is refused the same way. page10 is emptied for format 3,
since format 3 moves node ids ([DIRECTION.md](DIRECTION.md#rules-for-the-work)):
its owners delete its earlier Pages through the product, and a Page that
remains is refused one by one rather than opened. No command empties a
target.

### Stored forms and rollback rules

pages and page10 hold only the v1 stored forms: rich-text blocks, comments in
their own document, `comments_doc` on every live or trashed host record, plain
Automerge sync. The migrations that got them there are in
[archive/DEPLOYMENT-stored-form-migrations.md](archive/DEPLOYMENT-stored-form-migrations.md).

| Rule | Why |
| --- | --- |
| Don't restore a backup taken before 2026-11-05 onto a target running this build | It holds forms this build refuses with `409 stored_form_unsupported`; a live Page record without `comments_doc` fails at boot |
| Roll back only to a build that has #4884 | Earlier admission requires `body` on every comment message; this build writes none |
| Never revert #4884 on `main`; fix forward | page10 deploys `main` automatically |
| `MIN_VIEWER_PROTOCOL` is 3 | Earlier viewers write refused comment forms (`outdated_form`) and must reload |
| Subduction Pages are refused ("Unsupported Page record storage mode") | This build has no Subduction code |

Leftover records from the migrations (`host/comments-migration/*`, converted
Subduction records under `repo/`, `host/actor/`, `host/binding/`,
`host/signer`) stay until a purge deletes them. Nothing reads them. Purging a
Page whose record carries `recordStorageMigratedFrom` deletes its converted
Subduction records from the Page's own storage (`purgeConvertedRecords`). The
root-only `/etc/<service>/operator-secret` file is unused.

For a separately created v2 namespace, document its own format and rollback
floor. A reset permission alone does not establish that old data or receivers
are absent.

### Old PageRecords objects

The `PageRecords` class and `PAGE_RECORDS` binding are declared with an empty
class body (`worker/page-records.mjs`). No code calls the binding: purge
does not call a Page's `PageRecords` object, and no path reads, writes or
clears an object's storage. The operator sweep left both targets empty, and
no release-package build writes a `buffered` Page.

Removing the class needs a `deleted_classes` migration. celld 0.6.3 knows
`new_sqlite_classes`, `old_tag`, `new_tag` and `steps`, not `deleted_classes`,
and refuses `renamed_classes`. Until celld accepts it, the class stays and so
does the `v2 new_sqlite_classes: ["PageRecords"]` migration tag.

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

- **The `pages_catalog_*` tables are projections.** The Page host and each
  account's Catalog Durable Object are the source of truth; the Worker writes
  those rows from them, so an edit to a row can be overwritten. Change Pages
  through the Worker. See [Where state lives](#where-state-lives).
- **`page_tags` is not a projection.** It is the only copy of every Page's tags.
  A row you edit, or delete, stays that way, and nothing regenerates it. Change
  tags with `PUT` and `DELETE /api/pages/<page_id>/tags/<tag>`. Take a [restore point](#restore-points) before
  any hand edit.
- **Auth lives here too.** `pages-next-auth` holds the OIDC sessions and OAuth
  grants, codes and tokens beside the catalog projection, tags, quota and
  invitation tables. Those are normative like tags. Deleting rows there signs
  people out or revokes agents.
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
Public ingress allows application, auth, sharing, MCP, asset, card image, link
preview and sync routes, then ends in a catch-all 404. Internal Durable Object
routes stay private. The catch-all is the edge's: an empty 404 with no content
type, which the Worker never sees. A gateway route that ingress doesn't admit
works locally, where celld runs without a tunnel, and fails only through the
edge ([Gateway routes and the allowlist](#gateway-routes-and-the-allowlist)).
Page10 serves this route set on its own hostname and listener. Pages serves
the same set on `pages.runtimed.run` and `127.0.0.1:9481`. Each publisher
migrates only from an installation its own target's earlier release sealed, and
refuses another target's installation receipts.

Every target admits the viewer's content-hashed chunks, `/chunks/` followed by
eight base32 characters and `.js`. `build-receipt.json` maps each chunk to the
sha256 of its bytes in `viewer_chunks`. `prepare` stages exactly those chunks,
checks each one's bytes against its digest first, and refuses a changed chunk or
a `public/chunks` directory that holds any other file.

The shell's own files are hashed the same way: `app-<hash>.js`,
`app-<hash>.css`, `theme-<hash>.js`, `mermaid-<hash>.js`,
`automerge-<hash>.wasm`, `subduction-<hash>.wasm` and `sift-<hash>.wasm`. Every
target admits each name with its own extension only. `viewer_assets` in the
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

Page10 and Pages admit `sift-<hash>.wasm` through their own route group. Each publisher migrates only from its config without that
group, so the first release with Sift tables hands off that target's connector
once; later releases are no-ops.

Every target admits Project links: `/project/<id>` and the older `/s/<id>`, where the
ID is `prj_` or `sp_` followed by a lowercase v4 UUID, with an optional
trailing slash. These are the paths `shared/routes.mjs` opens as a Project;
the viewer rewrites `/s/<id>` to `/project/<id>`.

Every target admits the viewer's index routes, `/projects` and `/pages`, as exact
paths with an optional trailing slash. `/pages` keeps its search in `?q=`;
ingress matches the path only. These are the paths `shared/routes.mjs` opens
as index routes.

Page10, Pages and Pages2 admit the account routes (`accountPaths` in
[routes.mjs](scripts/deployment/routes.mjs)): `/api/auth/logout-all`,
`/api/auth/grants` and `/api/auth/grants/<handle>/revoke`, where a handle is
43 base64url characters. Each publisher migrates from its sealed config without
that group, by the same handoff as any route change: the next publish rewrites
`tunnel.yml` with the group added, starts the idle slot, waits for `/ready`,
stops the old slot and seals the new receipt. Units and every other route stay
byte-identical. Every older predecessor still migrates, straight to the new
config. A pending receipt from an interrupted publish before this release is
not recognized; the publisher stops and asks for inspection.

Page10, Pages and Pages2 also admit link previews, card images and Project
assets (`linkPreviewPaths`, `cardImagePaths` and `projectAssetPaths` in
[routes.mjs](scripts/deployment/routes.mjs), behind the profile flags
`linkPreviews`, `cardImages` and `projectAssets`):

- `/p/<uuid>/meta.json` and `/p/<uuid>/card.json`, and the same two files
  under `/project/<id>` with a `prj_` or `sp_` ID
  ([link-previews.mjs](worker/link-previews.mjs)). No trailing slash, and
  nothing under `/s/<id>`.
- `/api/pages/<uuid>/card-image`, which serves the stored hash and takes the
  owner's `PUT ?hash=&theme=` upload (ingress matches the path only), and
  `/api/pages/<uuid>/card-image/<sha256>-<light|dark>.<webp|png|jpg>`, the
  shape `CARD_IMAGE_FILE` in [card-images.mjs](worker/card-images.mjs) names.
- `/api/projects/<id>/assets` and `/api/projects/<id>/assets/<sha256>`: a
  Project's assets, which the gateway serves from its content document.

Every target also admits the REST routes (`restPaths` in
[routes.mjs](scripts/deployment/routes.mjs)), with no profile flag: `GET
/api/pages`, and `PUT` or `DELETE /api/pages/<uuid>/tags/<tag>`, where the tag is
one percent-encoded segment (`:` and `/` are sent as `%3A` and `%2F`).
cloudflared matches ingress rules against the decoded path, so the ingress
admits up to 192 characters of a tag's alphabet including `/`; the Worker
takes one raw segment and refuses a second. A target that has not published them answers 404 at the edge
to a tag change or a listing by REST; MCP and `/api/tools` are unaffected. The
publisher asks cloudflared where the listing, a plain tag and a tag with an
encoded `/` go before it starts a connector, and stops if one is not forwarded.
No request has crossed a live tunnel yet: confirm a `PUT` of `repo:org/name`
reaches the Worker on a target after its first publish.

IDs are lowercase v4 UUIDs, as in every other group. Until a target publishes
these routes, the edge refuses them: hover cards on Page links show "Couldn't
load a preview" and keep retrying, the library grid never shows a card image,
and the owner's tab never uploads one. Each publisher migrates from the
account-route config it sealed, by the same handoff as any route change; units
and every other route stay byte-identical, and every older predecessor still
migrates straight to the new config. A pending receipt from an interrupted
account-route publish is not recognized: finish that publish from its own
stage, then publish this one.

The OIDC client must allow `https://<hostname>/oidc` as a redirect URI before
sign-in works on a new target. For Pages, add
`https://pages.runtimed.run/oidc` to client
`1a90d36b-5b97-4ebb-a1bc-f3de7ddb70e0`. That change is made in the identity
provider; no helper here does it.

### Gateway routes and the allowlist

[tunnel-routes.test.mjs](scripts/tunnel-routes.test.mjs) holds a request for
every route the gateway in `worker/index.mjs` answers, and every viewer route
and shell file it serves from `ASSETS`, and checks that each live target's
ingress admits them. It also sends each request through the gateway to confirm
the route is really answered there, and lists paths kept off the tunnel on
purpose (`/internal/*`, `/state`, the loopback `/dev/oidc` issuer) and near
misses that must stay refused. A scan of the gateway's dispatch finds every
exact path, path regex and route handler. A new one fails the test until its
paths have samples there and a route group in routes.mjs, or are listed as
kept off.

After a publish that adds routes, check through the edge that the Worker
answers them. Without a session, each answers JSON:

```sh
id=08c583e5-d29e-4f1e-b06b-333965254e94
for path in /p/$id/meta.json /api/pages/$id/card-image /api/projects/prj_$id/assets; do
  curl -s -o /dev/null -w "$path %{http_code} %{content_type}\n" "https://pages.runtimed.run$path"
done   # 401 application/json each; an empty 404 is the edge refusing the path
```

### HTTPS and HSTS

Every public target is HTTPS-only. The hop from cloudflared to the celld
listener is plain HTTP, so the Worker sees `http:` in every request URL. It
reads the visitor's scheme from `CF-Visitor`, which the Cloudflare edge adds to
each proxied request and cloudflared passes through to celld and the Worker
([transport-security.mjs](worker/transport-security.mjs)):

| `CF-Visitor` scheme | Answer |
| --- | --- |
| `http` | `308` to `https:` on the `NOTEBOOK_CLOUD_PUBLIC_ORIGIN` host (the request's host when unset), path and query kept, before any routing. This covers every method and path, `/health`, `/api/*` and `/mcp` included. A WebSocket upgrade gets the same `308` and no socket. |
| `https` | Served, with `Strict-Transport-Security: max-age=31536000` |
| absent or malformed | Served as-is, without HSTS |

No route is exempt. The deploy helpers poll `/health` and `/state` on the
local listener, which carries no Cloudflare headers, and outside probes use
`https://`. The same goes for operator calls on the host such as
`curl -H 'Host: pages.runtimed.run' http://127.0.0.1:9481/...`, and for
`npm run dev` on localhost. `X-Forwarded-Proto` is not read: the gateway treats
it as untrusted client input.

HSTS has no `includeSubDomains` or `preload`. Other `runtimed.run` hosts are not
Pages', so this host does not pin them. The header is set per request, not in
`public/_headers`, because it depends on the visitor's scheme.

After an install or publish, check both answers through the edge:

```sh
curl -sI https://<host>/health | grep -i strict-transport-security   # must print the header
curl -sI http://<host>/health | grep -iE '^HTTP|^location'           # 308, location: https://<host>/health
```

If the HTTPS response has no `strict-transport-security`, the Worker did not
see `CF-Visitor` (for example, celld dropped it), so plain HTTP is not being
redirected either. With Always Use HTTPS on, the second check shows
Cloudflare's own redirect instead.

Cloudflare's **Always Use HTTPS** zone setting redirects at the edge before a
request reaches the tunnel. It complements the Worker redirect. It is a zone
setting an operator changes in the Cloudflare dashboard; no helper here sets it.

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

## Identity provider

A deployment signs people and agents in with Anaconda, unless
`PAGES_KILO_APP_URL` is set. That setting turns on the Kilo redirect sign-in
([worker/kilo-handoff.mjs](worker/kilo-handoff.mjs)) and also selects Kilo as
the identity provider ([identity-provider.mjs](identity-provider.mjs)).

A Kilo deployment needs two more settings, and refuses to sign anyone in
without them:

- `PAGES_KILO_AUDIENCE`, a plain variable: the name Kilo holds this deployment
  under, such as `pages-dev`. Pages sends it in place of its own address, and
  Kilo sends the browser back to the address it holds for that name.
- `PAGES_KILO_EXCHANGE_SECRET`, a Worker secret of 32 characters or more: what
  Kilo checks when Pages trades a sign-in code or an agent token.

A Kilo deployment differs in three ways:

- It has no API keys. The agent guide (`/llms.txt`) and the connect page
  (`/connect`) describe OAuth, and agents connect their MCP client by OAuth.
  A Kilo agent without a browser sends a Kilo agent token instead (below).
- A bearer that does not have the form of a credential Pages issues (an OAuth
  access token or an upload capability) and is not a Kilo agent token for this
  deployment is refused with `api_keys_unsupported` (401) before the Worker
  makes any outbound request. A Kilo credential is never forwarded anywhere
  but Kilo's own exchange.
- A person can accept an email invitation only when Kilo vouches for their
  address. Kilo's exchange answers `{"user": {"id", "name", "verified_email"?}}`
  and sends `verified_email`, the account's primary address, only when it
  holds proof the account controls it. Pages keeps it only when an invitation
  could name it (the check inviting by email uses); any other value is
  treated as absent and the sign-in still succeeds. The exception is size:
  Pages refuses any exchange answer over 16 KiB before reading a field, so an
  answer made that large by `verified_email` fails the browser sign-in
  (`kilo_protocol_error`) and the token exchange (503
  `sign_in_unavailable`). Without a usable address, invitations by email
  can't be accepted and email quota rules don't apply.

A browser session keeps the address as signed email proof, not as the
address. The proof is good for 6 hours from sign-in
(`NOTEBOOK_CLOUD_IDENTITY_PROOF_MAX_AGE_SECONDS`), so a Kilo session claims
invitations for the first 6 of its 8 hours; after that the person signs in
again.

Claiming an invitation keeps the invitation's address with the claimant. The
member entry stores the principal, the display name and that address, and
the owner sees the three together in Page sharing, Project sharing and the
list of collaborators who lose access when a Page or Project is deleted. That
entry stays after the proof expires and after the session ends, until the
owner removes the member; it is the address the owner invited, as Kilo
verified it at the claim.

An OAuth client connected from that session keeps the same proof, and
claims invitations until 6 hours after the sign-in that approved it, whatever
its own grant's lifetime. Quota rules read the proof at its own verification
time, so they apply for the session's whole life and the grant's. A Kilo
agent token (below) carries the address for its lease and claims
invitations with it; quota rules read only API-key addresses and browser or
OAuth proof, so a Kilo token gets the default quota. Company-domain view
stays off on a Kilo deployment whatever Kilo sends: the Kilo provider
reviews no company domains.

### Kilo agent tokens

Kilo's agent harness (a CLI or cloud agent with a Kilo session and no browser)
gets a token from Kilo (`POST /api/auth/resource-token` with this deployment's
audience) and sends it as `Authorization: Bearer <token>`. The token is an
HS256 JWT that Kilo signs with a key Pages never holds. It lives five minutes,
is at most 4,096 characters, and its claims are `version`, `kiloUserId`, `env`,
`aud` (the deployment's audience), `iat`, `exp`,
`tokenPurpose: "delegated-workload"` and `credentialExchange: false`.

A deployment needs nothing new: the same three `PAGES_KILO_*` settings. Pages
treats a bearer as a Kilo token when it is a three-part JWT whose unverified
`aud` is `PAGES_KILO_AUDIENCE` and whose `tokenPurpose` is
`delegated-workload` ([worker/kilo-token.mjs](worker/kilo-token.mjs)). Those
claims only choose the check; they never become identity. Pages trades the
token at Kilo's exchange, the same call the browser sign-in makes:

```http
POST <PAGES_KILO_APP_URL>/api/pages-auth/exchange
Authorization: Bearer <PAGES_KILO_EXCHANGE_SECRET>
Content-Type: application/json

{"token": "<token>", "audience": "<PAGES_KILO_AUDIENCE>"}
```

Kilo answers `200 {"user": {"id", "name", "verified_email"?}, "organizations": [...]}`,
and the person is `<PAGES_KILO_PRINCIPAL_NAMESPACE or user:kilo>:<user.id>`, the
principal the browser sign-in gives them. The call times out after 10 seconds.
The token reaches `/mcp`, `/api/tools`, `GET /whoami` and the internal hops
they forward to, with the reach an API key has there. Every other route
refuses it with 403 before Kilo is asked.

| Kilo's answer | Caller gets |
| --- | --- |
| `400` with `{"error":"invalid_token"}` | 401 `invalid_kilo_token`: mint a new token for this deployment. Kept five minutes |
| `403` with `{"error":"account_unavailable"}` | 403 `account_unavailable`. Kept 30 seconds |
| `401 invalid_client` (wrong secret or audience) | 503 `sign_in_unavailable`, `retryable: true` |
| Anything else: `400 invalid_request`, a 403 with another body, 404, 408, 429, 5xx, a 3xx, a timeout, a body over 16 KB, or a 200 that isn't the documented shape | 503 `sign_in_unavailable`, `retryable: true` |

Pages reads Kilo's error body, within the 16 KB limit, only to pick among
these rows; the caller and the logs never see it. A 503 is never kept, so the
next request with the token asks Kilo again. The browser code exchange keeps
its own mapping by status alone.

Each refusal and each request turned away by a bound below logs one
`kilo_token.refused` auth line whose `reason` names the cause, never the
token or the secret. A 503 also produces the gateway's generic
`request.failed` line, which carries only the code `sign_in_unavailable`.

Each Worker isolate leases an accepted token, keyed by its SHA-256, so a
token costs one exchange per isolate rather than one per call
([worker/kilo-token-lease.mjs](worker/kilo-token-lease.mjs)). Pages can't
read Kilo's clock, so the lease ends at the earliest of the token's `exp` by
Pages' clock less 30 seconds, the token's whole lifetime (`exp - iat`) after
the exchange was sent, and 15 minutes. A token Kilo accepts that gets no
lease, because it is inside that 30-second allowance or its `iat` and `exp`
aren't whole seconds at most 15 minutes apart, still authorizes its own
request, with an identity valid for 30 seconds from Kilo's answer; the next
request exchanges it again. One token's exchanges run one at a time, so
concurrent requests with a token that gets a lease share one exchange; a
token that gets no lease is exchanged by each request in turn. When an
exchange fails transiently, only the request that made it gets the 503; the
others use what the next exchange finds. Every request answers within 15
seconds of arriving. An exchange whose request gave up keeps running, and its
answer still decides what the next request finds: a lease, a kept refusal,
or nothing.

Kilo's explicit refusal of the token is kept for repeats of that token:
`invalid_kilo_token` for five minutes, since an invalid token can't become
valid, and `account_unavailable` for 30 seconds. Each isolate starts no new
exchange while 8 are in flight; an exchange counts from its start until it
answers, or for 15 seconds from its start if it never does, whether or not
the request that started it is still waiting. Each isolate keeps at most
1,000 tokens. Kept refusals leave first, then entries whose time is over; a
running exchange or a live lease never leaves early. Past either bound a new
token gets 503 `sign_in_unavailable` without an exchange, and tokens already
leased keep working. So eight forged, well-shaped tokens can hold every
exchange slot of an isolate for up to the 10-second exchange timeout each;
while they do, a new legitimate token gets a retryable 503 there, and tokens
already leased keep working.

An upload capability issued under a Kilo token ends at the earlier of that
identity's validity (the lease end, or 30 seconds after Kilo's answer for an
unleased token) and the upload's own lifetime.

The lease is the limit of this design: an account Kilo blocks keeps working
here until its lease ends. A lease can outlast the token by the clock
difference between Pages and Kilo, and never by more than the token's whole
lifetime.

### Kilo organizations

Both exchanges, the browser code and the agent token, answer with the
account's `organizations`. Pages keeps each entry's `id` and `name` (Kilo's
`role` is not read), at most 50, and drops malformed entries and repeated ids;
an answer without a usable list counts as no organizations and never fails a
sign-in ([worker/kilo-exchange.mjs](worker/kilo-exchange.mjs)).

Every successful exchange writes the principal's membership record in D1
(`kilo_memberships`, migrated through `kilo_membership_schema`): the
organizations and `verified_at_ms`, when Pages sent that exchange, in
milliseconds by its own clock. One statement orders each write against the
stored record, so the newest answer wins whichever isolate received it: a
later answer replaces the record and an earlier one changes nothing. In the
same millisecond, an answer whose stored text equals the record's changes
nothing, and any other answer leaves the record with no organizations until
the next exchange: two different answers that close can't be ordered, so a
tie never adds one. `verified_at_ms` never moves back. That is one D1 write
per browser sign-in, and for an agent token at least one per exchange in each
isolate: requests that arrive together at the start of a lease each write the
same answer, which leaves the record as it is
([worker/kilo-membership.mjs](worker/kilo-membership.mjs)). Schema version 2
drops the table and creates it again with `verified_at_ms`: a version 1 row
was timed in seconds and can't be ordered by the millisecond, so it is gone
and that principal's next exchange writes a new one.

A sign-in whose write fails gets the retryable failure page (503,
`membership_unrecorded`) and no session. An agent request on a token answer
not yet recorded in its isolate writes it itself; no request waits on
another's write. A request whose write fails gets a retryable 503
`sign_in_unavailable`, and the next request writes again. Once one write of
an answer succeeds, later requests on it write nothing. No request goes on
over a record older than the answer it holds.

The record is evidence for 8 hours from `verified_at_ms`
(`KILO_MEMBERSHIP_SECONDS`), the length of a Kilo browser session. Every Kilo
identity reads it by principal, whichever credential it arrived with: the
browser cookie, a Pages OAuth access token, or a Kilo agent token. Each
organization becomes a lease that ends with the identity or the evidence,
whichever is first. Nothing is copied into a session or an OAuth grant, so an
agent connected by OAuth holds its person's organizations while that person's
evidence is fresh, and loses them at most 8 hours after the person's last Kilo
sign-in or agent-token exchange. Refreshing an OAuth token does not renew them.

An owner can share a Page with one organization they hold a lease for, as Can
view, Can comment or Can edit. Members who open the link get that role and are
not added to the Page's member list. Someone Kilo no longer lists keeps that
access until their evidence ends: up to 8 hours after their last exchange, or
sooner when a newer exchange no longer names the organization. Each isolate
caches a record for at most 30 seconds, so a request sees a new record at
most 30 seconds after the exchange that wrote it, and an open sync socket,
which re-authenticates every 15 seconds, at most 45 seconds after.

A Project's owner can share it with one organization the same way
(`acl.organizationAccess` on the Project record, set through
`manage_project_access`). Its members hold that role on the Project and on
every Page in it, through the Project as a member does, and only while both
their lease and the Page host's 15-second Project lease are current. Nobody
is added to the Project's members, and nothing is written on its Pages.
There is no member list to send discovery hints to, so a member who opens
the Project records an opened hint in their own Catalog
(`project-opened/<space_id>`, [worker/project-opened.mjs](worker/project-opened.mjs)),
apart from member hints. The list reads owned Projects, member hints and
opened hints, each Project once, and shows one only while the person can read
it. The owner sends members the Project's link. Writing an opened hint does
storage operations only: a re-open within a day writes nothing, and a Catalog
keeps the newest 200 by when they were written, so the oldest goes first. An
opened hint never counts against the 500 member hints and never refuses a
write. A member removed from a Project with an organization grant gets an
opened hint in place of their member hint. Deleting the Project or clearing
the grant sends nothing to the organization's members: their opened hints stay
hidden and age out. A Project with an organization grant is shared, so a Page
can't be moved across its boundary.

The auth log's `kilo_token.accepted` line carries how many organizations the
exchange reported (`organizations`). No organization id or name reaches a log.

### Company domains

An owner can share a Page with everyone who signs in with a verified email at
a company domain, as Can view, Can comment or Can edit. Two things allow a
domain, and a deployment needs both:

1. A reviewed entry in the identity provider's `companyDomains` list in
   [identity-provider.mjs](identity-provider.mjs). Adding one is a code change
   with its own review. Anaconda's list holds `anaconda.com`; Kilo's is empty,
   so a Kilo deployment has no company sharing whatever it sets.
2. `PAGES_COMPANY_VIEW_DOMAINS`, a plain variable: the comma-separated domains
   this deployment turns on, such as `anaconda.com`. A profile sets it with
   `companyViewDomains`. Spaces around an entry are ignored.

Every value, in the setting and in the reviewed lists, must be a lower-case
ASCII hostname of two or more labels and at most 253 characters, each label 1
to 63 letters, digits or inner hyphens (punycode `xn--` labels qualify). The
check refuses upper case, a wildcard (`*.example.com`), a trailing dot,
whitespace inside a value, a single label, a port or path, and an IP address
(a final label that is all digits or `0x` hex). A value that fails the check,
or that the reviewed list doesn't name, turns company sharing off for the
whole deployment: Pages offers no domain and grants nothing through a stored
one until the setting is fixed. A bad reviewed entry fails when
`identity-provider.mjs` loads, so it fails the tests, not a deployment
([worker/domain-access.mjs](worker/domain-access.mjs) `companyViewDomains`).

A reader proves a domain with a verified email: a browser or OAuth sign-in
counts for six hours, and an API key's account email until the provider lookup
behind it stops being current, at most 60 seconds from that lookup. An upload URL issued to a domain editor carries that lease and ends
with it. A domain can't be registered at runtime; the allowlist is
configuration.

## Outbound requests

The OAuth server for `/mcp` accepts every valid HTTPS client ID metadata URL.
Known client names are display labels, not an access list. All clients still
need valid metadata, a listed callback, PKCE S256, sign-in and consent.
`PAGES_OAUTH_ANY_CLIENT_DOCUMENT` is obsolete and has no effect.

Fetching metadata requires `PAGES_OAUTH_METADATA_EGRESS=public-https`. This is
an **operator assertion of a network boundary**, not a switch that creates
one. With it unset or any other value, new metadata-based authorizations
return 503 without making a request, for known and unknown clients alike.
Existing grants can still refresh and revoke without fetching metadata.
The fixed `pages-kilo` and `pages-chatgpt` clients do not fetch metadata.

The native installer can install nftables output rules for the dedicated service
UID before publishing to an active node, and again in `ExecStartPre` on every
start. It does **not** enable the boundary or metadata fetching automatically.
It reads the operator-owned `/etc/<service>/oauth-metadata-egress` file; only a regular,
root-owned file that is not group/world writable can select a phase. `prepared`
installs the local boundary while leaving metadata fetching disabled.
`public-https` installs the boundary and sets the Worker variable. A missing
file leaves fetching disabled and does not introduce HTTPS filtering; malformed
qualification stops installation before any writes. This marker is outside
release artifacts and is never created by the installer.

Those rules reject outbound TCP port 443 connections to private, loopback, link-local, shared-address,
reserved and multicast destinations. IPv6 permits global unicast only,
excluding special-use ranges and transition ranges. The decision applies to
actual packets after DNS resolution, including a changed DNS answer; there is
no DNS preflight followed by an unrestricted fetch. DNS, runtime instance
credentials on port 80, peer RPC, and replies to incoming connections keep
their existing paths. Private HTTPS identity providers or object stores are
therefore incompatible with public metadata egress on this service UID.

Roll out in two phases, including when upgrading an existing deployment:

1. A greenfield service must first complete an unqualified install to create
   its ownership record; do not pre-create its configuration directory.
   New metadata-based authorizations return 503, including ChatGPT, Codex and
   Claude; existing grants continue working. After confirming that the
   service does not depend on private HTTPS endpoints, create
   `/etc/<service>/oauth-metadata-egress` containing `prepared` (root-owned,
   mode 0600) and install the new firewall helper and startup hook on **every**
   serving node and on the image used to add future nodes.
2. Verify the network boundary on every node, including proxies and address
   translation. Then change the operator file to `public-https` and rerun
   install. This records that the whole fleet is qualified, not just this node. Removing the
   file and rerunning install disables new metadata-based authorizations.
   Existing egress rules are retained even with no marker: other nodes or
   in-flight requests may still be using an enabled release. Remove the rules
   manually only after metadata fetching is disabled throughout the fleet.

A fleet deployment pointer can be adopted without a restart. The installer
configures the local node only and cannot discover another node's firewall;
its release must never infer fleet qualification from that local success.
Custom deployments, including Cloudflare packages and local development, must enforce the equivalent
public-only HTTPS policy in their runtime or network before setting the value
in Wrangler vars or `.dev.vars`. Do not set it merely because URL validation
passes: a public DNS name can resolve to a private address. Private routing,
HTTPS proxies, NAT64, and destination translation must not route apparently
public HTTPS destinations into a private network. No unrestricted metadata
fetch fallback exists.

The Worker fetches only after sign-in, sends no cookies or authorization,
requires port 443, never follows redirects, and bounds time, bytes, cache
entries and concurrent fetches. Product names do not bypass any of these
checks. `node scripts/oauth-egress-smoke.mjs` uses a disposable Docker network
namespace to exercise the generated rules with real IPv4 and IPv6 sockets,
without modifying the host firewall. It proves the rule semantics, not the
network policy on a live deployment.

The installer must be updated with this build; copying the Worker
alone does not establish the egress boundary.

## Telemetry

Service units enable `CELLD_OTEL=1` and `CELLD_OTEL_RETENTION=30d` with celld's
five-minute/5 MiB batching defaults. Every profile also sets
`OTEL_TRACES_SAMPLER=always_on`. Requests reach it with a `traceparent` whose
sampled flag is clear. For a request with an unsampled parent, celld's default
`parentbased_always_on` sampler records nothing, including the Worker's
`console` lines.

Spans record outbound fetch URLs in full. `create_page_asset_upload` with
`file` fetches the caller's download URL, which can carry a short-lived signature in its query.
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
  driver `Browser`), and for each call to the REST routes (surface `http-rest`:
  `GET /api/pages`, and `PUT` or `DELETE /api/pages/<page_id>/tags/<tag>`, with
  operations `list_pages`, `put_page_tag` and `delete_page_tag`; the tag itself
  is never logged). MCP resource lists and reads are `tool.call` with
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

Auth events are `pages.auth.v1` JSON log lines from
[worker/auth-events.mjs](worker/auth-events.mjs), on the same channel and with
the same 30-day retention. They are the record of who signed in or connected
an agent: the auth tables hold only live state, and expired or revoked rows
are deleted. Each line has `action`, `timestamp`, and, where known,
`principal`, `credential` (`oidc`, `oauth` or `api-key`), `client_id`,
`grant`, `scope` and a coded `reason`. `client_id` is the full id of a client
Pages recognizes (`pages-kilo`, ChatGPT's and Claude's document URLs) and the
host alone for any other metadata-document client ([Outbound requests](#outbound-requests)):

| `action` | When | Extra fields |
|---|---|---|
| `sign_in.succeeded` | An OIDC callback created a browser session. | |
| `sign_in.failed` | An OIDC callback was refused. No principal. | `reason`, `phase`, `kind`, `outcome` (`failure_page` or `already_signed_in`) |
| `sign_out` | `POST /api/auth/logout` deleted a live session, or `POST /api/auth/logout-all` signed the account out everywhere. | `scope`: `all` for sign out everywhere |
| `session.expired` | A session in use ended at refresh. | `reason`: `refresh_rejected`, `identity_rejected`, `lease_abandoned`, `seal_unreadable` |
| `oauth.consent_granted`, `oauth.consent_denied` | A person chose Allow access or Cancel. | `client_id`, `scope` |
| `oauth.code_issued` | An authorization code followed consent. | `client_id`, `scope` |
| `oauth.token_issued` | `/oauth/token` issued tokens. | `grant`, `grant_type` (`authorization_code` or `refresh_token`), `scope`, `refresh` |
| `oauth.token_refused` | `/oauth/token` refused a request, including a 503. | `grant_type`, `reason` (OAuth error code) |
| `oauth.grant_revoked` | A grant stopped working. | `grant`, `revoked_by` (`user` for a person in Pages, `rfc7009` for a client's revocation, `system` for replay or reuse), `reason` (`disconnected` or `sign_out_everywhere` for `user`) |
| `oauth.code_replayed` | An authorization code was presented twice. Its grant is revoked. | `grant` |
| `oauth.refresh_reused` | A spent refresh token was presented again. Within 30 seconds of its first use, new tokens are issued and the grant stays; this is what overlapping refreshes from one client's processes look like. After that, the grant is revoked. | `grant`, `reason` (`within_window` when tokens were issued; absent when the grant was revoked) |
| `api_key.accepted` | An Anaconda API key authenticated. One line per key per isolate per 60 s cache window, not per request. | `scope` (`editor` or `viewer`) |
| `kilo_token.accepted` | Kilo accepted a Kilo agent token. One line per token per isolate lease, not per request. | `organizations`: how many organizations the exchange reported |
| `kilo_token.refused` | A Kilo agent token was refused or couldn't be checked. No principal. | `reason`: `exchange_refused_token`, `exchange_refused_account`, `exchange_refused_client`, `kilo_unavailable`, `kilo_protocol_error`, `exchange_failed`, and for a 503 before any exchange `exchanges_in_flight`, `lease_capacity` or `wait_timeout` |
| `invitation.created`, `invitation.revoked` | A Project owner invited an email or revoked an invitation. `principal` is the owner. | `project_id`, `invite`, `role` |
| `invitation.accepted` | A verified recipient claimed a Project invitation. `principal` is the recipient. | `project_id`, `invite`, `role` |

`grant` and `invite` are the first 12 hex digits of SHA-256 over the stored
grant or invitation id. They join the lines of one grant or invitation and
name nothing else. Lines never carry tokens, authorization codes, consent or
CSRF values, OAuth state, cookies, session ids, sealed values, emails, IP
addresses or display names, and a principal containing `@` is dropped.
[worker/auth-events.test.mjs](worker/auth-events.test.mjs) runs the auth test
suites and fails if their console output contains `pages_at_`, `pages_rt_`,
`Bearer`, `code=`, `state=`, `@` or a sealed `iv.ct` value.

Who signed in or connected an agent, by day:

```sh
duckdb -c "
INSTALL httpfs; LOAD httpfs; INSTALL json; LOAD json;
CREATE OR REPLACE SECRET (TYPE s3, PROVIDER credential_chain);
SELECT CAST(CAST(body->>'timestamp' AS TIMESTAMP) AS DATE) AS day,
       body->>'principal' AS principal, body->>'action' AS action,
       coalesce(body->>'client_id', body->>'credential') AS via, count(*) AS n
FROM read_parquet('s3://<fleet-bucket>/<fleet-prefix>/telemetry/logs/**/*.parquet', union_by_name = true)
WHERE json_valid(body) AND body->>'event' = 'pages.auth.v1'
  AND body->>'action' IN ('sign_in.succeeded', 'oauth.token_issued', 'api_key.accepted')
GROUP BY ALL ORDER BY day DESC, principal;"
```

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

## Session key rotation

One session key signs server session ids, seals refresh tokens and login
transactions, signs email and domain proofs, and seals listing cursors. It
lives in one of two Worker variables:

- `NOTEBOOK_CLOUD_APP_SESSION_KEYS`: a keyring,
  `{"active":"k2","keys":{"k1":"…","k2":"…"},"activated_at":{"k2":"<ISO>"}}`.
  New values use `active`; values from any listed key still verify or open.
  It holds 1 to 4 keys, each at least 32 bytes with no surrounding whitespace,
  with kids of `A-Z a-z 0-9 _ -`.
- `NOTEBOOK_CLOUD_APP_SESSION_SECRET`: the single secret. Without a keyring the
  Worker reads it as `k1` and seals in the bare `iv.ct` form, as builds before
  the keyring did.

A bare `iv.ct` seal always opens as `k1`. A hand-written first keyring must
list the old single secret as `k1`, or every existing session, refresh token
and proof stops verifying. The rotation commands below do this for you.

A malformed keyring fails closed: every request, `/health` included, answers
`500` with `server_misconfigured`, and the log names the problem without the
secret. The Worker never falls back to the single secret. A sealed refresh
token that no configured key opens (its key was retired, or its kid is
unknown) ends that session like any other expiry: the row is deleted, session
status reports signed out and clears the cookie, authenticated routes answer
`401`, and `session.expired` is logged with `seal_unreadable`.

### The overlap

The overlap counts from when the Worker starts signing with the new key: the
install on lab1, the `wrangler secret put` on Cloudflare. It does not count
from the rotation. It is the longest a value signed with an older key stays in
use:

- **30 days** on targets with OAuth (every current Pages target).
  OAuth grants keep a snapshot of the session's email proof for the grant's
  lifetime (`OAUTH_REFRESH_SECONDS`, `shared/oauth-grant.mjs`). Page quota
  and domain-view rules check those proofs against their own verification
  time, with no age limit. Retiring the key sooner silently drops quota and
  domain rules for older grants until the client signs in again.
- **7 days** without OAuth: the server session's absolute lifetime. A session
  row keeps the id its key derived until it expires, so the Worker looks a
  cookie up under every key and doesn't move rows to the new key. Refresh
  reseals a row's refresh token under the active key.

Cookies, proofs and cursors signed by the active key are all shorter-lived.
A rotation also changes notebook-cloud's `account_key` once, which only resets
its viewer's cached notebook list.

### On lab1

`/etc/<service>/session-keys.json` (root, `0600`) holds the keyring. Without
it, the installer reads `session-secret` and writes it as the single secret, as
before. With it, the installer writes only the keyring variable and never reads
`session-secret`. A malformed keyring, or neither file, stops the installation
before it writes anything.

From `apps/pages`, with a prepared stage of the running release on the host. The
stage must come from a build with the keyring (its manifest lists
`session-keys.mjs`).

```sh
node scripts/deploy.mjs --target page10 rotate-key                      # plan
node scripts/deploy.mjs --target page10 rotate-key --apply --from k1
node scripts/deploy.mjs --target page10 install REMOTE_STAGE --apply
# 30 days after that install (7 without OAuth)
node scripts/deploy.mjs --target page10 retire-key                      # plan
node scripts/deploy.mjs --target page10 retire-key --apply --from k2
node scripts/deploy.mjs --target page10 install REMOTE_STAGE --apply
```

`rotate-key` and `retire-key` stream
[session-keys.mjs](scripts/deployment/session-keys.mjs) from this checkout to the
host and run it as root under the deployment lock. Plans and receipts list kids
and times, never secrets. `--from` names the active kid the plan showed: a
retried `--apply` after an uncertain result finds a different active kid and
refuses, rather than adding a second key. Neither command touches the Worker.
The keyring reaches it on the next install.

**Rotate.** The first rotation seeds `k1` from `session-secret`, then moves
that file to `session-secret.k1` before it writes the keyring. Rotation
generates the new secret on the host. A secret with surrounding whitespace is
refused rather than seeded, because the Worker would read different bytes. An
interrupted rotation resumes from `session-secret.k1`. Moving the file aside
makes an installer from before the keyring fail early. It reads
`session-secret` before it writes any release file, so it can't deploy `k1`
alone and sign out everyone who signed in under the new key.

**Install.** The installer records in `/etc/<service>/session-keys-active.json`
when every node began serving the keyring's active key, and which deployment
that was. The record carries forward only while each install replaces the
deployment it names with the same active key. A new active key, a rollback, a
failed install or an install without the keyring in between restarts the
clock. Each keyring install also rewrites the session variables in every older
`/opt/<service>/releases/*/wrangler.json` to the current keyring and leaves
their other variables as installed. A `celld deploy` rollback to one of them
then signs with the current keys. A retired key can't come back with it, and
retired secrets leave the host's disk at the next install. Earlier deployments
in the bucket keep the variables they were deployed with.

**Retire.** `retire-key` refuses until the installer's record names the
keyring's active key, and the local node's `/state` reports the deployment that
record names. It then waits the overlap from the record's time. `--kid`
retires one key. `--force` skips the wait and the record check, and signs out
whatever the retired keys still protect. Retiring `k1` deletes
`session-secret.k1`. A retried retire reports `nothing_to_do`.

**Rollback.** A timeout's rollback advice refuses a release from before the
keyring, because it reads only `session-secret`, which rotation moved aside.
`deploy.mjs install` of such a stage fails for the same reason. A direct
`celld deploy` of such a release directory bypasses both. After a keyring
install that directory carries only the keyring, which that build doesn't
read, so it runs with no session key: it refuses every sign-in and reads no
session rather than signing with a stale key. Even with `session-secret` restored, a build from before the
keyring can't open `kid.iv.ct` seals: its refresh path fails with `503` for
those sessions until they sign in again.

### On Cloudflare

Store the keyring as a Worker secret. Workers secrets are write-only, so keep
the current keyring in the team secret store and edit a local copy with the
same helper:

```sh
node scripts/deployment/session-keys.mjs rotate --file KEYRING.json --secret-file SECRET   # plan
node scripts/deployment/session-keys.mjs rotate --file KEYRING.json --apply --from k1
wrangler secret put NOTEBOOK_CLOUD_APP_SESSION_KEYS --config WRANGLER_JSON < KEYRING.json
```

`--secret-file` seeds `k1` from the current single secret on the first
rotation only. Here `retire` measures the overlap (30 days by default) from
`activated_at`, which `rotate` sets to the time of the rotation. Put the secret
right after rotating. If the put came later, wait the overlap from the put:
nothing on Cloudflare records it. Then `retire --file KEYRING.json --apply
--from k2` and another `wrangler secret put` finish the rotation. Save the new
keyring back to the secret store and delete the local copy. Once the keyring
secret is in place, `wrangler secret delete NOTEBOOK_CLOUD_APP_SESSION_SECRET`
removes the single secret. Before a `wrangler rollback` across a rotation,
check which `NOTEBOOK_CLOUD_APP_SESSION_KEYS` the target version runs with: a
version from before the keyring reads only the single secret. `prepare`
refuses either variable in a build's committed vars.

## Cloudflare Workers package

[cloudflare-stage.mjs](scripts/cloudflare-stage.mjs) packages a build for one
Cloudflare Workers deployment. It is a tested packaging path, **not a qualified
deployment**: no Workers deployment has run this release with people on it.

The Worker's classes, migrations, cron triggers and asset handling come from
[worker-shape.mjs](scripts/worker-shape.mjs), which the celld build also uses.
Everything a deployment decides comes from a profile, a JSON file kept outside
the repository:

```json
{
  "name": "pages-example",
  "account_id": "0123456789abcdef0123456789abcdef",
  "workers_dev": true,
  "d1": {
    "auth": { "database_name": "pages-example-auth", "database_id": "D1_UUID" },
    "usage": { "database_name": "pages-example-usage", "database_id": "D1_UUID" }
  },
  "r2_bucket": "pages-example-assets",
  "vars": {
    "NOTEBOOK_CLOUD_PUBLIC_ORIGIN": "https://pages-example.example.workers.dev"
  }
}
```

`account_id` is optional; without it Wrangler uses `CLOUDFLARE_ACCOUNT_ID` or
asks. `vars` holds the deployment's plain variables: the public origin
(required, an `https` origin), the identity provider's settings and any
`PAGES_*` setting such as `PAGES_CATALOG_INDEX`. The helper refuses a profile
with an unknown field, a D1 id that is not a UUID, or a variable that is a
secret or a test switch.

A deployment served from its own hostname names it, with the zone that holds
it, and turns `workers_dev` off:

```json
{
  "workers_dev": false,
  "custom_domain": { "hostname": "pages.example.com", "zone_name": "example.com" },
  "vars": { "NOTEBOOK_CLOUD_PUBLIC_ORIGIN": "https://pages.example.com" }
}
```

The package then carries one route, `{ pattern, zone_name, custom_domain:
true }`, and `wrangler deploy` attaches the domain and creates its DNS record.
The zone must be in the same Cloudflare account as the Worker. The helper
refuses a custom domain that is not the public origin, and one beside
`workers_dev: true`: the Worker checks requests against one origin, so a
second address would serve pages a browser cannot use. Name the zone here and
do not use `wrangler deploy --domain`, which cannot name it: the API then
answers "Can't infer zone from route" for a zone it would find by name.
Without `custom_domain` the package sets no route.

Create the two D1 databases and the R2 bucket first, then put their names and
ids in the profile. From `apps/pages`, with clean committed source and a
matching Pages build:

```sh
node scripts/cloudflare-stage.mjs /tmp/pages-cloudflare-release PROFILE.json
node_modules/.bin/wrangler deploy --config /tmp/pages-cloudflare-release/wrangler.json --dry-run
```

Use a new destination directory each time. The session keyring goes in with
`wrangler secret put` ([On Cloudflare](#on-cloudflare)), never in the profile. A
Worker with people on it also needs the memory, recovery and overload behaviour
qualified on Workers; the limits in this release are sized for the celld hosts.

### Deployment-neutral release package

The [Pages package release](../../.github/workflows/pages-package-release.yml)
workflow publishes a package that names no deployment, so an operator can deploy
released bytes without building this source. A maintainer runs it by hand from
`main`. [release-package.mjs](scripts/release-package.mjs) writes three release
assets under the tag `pages-<build_id>`:

| Asset | Contents |
| --- | --- |
| `pages-package-<build_id>.tar.gz` | `worker/`, `public/`, `build-receipt.json`, `wrangler.json`; regular files only |
| `pages-package-<build_id>.tar.gz.sha256` | `sha256sum -c` line for the archive |
| `pages-package-<build_id>.manifest.json` | build id, source commit, document formats, entry digests, archive digest, structural fields, binding names |

The archive's `wrangler.json` is `structuralConfig()` in
[cloudflare-stage.mjs](scripts/cloudflare-stage.mjs), not a deployable file: it
has no `name`. The operator's own Wrangler file deploys it. These fields are
structural, fixed by the code: `main`, `no_bundle`, `compatibility_date`,
`assets`, `durable_objects`, `migrations`, `triggers`, `preview_urls`,
`observability`, and the variable `NOTEBOOK_CLOUD_OIDC_FLOW`. These are
profile-bound and absent from the package: `name`, `account_id`, `workers_dev`,
`routes`, `d1_databases`, `r2_buckets`, and every other variable. A change to
`worker-shape.mjs` or `structuralConfig()` changes what an operator must
mirror in their own file.

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
against. Create it at
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
  --source https://page10.runtimed.run \
  --project prj_797f9475-6855-4ce5-8203-9f66cfc417c1 \
  --out guide.bundle.json
```

The bundle is JSON for review before import:

```json
{
  "format": "nteract-pages-project-bundle",
  "version": 5,
  "bundle_id": "<uuid>",
  "source": { "origin": "https://page10.runtimed.run", "project_id": "prj_…", "document_id": "…" },
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

Every write uses the repository's retry contract: a nonce the importer makes
itself. A create's nonce is hashed from `(bundle_id, source_page_id)`. A body
edit's is hashed from the bundle, the Page, the batch and the revision it was
read at, and the edit names that revision. The state file (`<bundle>.state.json`
by default, or `--state`, mode 0600) records the source-to-target ID map,
finished steps, and the exact arguments of the request in flight before it is
sent. A failed or interrupted import resumes when you rerun the same command: an
uncertain request is resent with the identical nonce and payload, which replays
its receipt rather than creating a second Page. A finished import sends no writes
on rerun. The importer resumes only a version 3 state file; it refuses an earlier
file, whose requests carry retry tokens or heads, before any write. Start a new
transfer or reconcile that target by hand. Keep the state
file until the import reports success. If it
is lost, a fresh import refuses a target that already has a Project with the
bundle's title; delete the partial Project or pass `--allow-existing-title`.
The target keeps a receipt for at most seven days; a busy catalog can evict it
sooner. A create still uncertain when its first send is older than seven days, less an hour for clock skew
(`RECEIPT_WINDOW_MS`), may have been applied with no receipt left to replay it.
The importer does not send it. It records it as `reconciliation_required` in the
state file (operation, step, nonce, arguments, and `requested_at`, when the create was first
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
- `--accept-missing` sends the create again with the same nonce. Use it when
  the target has no such Page. If the target still holds the create's
  receipt, that answers with the Page it made.

A body edit refused with `resync_required` needs none of these: the run rereads
the Page and writes its whole body again, which gives the same result whether or not the edit
applied.
