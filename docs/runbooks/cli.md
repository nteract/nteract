# nteract CLI

`nteract` is the public command for notebooks, workstations, and MCP. Desktop
is optional for headless operations. Older releases may still expose only the
compatibility commands.

## Install and select an installation

Install the CLI and its helpers without registering or starting a local daemon
service. `--cli` and `--headless` are aliases:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --cli
```

- **Bootstrap script**: Maintained in the separate `nteract/install-sh`
  repository. It forwards arguments to the release installer. New CLI behavior
  requires a release that includes it; updating the bootstrap alone does not
  upgrade release binaries.
- **PATH**: The public command installs to `~/.local/bin` by default. Add it
  if missing from your shell:

  ```sh
  export PATH="$HOME/.local/bin:$PATH"
  ```

- **Desktop bundle**: Desktop also bundles the CLI. Use its **Install nteract
  CLI** menu to select that installation. Existing unrelated commands are
  preserved rather than overwritten, and the installer prints their path so you
  can resolve conflicts.
- **Channels**: Installing another release channel keeps the current selected
  `nteract` command. Pass `--default-cli` to the installer to switch defaults,
  or select a channel for one command:

  ```sh
  nteract --channel nightly --version
  nteract --channel nightly workstation status
  ```

- **Channel resolution**: `--channel` selects a real installed backend and its
  configuration. Environment variables cannot turn a Stable binary into Nightly.
  The installer records channel targets beside the public command, including
  under custom prefixes. Missing channels return an installation error.

## Notebook and workstation commands

```sh
# Create a fresh untitled Desktop notebook in this directory
nteract .

# Create a fresh untitled notebook in another project
nteract ./project

# Open a saved notebook (both forms are equivalent)
nteract analysis.ipynb
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

- **Directory targets**: Passing a directory (`nteract .` or `nteract open .`)
  always opens a fresh untitled notebook with that directory as its working
  directory, even when Desktop is already running. It does not reopen a
  previous notebook or create `Untitled.ipynb`. Save the notebook to pick its
  filename; normal recovery protects untitled work.
- **Runtime selection**: Use `nteract open . --runtime deno` to choose a
  runtime. On macOS, an explicit runtime starts a separate Desktop process so
  the flag is honored even when Desktop is already running. Ordinary directory
  opens use Desktop's default runtime.
- **Path disambiguation**: Command names take precedence over shorthand paths.
  Use `nteract ./open`, `nteract ./nb`, or `nteract open <path>` for matching
  names. Unknown bare words that do not name an existing path produce a command
  error; use an explicit path like `./analysis`. Notebook filenames and
  directory names are unrestricted, and Desktop reports file availability and
  parsing errors.

## Runtime management and diagnostics

```sh
nteract doctor
nteract status
nteract daemon status
nteract daemon logs -f
nteract diagnostics

# Explicitly inspect the Nightly installation
nteract --channel nightly doctor
```

Run `nteract daemon --help` for service lifecycle and maintenance operations.
These commands describe the selected installation, even when notebook
operations share a compatible runtime from another installation.

## Notebook operation behavior

### Execution and readiness

- Notebook operations share the same implementation as MCP. Execution runs on
  synced cell IDs, preserving the document seen by other peers.
- `nb call --json` returns the complete MCP tool result and exits non-zero on
  tool failure.
- One-shot calls keep the attachment open for up to 125 seconds while waiting
  for current document state and (for code execution) a running kernel. This
  readiness budget is separate from the tool's `timeout_secs`.
- Trust requirements, failed sources, and failed kernel launches return errors.
  The wait does not approve trust or restart a kernel.
- Historical result lookup and session-control tools keep their own access
  rules. MCP connections still return progressive readiness.

### Command scope

- Run `--help` on any command for its argument and output contract.
- Observation commands such as status and listing do not implicitly start
  services.
- Notebook listing and operations use the selected shared runtime. `daemon` and
  top-level `status` describe the selected installation. An explicit
  `--channel` constrains both to that channel.

### Desktop handoff

- `open` and MCP's `show_notebook` launch the Desktop installation owning the
  selected runtime endpoint.
- Unknown custom endpoints cannot be handed to Desktop; continue using them
  through CLI or MCP commands.
- In development, Desktop handoff requires the resolved worktree's own endpoint.
  A socket override alone cannot redirect an existing Desktop process.
- On Linux, strict handoff resolves the selected installation's AppImage
  directly (including custom prefixes) instead of a launcher name on `PATH`.
- On macOS, a bundled MCP/CLI opens its own absolute app bundle, even when
  another copy shares the display name. Standalone callers resolve the
  channel's CLI bundle first, then known Applications locations. An incomplete
  selected bundle errors; strict Nightly handoff never falls back to Stable.
- macOS `--cli` installs keep the signed app bundle under the installer prefix.
  Explicit `open` or `show_notebook` calls can launch Desktop from that bundle
  with its normal runtime startup. The installer's promise not to register or
  start a service applies to installation only, not a later Desktop launch. Use
  MCP `--no-show` to omit Desktop opening.

### Workstations

- Pairing registers a machine; serving makes it available for attachment.
  Neither means a notebook kernel is ready or a cell has executed.
- Workstation persistence currently uses Linux user systemd. macOS workstation
  service management is not yet supported.
- Hosted examples require a configured deployment and credentials; they do not
  imply a public hosted service.

## MCP

Register this stdio command with an MCP client:

```sh
nteract mcp
```

- `--no-show` omits the Desktop-opening tool.
- `--socket PATH` selects an existing explicit local endpoint. It does not
  authorize creating a second runtime with partially shared state.
- `nteract mcp` runs the resilient supervisor, which restarts its internal
  worker and preserves notebook target handoff. Protocol traffic uses stdout;
  diagnostics use stderr. Do not configure the hidden worker directly.
- Existing `nteract-mcp` registrations (supervised) and `runt mcp` invocations
  (direct worker) remain compatible without rewriting client configs.

## Runtime dependency and startup

| Operation | Local notebook daemon needed? |
| --- | --- |
| Help, tool discovery, configuration reads | No |
| Desktop notebooks, including hosted Desktop windows | Yes |
| Local notebook connection/creation through CLI or MCP | Yes; canonical commands can start an absent runtime |
| Direct hosted MCP connection | No |
| `cloud open` through the Desktop-style bridge | Yes |
| Workstation pairing or serving | No |

The `runtimed` executable bundles the local daemon, workstation agent, and
execution agent entry points. Needing that executable does not mean you need
its local daemon service. Local and hosted execution agents share the same
kernel execution loop.

### Discovery and admission

- Canonical notebook operations prefer an existing compatible runtime. Explicit
  channel, socket, and worktree selections constrain discovery.
- Compatibility checks wire and semantic API versions; matching build hashes
  are not required for ordinary admission.
- Programmatic CLI and MCP connections permit lazy startup only when an
  endpoint is definitely absent. Permission errors, timeouts, unknown protocol
  responses, and incompatible runtimes fail without repair, replacement, or
  automatic isolation fallback.
- A zero exit code from startup is not enough: the endpoint must report a
  compatible live runtime.
- Worktree isolation remains available. Changing only a socket does not isolate
  notebook storage, settings, or locks.

### Desktop bootstrap caveat

Desktop checks compatibility before its initial startup decision and leaves an
observed incompatible or uncertain endpoint alone. Its first-install path still
uses service installation, so a runtime appearing after the absence check can
race with that installation. Desktop bootstrap is not an atomic, non-replacing
operation.

Explicit runtime repair is governed by
[Daemon service repair and semantic compatibility](../adr/daemon-service-repair-and-semantic-compatibility.md).
