# Remote workstations: offer a machine's compute to hosted notebooks

A *workstation* is any machine offering compute to hosted nteract notebook
rooms (an Outerbounds workstation, a JupyterHub single-user server, or a box
under your desk). A runtime agent attaches as a `runtime_peer` over an outbound
WebSocket, launches kernels locally, and syncs outputs back through the room.
No inbound ports or reverse proxy are required.

Architecture: `docs/adr/remote-workstation-doc-agents.md` and
`docs/adr/deployment-topology.md`. Implementation:
`crates/runtimed/src/workstation/`.

## Install (one-liner)

On fresh Debian/Ubuntu images, install `curl` first (`tmux` is optional, useful
when serving from an SSH session instead of a user service):

```bash
sudo apt update && sudo apt install -y curl tmux
```

On Linux (x64 or ARM64) or macOS (Apple silicon or Intel):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --cli
```

- `--cli` (alias `--headless`) installs the CLI and runtime/MCP helpers without
  configuring or starting a local daemon service. On macOS, the signed bundle
  stays under the install prefix without adding a Desktop app to Applications.
  Installs are per-user; re-run to upgrade.
- The public command is `nteract`. The runtime helper contains the workstation
  and execution modes and does not require a running local notebook daemon. See
  the [CLI guide](cli.md) for the dependency table.
- In a fresh shell, add `~/.local/bin` to `PATH` before pairing:

  ```bash
  export PATH="$HOME/.local/bin:$PATH"
  ```

- **Nightly workstations**: Installing another channel preserves the current
  default `nteract` command. Use `nteract --channel nightly workstation ...`
  throughout pairing, serving, and recovery to target the Nightly installation
  and its credential namespace. This flag does not reinterpret Stable
  credentials. Pass `--default-cli` to the installer to change the default
  command. Legacy channel-specific commands remain compatible.
- **Air-gapped installs**: Download the release assets separately and pass
  `--from-dir` to the installer.

## Pair and serve (recommended)

Pairing requires no externally issued credential
(`docs/adr/hosted-credential-transport.md`, Decision 9).

1. **Mint a pairing code** in the hosted workstation panel. Codes look like
   `XXXX-XXXX-XXXX`, expire in 10 minutes, and are single use. Prefer copying
   the pre-filled commands from the panel's "Connect a machine" dialog.
2. **Pair the workstation** against the cloud host you signed in to (currently
   `https://preview.runt.run`):

   ```bash
   nteract workstation connect https://<cloud-host> --code XXXX-XXXX-XXXX
   ```

   Omit `--code` to be prompted. This redeems the code for a long-lived
   workstation-only credential, saves it at `~/.config/nteract/workstation.json`
   (mode `0600`), and registers the workstation in the panel immediately. Use
   `--id` and `--name` to override the default `ws-<hostname>` identity. If a
   code is rejected, mint a fresh one; codes expire and cannot be reused.
3. **Start serving**:
   - **Linux (user systemd, no root required)**:

     ```bash
     nteract workstation service install --start
     ```

     This writes and enables a user systemd unit running `nteract workstation run`
     with the stored credential. Pass `--python-path /path/to/python` to use a
     project or virtualenv interpreter instead of the first `python3`/`python`
     on `PATH`, and `--working-directory /path/to/project` to advertise and
     launch runtime peers from a specific directory.
   - **macOS or Linux without user systemd (foreground)**:

     ```bash
     nteract workstation run
     ```

   - **Interpreter requirement**: The `current_python` policy runs the chosen
     interpreter as-is and never installs packages into it. If `ipykernel` is
     missing, startup warns without refusing to serve; install it and restart:

     ```bash
     /usr/bin/python3 -m pip install ipykernel
     ```

4. **Verify registration and service health**:

   ```bash
   nteract workstation status          # workstations, status, last-seen, default
   nteract workstation status --json
   nteract workstation service status  # Linux user systemd service state
   ```

### Agent and room lifecycle

