# nteract CLI

`nteract` is the public command for notebooks, workstations, and MCP. Desktop
is optional for headless operations. This guide describes the unified CLI in
this source tree; an older release may still expose only the compatibility
commands.

## Install and select an installation

The release installer accepts `--cli` (alias `--headless`) to install the
command and its helpers without installing or starting a local daemon service:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --cli
```

The bootstrap is maintained in the separate `nteract/install-sh` repository.
It forwards arguments to the release installer. New CLI behavior becomes
available when the selected release includes it; changing the bootstrap alone
does not upgrade the release's binaries.

The public command lives in `~/.local/bin` by default. If that directory is
not on the current terminal's PATH, add it:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Desktop installation also bundles the CLI. Its Install Command menu can select
that installation. Existing unrelated commands are preserved rather than
overwritten. The installer reports their path so you can resolve the conflict.

Installing another release channel keeps the existing selected `nteract`
command. Use the installer's `--default-cli` option to select that installation,
or select a channel for one command:

```sh
nteract --channel nightly --version
nteract --channel nightly workstation status
```

An explicit channel selects a real installed backend and its configuration;
it cannot turn a Stable binary into Nightly by changing an environment variable.
The installer records channel targets beside the public command, including
custom installation prefixes. Missing channels produce an installation error.

## Notebook and workstation commands

```sh
# Open the Desktop app at a notebook
nteract open analysis.ipynb

# Inspect local notebooks without creating a runtime as a side effect
nteract notebooks --json

# Discover the shared notebook operations and invoke one
nteract nb tools
nteract nb call get_all_cells --path analysis.ipynb --json

# Register and serve this machine for a configured hosted deployment
nteract workstation connect https://notebooks.example.com --code XXXX-XXXX-XXXX
nteract workstation run

# Linux: keep the workstation available independently of this terminal
nteract workstation service install --start
```

Notebook operations use the same implementation as MCP. Execution operates on
synced cell IDs, preserving the document seen by other peers. `nb call --json`
returns the complete MCP tool result; a failed tool result exits unsuccessfully.
Run `--help` on a command for its argument and output contract. Observation
commands such as status and listing do not implicitly start services.

Notebook listing and operations use the selected shared runtime. `daemon` and
top-level `status` describe the selected installation instead. An explicit
`--channel` constrains both to that channel.

`open` and MCP's `show_notebook` launch the Desktop installation that owns the
selected runtime endpoint. Unknown custom endpoints cannot be handed to Desktop;
continue using them through CLI or MCP operations.

Pairing registers a machine; serving makes it available for attachment. Neither
means a notebook kernel is ready or a cell has executed. Workstation persistence
currently uses Linux user systemd; macOS workstation service management remains
separate work. Hosted examples require a configured deployment and credentials;
they do not imply a public hosted service.

## MCP

Register this stdio command with an MCP client:

```sh
nteract mcp
```

`--no-show` omits the Desktop-opening tool. `--socket PATH` selects an existing
explicit local endpoint and does not authorize creating a second runtime with
partially shared state.

The command runs the existing resilient supervisor, which restarts its internal
worker and preserves the notebook target handoff. Protocol traffic uses stdout;
diagnostics use stderr. The hidden worker is an implementation detail, not the
command to put in client configurations.

Existing `nteract-mcp` registrations and `runt mcp` invocations remain compatible.
The former remains supervised; the latter retains its direct-worker behavior.
There is no need to rewrite existing integrations during installation.

## Runtime dependency and startup

| Operation | Local notebook daemon needed? |
| --- | --- |
| Help, tool discovery, configuration reads | No |
| Desktop notebooks, including hosted Desktop windows | Yes |
| Local notebook connection/creation through CLI or MCP | Yes; canonical commands can start an absent runtime |
| Direct hosted MCP connection | No |
| `cloud open` through the Desktop-style bridge | Yes |
| Workstation pairing or serving | No |

The `runtimed` executable includes local daemon, workstation agent, and execution
agent entry points. Needing that executable is different from needing its local
daemon service. Local and hosted execution agents already share the same kernel
execution loop.

Canonical notebook operations prefer sharing an existing compatible runtime.
Explicit channel, socket, and worktree selections constrain discovery. A
compatible response is checked using wire and semantic API versions; matching
build hashes are not required for ordinary admission.

For programmatic CLI and MCP connections, only a definitely absent endpoint
permits lazy startup. Permission errors,
timeouts, unknown protocol responses, and incompatible runtimes produce errors
without repair, replacement, or an automatic isolation fallback. A successful
startup process exit is not enough: the endpoint must report a compatible live
runtime. Existing worktree isolation remains available; changing only a socket
does not isolate notebook storage, settings, or locks.

Desktop also checks compatibility before its initial startup decision and leaves
an observed incompatible or uncertain endpoint alone. Its existing first-install
path still uses service installation: a runtime appearing after the absence
check can race with that installation. Removing that replacement race requires
separate service-lifecycle work; this CLI change does not make Desktop bootstrap
an atomic, non-replacing operation.

Explicit runtime repair remains a separate operation governed by
[Daemon service repair and semantic compatibility](../adr/daemon-service-repair-and-semantic-compatibility.md).
