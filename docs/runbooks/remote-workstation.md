# Remote workstations: offer a machine's compute to hosted notebooks

A *workstation* is any machine that offers compute to hosted nteract notebook
rooms: an Outerbounds workstation, a JupyterHub single-user server, a beefy box
under your desk. The daemon attaches to a room as a `runtime_peer` over an
outbound WebSocket — no inbound ports, no reverse proxy — launches kernels
locally, and syncs outputs back through the room.

This doc is the operator path. The architecture lives in
`docs/adr/remote-workstation-doc-agents.md` and
`docs/adr/deployment-topology.md`; the daemon-side surface in
`crates/runtimed/src/workstation/`.

## Install (one-liner)

On fresh Debian/Ubuntu images, install `curl` first. `tmux` is optional, but
useful when you serve attach requests from an SSH session instead of a user
service.

```bash
sudo apt update && sudo apt install -y curl tmux
```

On a Linux x64 or macOS (Apple silicon / Intel) machine:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --headless
```

`--headless` skips the desktop app and installs just `runt`, `runtimed`, and
`nteract-mcp` into `~/.local/share/nteract/stable` (on macOS, as the sidecars
of the .app bundle kept under that prefix), links them into `~/.local/bin`,
and installs the per-user daemon service (`runt daemon doctor --fix` —
systemd on Linux, launchd on macOS). Everything is per-user; no root
required. Re-run to upgrade.

If this is a fresh shell, make the installed CLI available before running the
pairing commands:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The examples below use the stable channel command names. Nightly releases use
channel-suffixed commands instead: `runt-nightly`, `runtimed-nightly`, and
`nteract-mcp-nightly`. If you install a nightly headless release, run
`runt-nightly workstation ...` wherever this guide shows
`runt workstation ...`; the workstation credential is stored under
`~/.config/nteract-nightly/workstation.json`.

For air-gapped installs, download the release assets yourself and use
`--from-dir`.

## Pair and serve (recommended)

The pairing flow needs no externally issued credential
(`docs/adr/hosted-credential-transport.md`, Decision 9):

1. In the hosted workstation panel, mint a pairing code. Codes look like
   `XXXX-XXXX-XXXX`, live 10 minutes, and are single use.
2. On the workstation:

```bash
runt workstation connect https://app.runt.run --code XXXX-XXXX-XXXX
```

   (Omit `--code` to be prompted.) This redeems the code for a long-lived
   workstation credential scoped to the workstation surface only, stores it
   at `~/.config/nteract/workstation.json` (mode 0600), and registers the
   workstation so it appears in the panel immediately. `--id` / `--name`
   override the default `ws-<hostname>` identity. If the code is rejected,
   mint a fresh one from the panel — codes expire and cannot be reused.

3. On Linux, keep the workstation available with user systemd:

```bash
runt workstation service install --start
```

   On Linux this writes and enables a user systemd unit that runs
   `runt workstation run` with the stored credential. It does not require
   root. Use `--python-path /path/to/python` when the workstation should
   launch kernels from a project or virtual environment interpreter instead
   of the first `python3`/`python` on `PATH`. Use
   `--working-directory /path/to/project` when the service should advertise
   and launch runtime peers from a specific project directory.

   On macOS or Linux hosts without a usable user systemd session, use the
   foreground fallback instead:

```bash
runt workstation run
```

4. Check what the credential sees:

```bash
runt workstation status          # workstations, status, last-seen, default
runt workstation status --json
runt workstation service status  # Linux user systemd service state
```

The service launches `runtimed workstation-agent`, which heartbeats the
registration, keeps a server-sent event stream open for attach-job wakeups, and
spawns one `runtimed cloud-runtime-agent` runtime peer per job (pending →
accepted → running → completed/failed). The event stream is the fast path;
low-frequency attach-job polling remains as recovery for missed events, older
servers, and jobs that existed before the agent started. The stream is
deliberately only a wakeup signal, not a replay log: attach jobs are durable in
the hosted database, so reconnect recovery polls the queue instead of relying
on SSE `Last-Event-ID` state. Keeping idle presence and wakeups on one SSE
request avoids the request churn of tight polling or a per-workstation control
WebSocket. The credential rides the environment (`RUNT_CLOUD_TOKEN`), never
argv. `RUNT_CLOUD_TOKEN` / `RUNT_CLOUD_URL` environment variables override the
stored credential for foreground `runt workstation run`; the service path uses
the stored credential file written by `connect`.

In the hosted notebook, attaching compute to a workstation dispatches an attach
job; the agent accepts it and the runtime peer attaches to the room as
`runtime_peer` over an outbound WebSocket. The peer reconnects with backoff
across room evictions and network blips and keeps the kernel alive across
reconnects; a clean room close does not tear the kernel down. If the agent
restarts, it adopts runtime peers that are still alive (per-job pid + log files
under the daemon cache) and reports the ones that are gone.

## Run it as a service

The installer's systemd unit runs the *daemon*. Workstation availability is a
separate user service because the daemon makes the machine notebook-capable,
while the workstation agent offers this machine's compute to hosted notebooks.

Install or update the workstation service after a one-time
`runt workstation connect`:

```bash
runt workstation service install --start \
  --python-path "$PWD/.venv/bin/python" \
  --working-directory "$PWD"
