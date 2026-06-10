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

On a Linux x64 machine:

```bash
curl --proto '=https' --tlsv1.2 -sSfL \
  https://raw.githubusercontent.com/nteract/nteract/main/scripts/install-linux-release | \
  bash -s -- --headless
```

`--headless` skips the desktop AppImage and installs just `runt`, `runtimed`,
and `nteract-mcp` into `~/.local/share/nteract/stable`, links them into
`~/.local/bin`, and installs the per-user systemd service for the daemon
(`runt daemon doctor --fix`). Everything is per-user; no root required. Re-run
to upgrade. (`https://sh.nteract.io` will front this script once the domain is
live.)

For air-gapped installs, download the release assets yourself and use
`--from-dir`.

## Attach to a hosted notebook

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
API keys), blob root under the daemon's standard cache. `--python-path`
launches a kernel in that interpreter immediately on attach
(launch-on-attach); omit it to attach idle and wait for the room to dispatch
work. `--workstation-id` / `--workstation-display-name` set the non-secret
identity shown in the notebook's workstation panel.

The agent reconnects with backoff across room evictions and network blips and
keeps the kernel alive across reconnects; a clean room close does not tear the
kernel down.

## Run it as a service

The installer's systemd unit runs the *daemon*. To keep a long-lived agent
attached to a specific room, add a user unit alongside it:

```ini
# ~/.config/systemd/user/nteract-workstation@.service
[Unit]
Description=nteract workstation agent for notebook %i
After=network-online.target

[Service]
Environment=RUNT_CLOUD_AUTH_KIND=oidc
EnvironmentFile=%h/.config/nteract/workstation.env
ExecStart=%h/.local/bin/runtimed cloud-runtime-agent \
  --cloud-url https://app.runt.run --notebook-id %i \
  --workstation-id %H
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Put `RUNT_CLOUD_TOKEN=...` in `~/.config/nteract/workstation.env` (mode 0600),
then:

```bash
systemctl --user enable --now nteract-workstation@<notebook-id>
```

For long-lived peers whose OIDC token expires, mint fresh tokens via a
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
workstation panel surfaces attachment state. Inbound kernel lifecycle dispatch
(interrupt/restart over the room) is tracked in
[#3381](https://github.com/nteract/nteract/issues/3381).

## Diagnostics

```bash
runt daemon status          # daemon state, pool sizes
runt daemon logs -f         # tail the daemon log
runt diagnostics            # bundle logs + system info into an archive
journalctl --user -u 'nteract-workstation@*'   # agent service logs
```
