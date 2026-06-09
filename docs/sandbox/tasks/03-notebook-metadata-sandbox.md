# Task 03: Add `metadata.runt.sandbox` schema and read paths

## Framing

The notebook's sandbox profile lives at `metadata.runt.sandbox` in the Automerge document. This task defines the schema, adds it to the daemon's `RuntMetadata`, and provides typed read/write helpers. It does **not** wire the profile into kernel launch (task 07) or the UI (task 10) — only the data model.

This blocks tasks 05, 07, 09, and 10.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-5 (use --env-credential)**, **D-6 (profile location)**, **D-8 (permissions)**
- `docs/sandbox/ux-credential-sandbox-design.md` — the "three-layer stack" section and the profile schema example
- `docs/sandbox/nteract-network-architecture.md` — current `RuntMetadata` shape and read sites
- `crates/notebook-doc/AGENTS.md` if present

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

Currently `RuntMetadata` lives at `metadata.runt` in notebook documents and contains things like `uv.dependencies`. Unknown keys fall into a catch-all `extra: BTreeMap`. Adding a sandbox key is additive and backward compatible.

The profile schema, in YAML form, looks like this (this is illustrative — define it in Rust as the source of truth):

```yaml
sandbox:
  enabled: true
  credentials:
    - name: analytics_api
      description: "API key for the internal analytics service"
      env_var: ANALYTICS_API_KEY     # how it surfaces in the kernel env
      keystore_name: analytics_api   # name in macOS keychain (defaults to name)
      routes:
        - host: api.analytics.example.com
          inject_as: header           # header | basic-auth | query
          header: Authorization
          template: "Bearer {credential}"
  allowed_domains:
    - api.analytics.example.com
    - cdn.analytics.example.com
```

Important constraints from **D-5**:
- All user-defined credentials use nono's `--env-credential` (not `--credential`).
- The `env_var` field is what the kernel sees in its environment.
- The `template` is what the proxy substitutes when forwarding the request to the upstream.
- Credential **names** are stable identifiers that may appear in cell code via `os.environ["ANALYTICS_API_KEY"]`. Document this.

## Technical steps

### 1. Define the Rust types

In a new module `crates/notebook-doc/src/sandbox.rs` (or wherever `RuntMetadata` lives):

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxProfile {
    pub enabled: bool,
    pub credentials: Vec<CredentialRef>,
    pub allowed_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialRef {
    /// Stable identifier referenced in routing rules and surfaced to the agent.
    pub name: String,
    /// Human-readable description, used as the error message when the credential is missing.
    #[serde(default)]
    pub description: Option<String>,
    /// Environment variable name surfaced to the kernel (defaults to UPPER_SNAKE of name).
    #[serde(default)]
    pub env_var: Option<String>,
    /// Keychain entry name (defaults to name).
    #[serde(default)]
    pub keystore_name: Option<String>,
    pub routes: Vec<RouteRule>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteRule {
    pub host: String,
    pub inject_as: InjectionKind,
    /// Required when inject_as = Header.
    #[serde(default)]
    pub header: Option<String>,
    /// Template string with literal {credential} placeholder.
    pub template: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InjectionKind {
    Header,
    BasicAuth,
    Query,
}
```

Provide derived defaults:
- `effective_env_var(&self)` — returns explicit `env_var` or `name.to_ascii_uppercase().replace('-', "_")`
- `effective_keystore_name(&self)` — returns explicit `keystore_name` or `name`

### 2. Add to `RuntMetadata`

```rust
pub struct RuntMetadata {
    // ... existing fields ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxProfile>,
}
```

`Option<SandboxProfile>` (not `SandboxProfile`) is important — `None` means "no sandbox configured" and is the opt-in default per **D-3**.

### 3. Reader and writer helpers

Add helpers to read and write `metadata.runt.sandbox` through the existing notebook metadata API. The exact location depends on how `RuntMetadata` is currently surfaced in `crates/runtimed/src/notebook_sync_server/metadata.rs`. Keep the API minimal:

```rust
/// Returns the sandbox profile from the notebook's runt metadata, or None if absent or disabled.
pub fn read_sandbox_profile(notebook_doc: &NotebookDoc) -> Option<SandboxProfile>;

/// Writes the sandbox profile to the notebook's runt metadata.
pub fn write_sandbox_profile(
    notebook_doc: &mut NotebookDoc,
    profile: Option<SandboxProfile>,
) -> Result<(), MetadataError>;
```

`write_sandbox_profile(_, None)` removes the field cleanly.

### 4. Validation

Implement a `validate()` method on `SandboxProfile` that returns a `Vec<ProfileValidationError>`:

- All credential `name` values must be unique
- All credential `name` values must match `^[a-zA-Z][a-zA-Z0-9_]*$`
- All `host` values in routes must be valid hostnames (no schemes, no paths)
- `allowed_domains` entries must be valid hostnames
- Each `RouteRule` with `inject_as = Header` must set `header`
- Each `template` must contain the literal substring `{credential}`

Validation runs on read (via a thin wrapper) and on write. Invalid profiles are logged and rejected.

### 5. Tests

- Round-trip: serialize a profile, write to metadata, read back
- Backward compat: read a notebook with no `sandbox` key → returns `None`
- Validation: each rule has at least one positive and one negative test
- Removal: `write_sandbox_profile(_, None)` clears the field

### 6. Document the schema

Add a doc page or expand an existing one. Where this lives is up to you — perhaps a new section in `crates/notebook-doc/AGENTS.md`. Document:
- What lives in the profile (names and routing only — never secret values)
- That credentials must exist in the keychain at launch time
- That `name` values are stable identifiers visible to cell code
- The validation rules

## Interfaces produced

- `notebook_doc::SandboxProfile`, `CredentialRef`, `RouteRule`, `InjectionKind`
- `RuntMetadata::sandbox: Option<SandboxProfile>`
- `read_sandbox_profile`, `write_sandbox_profile` helpers
- `SandboxProfile::validate()`
- A documented schema reference

Consumers: task 05 (translates `SandboxProfile` to nono YAML), task 07 (reads at launch), task 09 (MCP tools), task 10 (UI).

## Success criteria

- `cargo xtask lint --fix` passes
- All existing notebook-doc tests pass
- New tests cover round-trip, backward compat, validation, and removal
- A notebook with no `sandbox` key continues to behave exactly as today
- A notebook with a malformed `sandbox` is logged with a typed validation error and treated as `None`

## In scope

- Rust types and serde
- Read/write helpers on `RuntMetadata` and notebook documents
- Validation
- Schema documentation
- Unit tests

## Out of scope

- Translating profiles to nono YAML — task 05
- Spawning nono — task 04
- Reading the profile during kernel launch — task 07
- The UI for editing the profile — task 10
- MCP tools for managing the profile — task 09
- Migrating any existing notebooks (none have this field yet)
- Storing actual credential **values** in any form — values live only in the keychain (per **D-9**)