```

Manage it with:

```bash
runt workstation service status
runt workstation service logs -f
runt workstation service stop
runt workstation service start
runt workstation service uninstall
```

The service command detects missing user systemd sessions and prints the
foreground fallback. If the workstation must stay available after SSH logout,
the Linux account may also need lingering enabled by an administrator:
`loginctl enable-linger $USER`.

For preview/manual testing, the foreground path still works unchanged and is
useful inside tmux:

```bash
runt workstation run --python-path "$PWD/.venv/bin/python" --working-directory "$PWD"
```

## Attach a single room directly (legacy / dev)

Before the pairing flow, the operator path was a per-notebook agent with an
externally issued bearer. It still works and remains useful for dev and for
deployments that issue their own credentials:

1. In the hosted notebook, grant the workstation principal an explicit
   `runtime_peer` ACL row (owner alone is not sufficient — compute access is
   never derived from human roles).
2. On the workstation:

```bash
RUNT_CLOUD_TOKEN=<token> runtimed cloud-runtime-agent \
  --cloud-url https://app.runt.run \
  --notebook-id <id> \
  --python-path "$(command -v python3)"
```

The credential always rides the environment, never argv. Defaults: scope
`runtime_peer`, auth kind `oidc` (use `--auth-kind anaconda-key` for Anaconda
API keys, `--auth-kind workstation` for a pairing-flow credential). Blob root
defaults under the daemon's standard cache. `--python-path` launches a kernel
in that interpreter immediately on attach (launch-on-attach); omit it to
attach idle and wait for the room to dispatch work. `--workstation-id` /
`--workstation-display-name` set the non-secret identity shown in the
notebook's workstation panel.

The Node connector (`apps/notebook-cloud/scripts/hosted-workstation-agent.mjs`)
is the dev-loop equivalent of `runtimed workstation-agent` and keeps working
against the same attach-job surface with `NTERACT_API_KEY` or
`NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN`.

For browser-coupled OIDC peers whose token expires, mint fresh tokens via a
refresher (the transport supports per-connect refresh; see
`notebook-cloud-transport`'s `TokenRefresher`).

## JupyterHub

Run the install one-liner in the single-user image (or bake the three binaries
in), then start the agent from a Hub-managed service or the user's notebook
environment. The agent's outbound-WS model fits Hub deployments where inbound
routes are owned by the Hub proxy: nothing needs to be exposed. The
`nteract-identity` crate has a feature-gated JupyterHub provider surface for
Hub-token validation; until that lands, use OIDC bearer or Anaconda API-key
auth against the hosted deployment.

## Outerbounds

Outerbounds workstations are Linux x64 with a per-user home — the defaults
above apply unchanged. Use the workstation's task environment Python as
`--python-path` so notebook execution sees the same dependencies as your
flows.

## What the workstation offers

`runtimed` maintains prewarmed environment pools (uv/conda/pixi) and captured
per-notebook environments. The workstation endpoint projects these as the
environments it can offer (`list_environments`), and the hosted room's
workstation panel surfaces attachment state.

Hosted runtime controls use the workstation contract rather than browser-owned
kernel launch state. Interrupt requests are forwarded to the active runtime
peer for the current attachment. Restart requests replace the active
workstation attachment: the room publishes a fresh pending attachment in the
RuntimeStateDoc, closes the previous runtime peer, and waits for the selected
workstation to claim the new job and launch a new runtime peer. Direct
browser-authored `launch_kernel` / `shutdown_kernel` frames remain unsupported
for hosted rooms because the workstation owns the Python path, working
directory, and environment policy.

## Diagnostics

```bash
runt workstation status     # workstations the credential can see
runt daemon status          # daemon state, pool sizes
runt daemon logs -f         # tail the daemon log
runt diagnostics            # bundle logs + system info into an archive
journalctl --user -u nteract-workstation      # agent service logs
```

Per-job runtime peer logs land under the daemon cache
(`~/.cache/runt*/workstation-agent/<job>/runtime-peer.log`).
