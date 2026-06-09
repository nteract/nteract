# Task 10: UI credential manager and profile editor

## Framing

Add the UI surfaces a human user needs to:
1. Add, list, and delete credentials in the macOS Keychain
2. Author a notebook's sandbox profile (which credentials apply to which routes; what domains are allowed)

Depends on task 03 (profile schema). Can run in parallel with tasks 09 and 11.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-6, D-8, D-9, D-10**
- `docs/sandbox/ux-credential-sandbox-design.md` — Story A (UI user flow), all UI mockups and copy
- `docs/sandbox/nteract-network-architecture.md` — Tauri ↔ daemon transport, since credential CRUD must go through this
- `apps/notebook/src/AGENTS.md` — frontend conventions
- `src/components/ui/AGENTS.md` — Shadcn UI conventions
- `apps/notebook/src/components/NotebookToolbar.tsx` for an example of a notebook-level UI surface

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

Two distinct UI surfaces, with separate data models:

**Credentials (machine-local, not notebook-scoped):**
- Stored in macOS Keychain under a known service prefix (recommend `nono.<name>` for compatibility with nono's lookup)
- The Tauri app calls into a daemon RPC or directly into a Tauri command that wraps the macOS `security` framework
- The user provides: name (alphanumeric + underscore), description, value (the secret)
- Operations: list (names + descriptions), add, update value, delete

**Notebook profile (lives in the open document):**
- Edits flow through Automerge, so multiple users editing the same notebook see updates live
- The user provides: enabled flag, the credentials this notebook references (by name), per-credential routes (host + injection), allowed_domains
- A notebook may reference a credential that does not exist on the current machine; the UI must surface this clearly

Per **D-9**, all credential CRUD is human-only (the agent surface from task 09 only lists names). This task is the only place credentials get **created**.

## Technical steps

### 1. Credential manager backend channel

The Tauri app needs to read/write the keychain. Options:

- **Tauri command** that wraps `security` CLI or the `keyring` crate — simplest, runs in the trusted Tauri shell
- **Daemon RPC** if the daemon also needs to manage credentials — but the daemon already only **reads** keychain entries (via nono); writes are a UI responsibility

Recommend a Tauri command in `crates/notebook-tauri/` (or wherever Tauri commands currently live) backed by the `keyring` crate. This keeps credential writes off the daemon's surface area.

Tauri commands:

```rust
#[tauri::command]
async fn list_credentials() -> Result<Vec<CredentialMeta>, String>;

#[tauri::command]
async fn add_credential(name: String, description: Option<String>, value: String) -> Result<(), String>;

#[tauri::command]
async fn update_credential_value(name: String, value: String) -> Result<(), String>;

#[tauri::command]
async fn delete_credential(name: String) -> Result<(), String>;
```

`CredentialMeta` carries name and description only — never the value. Description can be stored in a separate keychain item or as a generic-password attribute.

Validate `name` against `^[a-zA-Z][a-zA-Z0-9_]*$` (matches task 03's validation). Reject names that begin with `nono-builtin-` or other reserved prefixes if any apply.

### 2. Credential manager UI

A new sidebar or modal panel: "Credentials." Reachable from the global app menu and from the notebook sandbox panel (next surface).

Components:

- **List view**: shows all credentials with name + description; a "Used by N notebooks" badge if data is available (best-effort; can be omitted in MVP)
- **Add credential dialog**: name (text), description (text, optional), value (password input, masked)
- **Edit credential dialog**: edits description and/or rotates the value (cannot rename — names are stable identifiers)
- **Delete credential**: confirms with a warning that any notebook referencing this credential will fail to launch a sandboxed kernel

Empty state copy: "No credentials yet. Credentials are stored in your macOS Keychain and are scoped to this user account."

Copy on errors:
- Keychain access denied: "macOS denied access to the keychain. Click the keychain prompt or check Keychain Access permissions."
- Duplicate name: "A credential named `{name}` already exists. Use Edit to update its value."

### 3. Notebook sandbox panel

A panel in the notebook UI (recommend a dropdown or side-sheet from the toolbar) showing the current profile and allowing edits.

Top of panel:
- A status badge: "Sandbox: Active / Off / Misconfigured"
- An enabled/disabled toggle that maps to `SandboxProfile.enabled`

Sections:

- **Credentials in use** — a table listing each `CredentialRef` with its name, description, and a presence indicator (green check if the credential exists on this machine, red exclamation if missing). "Add credential reference" button opens a dialog letting the user pick a credential (name from the Credential Manager) and configure routes.
- **Allowed domains** — a simple add/remove list of hostnames

When adding a credential reference:
- Name picker (autocomplete from existing keychain credentials, but the user can also type a name that does not yet exist — this becomes a "missing" reference until the credential is added)
- Description (auto-filled from keychain metadata if available)
- Routes:
  - Host (text)
  - Injection kind (dropdown: header / basic-auth / query)
  - Header name (text, only if injection = header)
  - Template (text, must contain `{credential}` literal — validate inline)

Validate via task 03's `SandboxProfile::validate()` semantics on the client side (re-implement the validation rules in TypeScript, matching exactly). Inline error messages on each field.

Save flow: write `SandboxProfile` to `metadata.runt.sandbox` via the existing notebook metadata write path. The daemon picks it up next launch.

### 4. Missing credential affordance

If the profile references a credential that is not in the keychain, show:
- A red row in the credentials table
- A button labelled "Add credential" that opens the credential manager pre-filled with the name

This is the load-bearing UX for the **portability cliff** mentioned in the design doc: a notebook authored on machine A may have credentials machine B lacks.

### 5. Tests

- Component tests for the credential manager list, add, edit, delete flows
- Component test for the sandbox panel: rendering, validation errors, missing credential indicator
- Tauri command tests for round-trip credential storage on macOS (skip on other platforms in the test runner)
- Validation match: TypeScript validator and Rust `SandboxProfile::validate` agree on a fixture set of valid/invalid profiles

### 6. Documentation

Add a doc page (or update an existing user guide) explaining:
- Credentials are stored in your macOS Keychain
- Names are stable identifiers — agents and notebook code reference them
- Sharing a notebook does not share credentials; recipients must add credentials with the same names
- The sandbox panel is per-notebook

## Interfaces produced

- Tauri commands: `list_credentials`, `add_credential`, `update_credential_value`, `delete_credential`
- Frontend components: `CredentialManager`, `SandboxPanel`
- TypeScript validator matching task 03's Rust validator

Consumed by users only.

## Success criteria

- A user can add a credential and see it referenced in a notebook profile
- A user can edit a notebook's profile and the changes are reflected on next kernel launch
- A user can delete a credential; affected notebooks show the missing-credential indicator
- All UI text matches the copy in `ux-credential-sandbox-design.md`
- TypeScript and Rust validators agree on a shared fixture set
- `cargo xtask lint --fix` and frontend lint commands pass

## In scope

- Tauri commands for keychain CRUD
- Credential manager UI
- Sandbox panel UI in the notebook
- Inline validation
- Missing-credential affordance
- Tests
- User documentation

## Out of scope

- The status badge that shows "active / degraded / failed" runtime state — that's task 11 (different data source: it reflects `SandboxState` from a running runtime, not the static profile)
- Cell-level annotation overlays — task 11
- Sharing credentials across machines (out of scope for MVP)
- Syncing credentials via iCloud Keychain (out of scope, but acceptable as an emergent behavior — do nothing to prevent it, do nothing to encourage it)
- Importing credentials from .env files (defer)
- Real-time prompts for new domains (per **D-10**)
- Linux keyring support (MVP is macOS-first; build defensively so it can be added)
