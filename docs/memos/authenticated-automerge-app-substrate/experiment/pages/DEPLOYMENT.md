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

After publication, verify the exact release/build hashes, anonymous denial,
real OIDC, MCP/API-key operations, live peers, durable receipts, and frozen-service
fingerprints. Check reconnect and restart recovery with disposable QA Pages.
A process restart is not proof of power-loss or object-store failover recovery.
Existing documents, sessions, ACLs, and assets must be preserved.

Rollback must retain binary record readers and the `PageRecords` binding and
buffered-storage implementation. A legacy hex-only build cannot read updated
records, and an older synchronous-only build cannot read buffered Pages.

The D1 catalog index (`PAGES_CATALOG_INDEX`) is additive: Catalog entries keep
their keys and shape, and older builds ignore the `pages_catalog_*` tables. After
a rollback, accounts repair their index within six hours of their next listing, or
immediately when the `PAGES_CATALOG_INDEX` value changes. Index migrations run
lazily on first use and must stay additive so a rollback build keeps working
against the newer schema. Listing cursors are sealed with a key derived from the
session secret; rotating that secret invalidates outstanding cursors. Copying
a document or its assets between targets is separate from deployment; publishing
does not migrate another environment's data.

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