- **Job dispatch**: The service runs `runtimed workstation-agent`, which
  heartbeats registration, holds a hibernatable event WebSocket for attach-job
  wakeups, and spawns one `runtimed cloud-runtime-agent` per job
  (`pending → accepted → running → completed/failed`).
- **Wakeup vs. polling**: The event WebSocket is a wakeup signal only, not a
  replay log. Attach jobs are durable in the hosted database, so low-frequency
  polling recovers missed wakeups and pre-existing jobs on reconnect.
- **Credential passing**: Credentials pass via `RUNT_CLOUD_TOKEN`, never argv.
  `RUNT_CLOUD_TOKEN` and `RUNT_CLOUD_URL` override the stored file for
  foreground `nteract workstation run`; the systemd service always uses the
  stored credential file written by `connect`.
- **Reconnects**: On owner attach, the runtime peer joins the room as
  `runtime_peer` over an outbound WebSocket and reconnects with backoff across
  recoverable room evictions and network blips while keeping the kernel alive.
- **Idle timeout and terminal closes**: Current lifecycle, 2026-09-04: after 30
  minutes with no queued or active execution, the room stops idle compute even
  if viewers stay connected. Ordinary transport closes are recoverable, but an
  intentional room stop is not. Its `runtime idle timeout` close uses code 1000
  and is treated as a terminal, graceful shutdown, not instructions to reconnect
  it. Replacement, restart, and policy-rejection closes are also terminal for
  the old peer. Owner execution can resume an eligible workstation (see
  [What the workstation offers](#what-the-workstation-offers)).
- **Agent restart recovery**: On restart, the workstation agent adopts live
  nteract runtime peers via per-job pid and log files in the daemon cache and
  reports dead ones. It does not adopt arbitrary existing Jupyter kernels.

## Run it as a service

Workstation availability uses its own user service. CLI-only installs do not
create a local daemon service, and an existing local notebook daemon does not
expose this machine as a workstation.

Install or update the service after running `nteract workstation connect`:

```bash
nteract workstation service install --start \
  --python-path "$PWD/.venv/bin/python" \
  --working-directory "$PWD"
```

Manage the service:

```bash
nteract workstation service status
nteract workstation service logs -f
nteract workstation service stop
nteract workstation service start
nteract workstation service uninstall
```

- Missing user systemd sessions are detected automatically, printing the
  foreground fallback command.
- To keep the workstation online after SSH logout on Linux, an administrator
  may need to enable lingering: `loginctl enable-linger $USER`.
- For manual testing or `tmux`, run in the foreground:

  ```bash
  nteract workstation run --python-path "$PWD/.venv/bin/python" --working-directory "$PWD"
  ```

## Attach a single room directly (legacy / dev)

Per-notebook attachment with an externally issued bearer remains supported for
development and deployments issuing their own credentials:

1. Grant the workstation principal an explicit `runtime_peer` ACL row in the
   hosted notebook. Ownership alone is not enough; compute access is never
   derived from human roles.
2. Start the runtime peer on the workstation (pass tokens via env, never argv):

   ```bash
   RUNT_CLOUD_TOKEN=<token> runtimed cloud-runtime-agent \
     --cloud-url https://<cloud-host> \
     --notebook-id <id> \
     --python-path "$(command -v python3)"
   ```

Options and auth modes:

- **Defaults**: Scope `runtime_peer`, `--auth-kind oidc`, blob root under the
  daemon's standard cache.
- **`--auth-kind`**: `oidc` (default), `anaconda-key` (Anaconda API keys),
  `workstation` (pairing credential), or `dev` (Worker dev auth).
- **`--python-path`**: Launches a kernel immediately on attach. Omit it to
  attach idle and wait for dispatched work.
- **Display metadata**: `--workstation-id` and `--workstation-display-name` set
  the non-secret label shown in the notebook's workstation panel.
- **Dev auth (`--auth-kind dev`)**: Reads `RUNT_CLOUD_TOKEN` and
  `RUNT_CLOUD_DEV_USER`, sending `X-Notebook-Cloud-Dev-Token`, `X-User`, and
  `X-Scope` on upgrade (mapped to `user:dev:<user>`). Workers accept dev
  credentials unauthenticated on loopback (Wrangler dev or local `celld`), and
  on deployed hosts only when `NOTEBOOK_CLOUD_DEV_TOKEN` is configured (leave
  unset in production). Only `hosted-workstation-agent.mjs` refuses non-loopback
  URLs client-side.
- **Node dev connector**: `apps/notebook-cloud/scripts/hosted-workstation-agent.mjs`
  mirrors `runtimed workstation-agent` against the attach-job API using
  `NTERACT_API_KEY` or `NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN`. Against a
  loopback Worker, set `NOTEBOOK_CLOUD_WORKSTATION_AUTH_KIND=dev`,
  `NOTEBOOK_CLOUD_DEV_TOKEN`, and `NOTEBOOK_CLOUD_DEV_USER` (refused for any
  non-loopback `NOTEBOOK_CLOUD_URL`). See `apps/notebook-cloud` README for
  smoke commands.

### OIDC token refresh

`cloud-runtime-agent --auth-kind oidc` can renew expiring tokens from a
refresh-token cache (`crates/runtimed/src/workstation/oidc_refresh.rs`). It
checks expiry before each room connect/reconnect and output blob upload,
sharing one renewed token across both paths.

Seed the cache once via environment variables (never argv):

```bash
RUNT_CLOUD_TOKEN=<access-token> RUNT_CLOUD_REFRESH_TOKEN=<refresh-token> \
  runtimed cloud-runtime-agent \
  --cloud-url https://<cloud-host> \
  --notebook-id <id> \
  --oidc-issuer https://<issuer> \
  --oidc-client-id <public-client-id>
```

- **Opt-in reuse**: Pass `--oidc-issuer` and `--oidc-client-id` (or
  `--oidc-refresh-cache`) on subsequent starts to reuse the cache. Without an
  `--oidc-*` flag or seed, the agent ignores any cache and uses the static
  `RUNT_CLOUD_TOKEN`.
- **Cache binding**: The cache is a `0600` file per cloud origin in the
  `runtimed` config directory (override with `--oidc-refresh-cache`). It is
  bound to cloud origin, issuer, client ID, and (for JWTs) account; mismatched
  caches or `RUNT_CLOUD_TOKEN` values are refused. An existing cache wins over
  `RUNT_CLOUD_REFRESH_TOKEN`; delete the cache to re-seed.
- **Discovery security**: Issuers require `https` (use
  `--oidc-allow-loopback-http` for `http://localhost` in dev). Discovery must
  match the issuer exactly, the token endpoint must share the issuer's origin,
  and redirects are not followed.
- **Concurrency and backoff**: On Unix, agents sharing a cache refresh one at a
  time so rotating refresh tokens are not spent twice. Cache seeding never
  overwrites a cache created by another agent. Failed refreshes back off for 5
  seconds while keeping any unexpired cached token in use. In the final minute
  before expiry, connects and uploads wait up to 2 seconds for refresh, then
  use the still-valid token while refresh finishes in the background (or wait
  for refresh if the token expires during those 2 seconds). Refresh failures are
  logged locally.
- **Local isolation note**: Any process running as the same OS user, including
  the kernel, can read the cache file. `RUNT_CLOUD_REFRESH_TOKEN` is stripped
  from the kernel environment for hygiene, not isolation.

## JupyterHub

Run the install one-liner in the single-user image (or bake in the three
binaries), then start the agent from a Hub-managed service or the user's
notebook environment. Because the agent uses outbound WebSockets, nothing needs
to be exposed through the Hub proxy. Until the feature-gated JupyterHub
provider in `nteract-identity` lands for Hub-token validation, authenticate
against the hosted deployment with an OIDC bearer or Anaconda API key.

This is the currently supported workstation path, not the only intended Hub
topology. Other Hub topologies (direct Jupyter Server attachment, an nteract
server extension, and Hub-service provisioning) are explored in
[Hosted Notebook Accounts and Compute Federation](../memos/hosted-notebook-federation.md).

## Outerbounds

Outerbounds workstations run Linux x64 with a per-user home, so the default
setup applies unchanged. Pass the task environment's Python to `--python-path`
so notebooks see the same dependencies as your flows.

## The runtime-peer image

The `runtime-peer` container image bundles `runtimed`, the pairing CLI, and a
Python 3.12 environment preloaded with kernel base packages (`ipykernel`,
`ipywidgets`, `anywidget`, `nbformat`, `pyarrow>=14`, `uv`; the same set the
daemon installs into managed environments). This avoids manual
`pip install ipykernel` steps and the silent "Kernel running" traceback when
system Python lacks `ipykernel`.

- **Registry and tags**: `ghcr.io/nteract/runtime-peer`, tagged `:<version>`,
  `:nightly` / `:stable`, and `:latest` (stable only). `runtimed --version`
  matches the release tag. Pulls are anonymous; see
  [publication](../../images/runtime-peer/README.md#publication) for the
  permission model.
- **Entrypoint**: `runtimed` (no default subcommand). Invoke
  `cloud-runtime-agent`, `workstation-agent`, or pair interactively first.
- **User and paths**: Non-root user `runt` (uid 1000). `python3` lives at
  `/usr/local/bin/python3`; pass it to `--python-path`.
- **Writable volume**: Requires a writable `$HOME` (`/home/runt`) for the
  launcher cache, blob store, and socket. Mounting a per-user home (as in
  Outerbounds) satisfies this.
- **Network**: Outbound only. Kernel ports bind loopback inside the container.

Pair manually inside the container (build `nteract-runtime-peer:dev` locally
first, or substitute a published tag):

```bash
docker run -it --entrypoint bash nteract-runtime-peer:dev
nteract workstation connect https://<cloud-host> --code XXXX-XXXX-XXXX
nteract workstation run --python-path "$(command -v python3)"
```

Mint the single-use pairing code in the hosted workstation panel. The redeemed
credential saves with mode `0600` in the container's home directory; mount
durable storage there to keep identity across container restarts. Credentials
pass via `RUNT_CLOUD_TOKEN`, never argv.

## What the workstation offers

As of 2026-09-04:

- **Advertised capability**: The workstation agent advertises **Current
  Python** (its configured interpreter, working directory, and
  `launch_current_python` capability) and launches kernels in that interpreter
  without installing packages. The hosted panel shows registration and
  attachment state, not a catalog of daemon-managed environments.
- **Prewarmed pools**: `runtimed` maintains local uv/conda/pixi pools and
  per-notebook environments (`list_environments` in
  `crates/runtimed/src/workstation/environments.rs`), but hosted pool selection
  and captured-environment discovery are not wired into the hosted catalog yet.
- **Owner-only execution and resume**: Attachment and execution are owner-only;
  editor access does not grant compute spend. If an owner executes with no
  active peer, a connecting attachment can accept queued work. A previously
  selected workstation owned by the notebook owner in state `ready`,
  `disconnected`, or `idle` can receive a resume attach job if it passes
  online/lease/heartbeat checks. If no eligible attachment can connect or
  resume, execution is rejected (rooms never pick compute from the URL or fall
  back to an unrelated workstation).
- **Interrupt and restart**: Interrupt forwards to the active runtime peer.
  Restart replaces the attachment: the room publishes a fresh pending
  attachment in `RuntimeStateDoc`, closes the old peer, and waits for the
  workstation to claim the new job and launch a new peer. Direct
  browser-authored `launch_kernel` and `shutdown_kernel` frames remain
  unsupported for hosted rooms because the workstation owns the Python path,
  working directory, and environment policy.

## Diagnostics

```bash
nteract workstation status     # workstations the credential can see
nteract daemon status          # daemon state, pool sizes
nteract daemon logs -f         # tail the daemon log
nteract diagnostics            # bundle logs + system info into an archive
journalctl --user -u nteract-workstation      # agent service logs
```

Per-job runtime peer logs live under the daemon cache:
`~/.cache/runt*/workstation-agent/<job>/runtime-peer.log`.
