# Environment Sandbox Policy Design

**Status:** Exploration, 2026-06-16.

---

## First Principles

These principles ground every design decision that follows.

### 1. Package managers own their security boundary

uv, conda, and pixi are responsible for the integrity of their own caches,
environment prefixes, and install operations. nteract trusts each package
manager to police within its own domain and does not attempt to layer
additional controls on top of that. If a malicious package can subvert the
package manager's own integrity guarantees — poisoning a cache, corrupting a
prefix — that is a bug in the package manager, not a gap nteract is responsible
for closing.

### 2. The sandbox protects the user's broader system

The sandbox's mandate is to prevent package manager operations from escaping
into OS-level territory that has nothing to do with package management:
credential files, shell configs, dot-files, global directories, and other
sensitive user data. This is a meaningful and achievable goal. The sandbox is
not a control over what happens within the package manager's own domain.

### 3. Wheels are the preferred distribution format; sdist is opt-in

Wheels are now the common distribution format on PyPI. A wheel is a static
archive: extracting it executes no user code. sdists require a build step that
runs arbitrary Python. nteract prioritizes wheel-based installs and treats sdist
builds as an explicit opt-in, not a silent fallback. The same logic applies to
conda: binary archives are preferred; post-link scripts are opt-in.

### 4. nteract package installs are isolated from global caches

nteract executes all Python in a sandboxed context. Packages installed for use
inside nteract must not share caches with packages installed outside nteract,
which may have no sandboxing or isolation model. Mixing the two creates
confusion about which packages have been vetted for sandbox execution and
contaminates the nteract environment with installs that were never subject to
nteract's trust model. nteract maintains its own cache directories, separate
from the user's global package manager caches.

### 5. Arbitrary execution requires per-notebook isolation

If a notebook opts into modes that permit arbitrary execution during environment
creation — sdist builds, conda post-link scripts, or similar — the entire
environment, including caches, must be per-notebook. This prevents
cross-contamination between notebooks: a malicious or buggy package in one
notebook's dependency set cannot affect another notebook's environment. This is
a contamination-isolation requirement, not a security claim.

---

## Sandbox Modes

There are three sandbox modes for package installation. The user-facing choice
is binary — sandboxed or not — and the system selects between `restricted` and
`standard` automatically based on context. The user never manually picks
`restricted`.

### restricted

Activated automatically when a notebook arrives from an untrusted source, or
when the user opts into sdist builds or post-link scripts for an existing
notebook (per principle 5).

- **Cache**: scoped to the notebook's own environment prefix. The package
  manager cache directory is placed inside the prefix (e.g. `<prefix>/.cache/`)
  so that deleting the environment also deletes the cache. No cross-notebook
  cache sharing.
- **Filesystem writes**: limited to the environment prefix. All writes outside
  the prefix are denied by the sandbox.
- **Filesystem reads**: the environment prefix, the package manager binary and
  its required shared libraries, and standard system library paths.
- **Outbound network**: restricted to an explicit allowlist of known package
  index hostnames (e.g. `pypi.org`, `files.pythonhosted.org`,
  `conda.anaconda.org`). All other outbound connections are denied.
- **sdist / post-link**: disabled by default. The user can opt in explicitly,
  which keeps the mode as `restricted` (the per-notebook cache already satisfies
  principle 5).

### standard

The default mode for sandboxed operation.

- **Cache**: the nteract-global cache under `~/.cache/runt/` (or platform
  equivalent). Shared across notebooks. Write access to this directory is
  granted; integrity within it is the package manager's responsibility (principle 1).
- **Filesystem writes**: the nteract-global cache and the environment prefix.
  All writes outside these directories are denied.
- **Filesystem reads**: same as `restricted`, plus the nteract-global cache.
- **Outbound network**: same explicit allowlist as `restricted`.
- **sdist / post-link**: disabled by default. If the user opts in, the mode
  automatically tightens to `restricted` (per-notebook cache) to satisfy
  principle 5.

### off

Runs without any sandbox. Equivalent to today's behavior.

- **Cache**: the package manager's own global cache (`~/.cache/uv`,
  `~/.cache/rattler`, etc.), shared with all non-nteract installs.
- **Filesystem**: no restrictions.
- **Network**: no restrictions.
- **sdist / post-link**: permitted by default.

This mode exists as an explicit escape hatch for cases where the sandbox
cannot be made to work (unsupported platform, unusual enterprise environment,
complex native builds). Its use is surfaced visibly in the UI.

---

## Code Execution Opt-in

By default, nteract installs packages in a way that executes no user-supplied
code. There are two mechanisms during package installation that can break this
property:

- **sdist builds**: when a PyPI package has no pre-built wheel available for
  the current platform and Python version, the package manager must download the
  source distribution and compile a wheel from it. This runs arbitrary Python —
  `setup.py`, PEP 517 build backends, and any native build tooling they invoke.
