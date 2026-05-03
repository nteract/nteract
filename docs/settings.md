# Settings

nteract Desktop settings control default behavior for new notebooks, appearance, and runtime configuration.

## Quick Reference

| Setting | Options | Default | Stored In |
|---------|---------|---------|-----------|
| Theme | light, dark, system | system | `settings.json` + live Automerge sync |
| Default runtime | python, deno | python | `settings.json` + live Automerge sync |
| Default Python env | uv, conda | uv | `settings.json` + live Automerge sync |
| Default uv packages | list of strings | (empty) | `settings.json` + live Automerge sync |
| Default conda packages | list of strings | (empty) | `settings.json` + live Automerge sync |
| Keep alive secs | integer | 30 | `settings.json` + live Automerge sync |
| Onboarding completed | boolean | false | `settings.json` + live Automerge sync |

## How Settings Sync Works

Settings are persisted in `settings.json` and synced across all notebook windows via the runtimed daemon using an in-memory Automerge document. Each notebook window maintains a local replica.

- **Source of truth:** `settings.json`
- **Live sync:** The daemon keeps an in-memory Automerge settings document for cross-window updates
- **External edits:** The daemon watches `settings.json` for external changes (manual edits, CLI tools) and propagates them to all connected windows automatically
- **Migration:** A legacy `settings.automerge` file is read only when `settings.json` is missing, then written out as JSON
- **Theme special case:** Theme also uses webview localStorage to prevent a flash of unstyled content on startup

When you change a setting in any window, it propagates to all other open windows in real time.

### Automerge Document Structure

The synced settings use nested maps for environment-specific configuration:

```
ROOT/
  theme: "system"
  default_runtime: "python"
  default_python_env: "uv"
  keep_alive_secs: 30
  onboarding_completed: false
  uv/                                         ← nested Map
    default_packages: List["numpy", "pandas"] ← List of Str
  conda/                                      ← nested Map
    default_packages: List["scipy"]           ← List of Str
```

Environment-specific settings (packages, future: channels) live under `uv/` and `conda/` sub-maps, making the schema extensible without adding more root-level keys.

## Settings File

Settings are persisted to a JSON file shared across all notebook windows. The daemon and CLI write the same nested JSON format.

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/nteract/settings.json` |
| Linux | `~/.config/nteract/settings.json` |
| Windows | `C:\Users\<User>\AppData\Roaming\nteract\settings.json` |

The file is created automatically on daemon startup. You can also edit it by hand — changes are detected and applied automatically when the daemon is running.

Example:

```json
{
  "theme": "system",
  "default_runtime": "python",
  "default_python_env": "uv",
  "uv": {
    "default_packages": ["numpy", "pandas", "matplotlib"]
  },
  "conda": {
    "default_packages": ["numpy", "pandas", "scikit-learn"]
  }
}
```

### JSON Schema

The settings struct derives `schemars::JsonSchema`. `SyncedSettings` (in runtimed) defines the canonical schema used by both the daemon and the notebook app.

## Theme

Controls light/dark appearance for the notebook editor and output viewer.

- **Light** — forces light mode
- **Dark** — forces dark mode
- **System** — follows your OS preference and updates automatically when it changes

Change the theme by clicking the gear icon in the notebook toolbar, then selecting Light, Dark, or System.

## Default Runtime

Determines which runtime is used when creating a new notebook with **Cmd+N** (or **Ctrl+N** on Windows/Linux).

```json
{
  "default_runtime": "python"
}
```

Valid values: `"python"`, `"deno"`

You can always create a notebook with a specific runtime using the **File > New Notebook As...** submenu.
You can open an existing notebook from the file picker using **File > Open > Open...**.
Bundled example notebooks are available under **File > Open > Sample Notebooks**.

## Default Python Environment

Controls which package manager is used for Python notebooks when no project-level configuration is detected.

```json
{
  "default_python_env": "uv"
}
```

Valid values: `"uv"`, `"conda"`

- **uv** — uses uv for package management (fast, pip-compatible)
- **conda** — uses conda/rattler for package management (supports conda packages)

If the notebook directory contains a `pyproject.toml` or `environment.yml`, the environment type is determined by that file instead of this setting.

## Default Packages

Controls which packages are pre-installed in prewarmed environments. These packages are available immediately when you open a new notebook, without needing to add them as inline dependencies.

Since uv and conda have different package ecosystems, packages are configured separately:

```json
{
  "uv": {
    "default_packages": ["numpy", "pandas", "matplotlib"]
  },
  "conda": {
    "default_packages": ["numpy", "pandas", "scikit-learn"]
  }
}
```

Changes take effect on the next pool replenishment cycle — existing prewarmed environments keep their original packages until replaced. Restarting the app clears the pool and rebuilds with the updated packages.

The packages are installed alongside `ipykernel` and `ipywidgets` (which are always included).
