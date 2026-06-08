# Task 09: MCP tools for sandbox + credentials

## Framing

Expose sandbox functionality to AI agents via MCP. Specifically:
- A way to list credential **names** (never values) available on the machine
- A way to author/read a notebook's sandbox profile
- A way to inspect the sandbox status of an active runtime
- Annotation surfacing in the existing execution-result tools

Depends on tasks 02 (annotations) and 03 (profile schema). Can run in parallel with tasks 10 and 11.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-9 (agents cannot create credentials)**, **D-10 (no live prompts)**
- `docs/sandbox/ux-credential-sandbox-design.md` — Story B (headless agent flow), the MCP tool surface section
- `docs/sandbox/error-routing-design.md` — how MCP execution results expose `sandbox_event`
- `crates/runt-mcp/src/tools/` — existing tool patterns (read `mod.rs`, `cell_read.rs`, `execution.rs`, `kernel.rs` for conventions; do not modify)

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

The MCP server (`runt-mcp`) is a long-lived process that proxies notebook operations to the daemon. It exposes typed tools to MCP clients (Claude Desktop, etc.). Tools follow a consistent shape: a Rust struct with `#[derive]` for serde, a handler function, and a registration in `mod.rs`.

Per **D-9**: agents read credential names but cannot create credentials. The credential-create flow is human-only via the UI (task 10) or `security` CLI.

Per **D-10**: agents must pre-declare full domain allowlists. There is no in-flight allow/reject prompt API.

## Technical steps

### 1. Tool: `list_credentials`

Returns the names of credentials the daemon is aware of. Two sources:

- **Profile-referenced credentials**: the union of credential names referenced by every open notebook's sandbox profile. The daemon already has these via task 03's `read_sandbox_profile`.
- **Keychain credentials with the nono prefix**: optionally, query macOS `security` CLI for entries in a known service prefix (e.g. `nono.<name>`). This is a soft-fail enumeration; it is not authoritative, since the keychain may have entries the daemon doesn't know to look for.

Tool schema:

```rust
struct ListCredentialsArgs {} // no args

struct ListCredentialsResponse {
    credentials: Vec<CredentialInfo>,
}

struct CredentialInfo {
    name: String,
    /// True if confirmed present in the keychain via security find-generic-password
    keychain_present: bool,
    /// True if any open notebook references this name
    referenced_by_notebook: bool,
    /// Description from any notebook profile that references it (first non-empty wins)
    description: Option<String>,
}
```

The tool does **not** return any secret value. Ever.

### 2. Tool: `get_notebook_sandbox_profile`

Reads the current `metadata.runt.sandbox` for a given notebook.

```rust
struct GetNotebookSandboxProfileArgs {
    notebook_id: String,
}

struct GetNotebookSandboxProfileResponse {
    /// None if the notebook has no profile configured
    profile: Option<SandboxProfile>,
}
```

`SandboxProfile` is the type from task 03; reuse it directly (re-export through MCP types or wrap with a thin DTO if necessary for serde JSON shape).

### 3. Tool: `set_notebook_sandbox_profile`

Writes (or removes) the sandbox profile for a notebook.

```rust
struct SetNotebookSandboxProfileArgs {
    notebook_id: String,
    /// Pass null to remove the profile
    profile: Option<SandboxProfile>,
}

struct SetNotebookSandboxProfileResponse {
    /// Validation errors discovered before write. Empty if successful.
    validation_errors: Vec<String>,
    /// Names of credentials referenced by the new profile that are NOT present in the
    /// keychain. The agent should surface this to the user so they can add them.
    missing_credentials: Vec<String>,
}
```

The tool calls task 03's `validate()` first; on validation failure, it returns errors without writing. On success, it writes via `write_sandbox_profile` and returns missing credentials as a soft warning.

### 4. Tool: `get_sandbox_status`

Reports the active sandbox state for a runtime.

```rust
struct GetSandboxStatusArgs {
    runtime_id: String,
}

struct GetSandboxStatusResponse {
    state: SandboxStateDto,
}

#[serde(tag = "type")]
enum SandboxStateDto {
    Disabled,
    Active { nono_pid: u32, kernel_pid: u32, session_id: Option<String> },
    StartupFailed { reason: String, stderr_tail: Vec<String> },
    Degraded { reason: String },
}
```

Reads from the runtime's session state (the `SandboxState` produced by task 07). Map the daemon-side enum to the DTO.

### 5. Surface annotations in execution results

The existing execution-result tools (read `crates/runt-mcp/src/tools/execution.rs` and `cell_read.rs` for shape — but **do not modify other tools' contracts**). Add an optional `sandbox_event: Option<CellAnnotationDto>` field to whatever response shape returns cell outputs after an execution.

```rust
struct CellAnnotationDto {
    kind: String,
    message: String,
    details: Option<serde_json::Value>,
}
```

Pull the annotation from `RuntimeStateDoc.cell_annotations[execution_id]` (task 02 provides the read path).

If the field is added to existing tools, default-initialize to `None` for non-sandbox runtimes so old MCP clients are unaffected.

### 6. Registration

Register the new tools in `crates/runt-mcp/src/tools/mod.rs`. Add a new module file `sandbox.rs` for these tools so they are co-located.

### 7. Tests

- Unit tests for each tool's happy path
- `set_notebook_sandbox_profile` with an invalid profile returns validation errors and does not write
- `set_notebook_sandbox_profile` with missing keychain entries returns the names in `missing_credentials`
- `list_credentials` never includes a value field
- `get_sandbox_status` returns `Disabled` for a runtime without a profile
- An execution result on a sandboxed runtime that triggered a domain block surfaces the annotation in `sandbox_event`

## Interfaces produced

- `list_credentials` MCP tool
- `get_notebook_sandbox_profile` MCP tool
- `set_notebook_sandbox_profile` MCP tool
- `get_sandbox_status` MCP tool
- `sandbox_event` field added to existing execution result tools

Consumed by external MCP clients (e.g. Claude Desktop). No internal consumers.

## Success criteria

- All four tools register and respond correctly
- No tool ever returns a credential value
- Validation errors surface clearly
- `cargo xtask lint --fix` passes
- Tests pass

## In scope

- The four new MCP tools and their handlers
- Adding `sandbox_event` to execution result responses
- Tool registration
- Tests

## Out of scope

- Creating credentials (per **D-9**, only humans can)
- A `delete_credential` tool — same reason
- Live network call prompts (per **D-10**)
- Modifying any existing tool's required arguments — only optional response fields may be added
- UI work — that is task 10/11
- Translating profiles to nono YAML — that is task 05 (used by daemon, not MCP)
- Any tool that exposes the audit log directly (deferred until UX is designed)