- **Post-link scripts**: conda packages may include a shell script
  (`bin/.<name>-post-link.sh` on Unix, `Scripts/.<name>-post-link.bat` on
  Windows) that runs after the package's files have been extracted into the
  environment prefix. These scripts run arbitrary shell code.

Both are disabled by default. When either would be required, nteract detects
this, notifies the user, and asks whether to proceed. If the user opts in, the
environment is recreated under `restricted` mode (per-notebook cache, per
principle 5).

### Detection by package manager

**uv (PyPI packages)**

uv is invoked with `--no-build` by default, which causes it to fail immediately
if any package in the resolution requires an sdist build. The error message
names the package and version. nteract parses this error and surfaces the
offending package to the user.

**pixi (PyPI dependencies via uv)**

The same `--no-build` / `pypi-options: no-build: true` applies to pixi's PyPI
dependency resolution, which delegates to uv. Detection is identical.

**pixi (conda packages)**

Since pixi 0.44.0 (prefix-dev/pixi#3347), pixi does not execute post-link
scripts by default. When a package that ships a post-link script is installed,
pixi emits a warning naming the package. nteract surfaces this warning to the
user rather than letting it pass silently.

**conda/rattler (direct)**

nteract uses the rattler library directly for conda installs and never calls
`.with_execute_link_scripts(true)`. Post-link scripts are extracted into the
prefix but not executed. After installation, nteract scans `$PREFIX/bin/` (Unix)
or `$PREFIX/Scripts/` (Windows) for hidden `.<name>-post-link.*` files to
identify any packages that shipped post-link scripts, and surfaces them to the
user.

### Remediation

When a blocked sdist build or a skipped post-link script is detected, nteract
notifies the user with the names of the affected packages and asks whether to
proceed. If the user confirms, the environment is recreated from scratch with
the relevant opt-in enabled (`--no-build` removed for sdists, or
`.with_execute_link_scripts(true)` for conda post-link scripts), and the sandbox
mode is automatically set to `restricted` for that notebook.

---

## Sandbox Denials and Customization

### Successful build with denials

When an environment build completes successfully but the sandbox denied some
filesystem or network accesses, nteract does not surface this to the user. The
denials are written to debug logs only. In the common case, denied paths during
a successful build are optional probes — credential files, package manager
config, private registry endpoints — that the tool checked for, didn't find
accessible, and continued without. Surfacing these would train users to
reflexively widen the sandbox after every successful build.

### Failed build with denials

When an environment build fails and the sandbox denied one or more accesses,
nteract collects the full set of denied paths and network calls from the sandbox
audit log in a single pass and presents them to the user:

> **Environment build failed.** The sandbox blocked the following accesses.
> Select any you want to allow and retry:
>
> - [ ] `~/.netrc` (read)
> - [ ] `~/.config/pip/pip.conf` (read)
> - [ ] `internal-pypi.company.com` (outbound network)
>
> **[ Retry with selected ]** **[ Retry without sandbox ]** **[ Cancel ]**

All items are unchecked by default. The user must actively select each one.
"Retry with selected" is disabled until at least one item is checked. "Retry
without sandbox" is an explicit escape hatch that drops to `off` mode; its use
is recorded and surfaced visibly in the UI.

### Ephemeral opt-ins

Grants selected in the denial dialog are held in memory for the current session
only. They are not written to the notebook file, the environment, or any
settings file, and they do not persist across notebook reopens. Every new
session starts from the default sandbox policy.

### Saving a custom pack

After a session in which ephemeral grants were used, nteract offers the user
the option to save those grants as a named local sandbox pack:

> This session allowed extra sandbox access during environment build.
> Save as a reusable pack?
> Name: [ my-data-env ]
> **[ Save ]** **[ Dismiss ]**

The pack is stored in the machine-local pack store
(`~/.config/nono/profiles/my-data-env.json`). It extends the session's base
sandbox mode and adds only the grants the user explicitly approved. The user
can then reference this pack by name in the notebook metadata (see below),
edit the pack file directly, or share it out-of-band with colleagues.

### Per-notebook pack reference

A notebook may include a pack name in its metadata. This is a lookup key
into the user's local pack store — nothing more. It contains no capability
grants and provides no escalation path on its own.

```jsonc
// metadata.runt.sandbox
{
  "env": "my-data-env"
}
```

When the daemon sees this hint, it looks for `my-data-env` in the local pack
store. If the pack exists, it is used as the sandbox policy for that
notebook's environment builds. If it does not exist, the daemon falls back to
the default sandbox mode silently — the missing pack is noted in debug logs
but does not cause an error or prompt.

Only locally user-created packs may be referenced this way. There is no
registry resolution and no remote pack fetching. A notebook cannot reference
a pack that the user has not already explicitly created on their machine.
