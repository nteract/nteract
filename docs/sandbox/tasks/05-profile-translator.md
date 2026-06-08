# Task 05: Profile translator

## Framing

Convert a notebook's `SandboxProfile` (defined in task 03) into a nono CLI configuration: a temp YAML file plus the `--env-credential` flags that need to appear on the nono command line. This is a pure, well-tested function — no IO beyond the temp file itself.

This depends only on task 03. It blocks task 07.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-5 (use --env-credential)**, **D-6**, and the empirical truth table at the bottom
- `docs/sandbox/nono-empirical-tests.md` — what flags exist, what does not
- `docs/sandbox/nono-sh-investigation.md` — the proxy mode, header injection, and routing model

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

nono's profile YAML supports network credentials and routing rules. The exact schema may change between minor versions; this task should produce YAML that nono `0.62.x` accepts. The pinned version constant is exposed by task 01 as `runtimed::nono::NONO_VERSION`.

Per **D-5**:
- Custom credentials use `--env-credential <name>` on the CLI **and** are described in the profile
- The fixed-set `--credential` is reserved for nono's built-in service integrations (anthropic, openai, etc.) and is **not** used in the MVP

Per **D-6** the profile contains only credential names and routes — never values. The translation must not attempt to read the keychain.

## Technical steps

### 1. Module skeleton

Add `crates/runtimed/src/nono/profile.rs` (re-export from `crates/runtimed/src/nono/mod.rs`).

```rust
pub struct TranslatedProfile {
    pub profile_yaml_path: TempPath,         // tempfile::TempPath, auto-removed on drop
    pub env_credential_flags: Vec<String>,    // e.g. ["--env-credential", "analytics_api"]
    pub kernel_env_overrides: Vec<(OsString, OsString)>, // env vars the kernel must see (e.g. proxy URL hints)
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileTranslationError {
    #[error("invalid profile: {0}")]
    Invalid(String),
    #[error("io error writing temp profile: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml serialize error: {0}")]
    Yaml(#[from] serde_yaml::Error),
}

pub fn translate(profile: &SandboxProfile) -> Result<TranslatedProfile, ProfileTranslationError>;
```

### 2. The YAML structure to emit

The exact shape depends on what nono `0.62.x` accepts. Verify against the installed `nono` (the implementer should have nono available). The shape will be approximately:

```yaml
network:
  proxy:
    enabled: true
  credentials:
    - name: analytics_api
      description: "API key for analytics"
      routes:
        - host: api.analytics.example.com
          inject:
            kind: header
            header: Authorization
            template: "Bearer {credential}"
  allowed_hosts:
    - api.analytics.example.com
    - cdn.analytics.example.com
```

If the actual nono schema differs, adapt — the `SandboxProfile` is the source of truth for our domain; the YAML is just the wire format we hand to nono. Document the exact mapping in the module's doc comment.

### 3. CLI flag generation

For each credential in the profile, emit:

```
--env-credential <effective_keystore_name>
```

`effective_keystore_name` comes from `CredentialRef::effective_keystore_name()` (defined in task 03).

Order: deterministic (sort by name) so two equal profiles produce identical command lines.

### 4. Kernel env overrides

If the kernel needs any environment hint (e.g. nono's proxy URL or an `HTTPS_PROXY` injection), emit them in `kernel_env_overrides`. Verify what nono actually requires the child to see:

- nono normally injects proxy env vars into the child automatically — confirm this and document it
- If nono does not inject, set `HTTPS_PROXY` and `HTTP_PROXY` here pointing at the local proxy URL
- Surface the credentials' `effective_env_var()` mappings as kernel env vars holding the **phantom token** (the proxy validates and substitutes; this is the env var users reference in their cell code)

If you cannot definitively confirm what nono injects automatically vs. requires us to pass through, prefer the safer behavior (pass them through explicitly) and add a comment.

### 5. Temp file lifecycle

Use the `tempfile` crate (`tempfile::NamedTempFile` → `into_temp_path()`). Files are created with mode `0600`. The `TempPath` deletes the file on drop, so the supervisor (task 04) must hold ownership of the `TranslatedProfile` for the kernel session lifetime.

Files are written to the system temp directory by default. That is fine — they contain only credential names and routes.

### 6. Validation pass

Before writing the YAML, re-validate the profile via `SandboxProfile::validate()` (task 03). Translation never produces a YAML for an invalid profile.

### 7. Tests

- Round-trip: `translate(profile)` produces a YAML file; reading it back via `serde_yaml` gives a structurally equivalent value
- Determinism: two `translate(&p)` calls produce byte-identical YAML
- Flag ordering is deterministic
- Disabled profile (`enabled: false`) returns an error: callers must not translate a disabled profile (task 07 is responsible for the opt-in check)
- Empty credentials and empty allowed_domains both work (allowed_domains can be empty if no domain restriction is desired)
- `TempPath` is cleaned up when dropped

## Interfaces produced

- `runtimed::nono::profile::translate(&SandboxProfile) -> Result<TranslatedProfile, ProfileTranslationError>`
- `TranslatedProfile { profile_yaml_path, env_credential_flags, kernel_env_overrides }`

Consumed by task 07 only.

## Success criteria

- The function is pure given a profile (modulo creating a temp file)
- Generated YAML is accepted by `nono run --profile <path> -- /bin/true` against the pinned nono version (a manual validation, document the verification step)
- `cargo xtask lint --fix` passes
- Unit tests cover validation, determinism, and temp file lifecycle

## In scope

- The translation function
- YAML emission
- Flag generation
- Kernel env override calculation
- Tests

## Out of scope

- Reading the notebook document — task 03 already exposes `read_sandbox_profile`
- Spawning nono — task 04
- Anything related to credential **values** — translation must never read the keychain
- The opt-in check (do we even need to translate?) — task 07 owns the gate
- Wiring into MCP or UI — tasks 09 and 10
- Documentation of the user-facing schema — that lives in task 03's deliverables
