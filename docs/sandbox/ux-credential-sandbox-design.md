# UX Design: Credential Management & Network Sandbox

**Date:** 2026-06-08  
**Status:** Design proposal — no code changed  
**Scope:** UX and systems design for integrating nono.sh credential injection into nteract,
covering both the desktop GUI user (Story A) and the headless AI agent user (Story B).

**Prerequisite reading:**
- `nono-sh-investigation.md` — nono.sh architecture, proxy mechanics, credential injection model
- `nteract-network-architecture.md` — daemon, runtime-agent, kernel process model, env var flow

---

## Table of Contents

1. [Mental model: the three-layer stack](#1-mental-model)
2. [Story A — nteract UI user](#2-story-a-nteract-ui-user)
3. [Story B — Headless / AI agent user](#3-story-b-headless--ai-agent-user)
4. [Shared substrate: the notebook profile](#4-shared-substrate-the-notebook-profile)
5. [MCP tool surface](#5-mcp-tool-surface)
6. [MVP scope vs. future scope](#6-mvp-scope-vs-future-scope)
7. [Open design questions](#7-open-design-questions)
8. [Tensions and tradeoffs](#8-tensions-and-tradeoffs)

---

## 1. Mental model: the three-layer stack

Before designing individual flows, it helps to name the three conceptually distinct
layers that both user stories must navigate. Confusing these is the single largest
source of design mistakes in this space.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: Credential Store                                       │
│  "What secrets exist on this machine?"                           │
│                                                                  │
│  macOS Keychain / 1Password / Bitwarden / env vars               │
│  Lifecycle: machine-scoped, user-managed, persistent             │
│  Owner: always a human (directly or through IT)                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │  referenced by name
┌──────────────────────────────▼──────────────────────────────────┐
│  LAYER 2: Notebook Profile                                       │
│  "Which secrets does this notebook need, and how are they used?" │
│                                                                  │
│  nono.sh profile YAML/JSON (credential routes, domain rules)     │
│  Lifecycle: notebook-scoped, stored in notebook metadata         │
│  Owner: notebook author (human or AI agent)                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │  applied at kernel launch
┌──────────────────────────────▼──────────────────────────────────┐
│  LAYER 3: Runtime Sandbox                                        │
│  "What is the running kernel actually allowed to do?"            │
│                                                                  │
│  nono supervised process: proxy port, phantom tokens, Seatbelt   │
│  Lifecycle: kernel-scoped, ephemeral, rebuilt on restart         │
│  Owner: daemon (automated from the profile)                      │
└─────────────────────────────────────────────────────────────────┘
```

**Key invariant:** Credentials never cross the layer boundary downward. Layer 1 holds
the real secret. Layer 2 holds a *reference* to the credential by name. Layer 3 holds
only a session-scoped phantom token. The kernel process (below Layer 3) sees neither
the real secret nor the credential name — only the phantom token and a local proxy URL.

This invariant must be preserved in every UX flow.

---

## 2. Story A: nteract UI user

A human using the nteract Tauri desktop app. They have a full GUI. They want to run a
notebook that calls an API (e.g. an internal analytics service) without embedding the
real API key in the notebook.

### 2a. Credential lifecycle

**Who sets up credentials?**

Credentials live in the macOS Keychain. The UX has two paths:

**Path 1 — pre-existing credential** (most common):
The user already has a key stored via `security` CLI, 1Password, or another tool.
nteract needs only to *discover* and *name* it, not to create it.

**Path 2 — new credential via nteract**:
The user enters a secret value in the nteract Credential Manager UI. nteract writes it
to the macOS Keychain under service=`nono`, account=`<user-chosen-name>`. The real value
is handled by the OS; nteract never stores it in its own database.

```
Credential Manager (Settings → Credentials)

┌──────────────────────────────────────────────────────────────┐
│  Credentials                                          [+ Add] │
├──────────────────────────────────────────────────────────────┤
│  NAME            SOURCE          LAST USED    STATUS         │
│  ──────────────  ──────────────  ───────────  ──────────     │
│  openai          keychain        2 days ago   ● available    │
│  analytics_api   keychain        just now     ● available    │
│  internal_db     1password       never        ○ not tested   │
│                                                              │
│  [Edit] [Delete] [Test]                                      │
└──────────────────────────────────────────────────────────────┘

Add Credential dialog:
┌─────────────────────────────────────────┐
│  Name (used in notebook):  [          ] │
│                                         │
│  Source:  ○ Enter value now             │
│           ○ macOS Keychain (existing)   │
│           ○ 1Password                   │
│           ○ Environment variable        │
│                                         │
│  Value / Reference: [                 ] │
│  (value is written to Keychain,         │
│   never stored by nteract)              │
│                                         │
│  [Cancel]  [Save to Keychain]           │
└─────────────────────────────────────────┘
```

**Design note:** The credential name is a machine-local identifier (e.g. `analytics_api`).
It must use underscores, not hyphens. The UI should enforce this.

### 2b. Profile authoring

The "profile" is a nono.sh config that maps credential names to upstream services.
For the GUI user, this should feel like connecting a key to a domain — not like editing
YAML.

**Where does the profile live?**

Recommendation: embedded in notebook metadata (`metadata.runt.sandbox.profile`), with a
fallback to a workspace-level profile file. This makes notebooks self-describing — if
someone else opens the notebook, the profile tells them what credentials it expects.

```
Notebook Settings → Network & Credentials panel
(accessible via the notebook header or ⌘,)

┌──────────────────────────────────────────────────────────────────┐
│  Network Access for this notebook                                 │
│                                                                   │
│  Sandbox mode:  ○ Off (direct internet access)                   │
│                 ● Credential injection (proxy only)              │
│                 ○ Strict (domain allowlist + proxy)              │
│                                                                   │
│  Credential routes:                                    [+ Add]   │
│  ─────────────────────────────────────────────────────────────   │
│  CREDENTIAL      UPSTREAM URL            HEADER        ACTIONS   │
│  ─────────────   ─────────────────────   ──────────    ───────   │
│  analytics_api   https://analytics.co   Authorization  [✎] [✕]  │
│  openai          (built-in OpenAI)      Authorization  [✎] [✕]  │
│                                                                   │
│  Allowed domains (strict mode only):                             │
│  analytics.co, api.openai.com                    [Edit list]     │
│                                                                   │
│  [Cancel]  [Save to Notebook]                                    │
└──────────────────────────────────────────────────────────────────┘
```

The "Add route" flow:

```
Add Credential Route:
┌────────────────────────────────────────────────┐
│  Credential:  [analytics_api      ▼]           │
│                                                │
│  Service type:  ○ Built-in (OpenAI, etc.)      │
│                 ● Custom upstream              │
│                                                │
│  Upstream URL:  [https://analytics.example.com]│
│  Inject as:     ● Authorization: Bearer {}     │
│                 ○ Query param: ?api_key={}      │
│                 ○ Custom header: [          ]  │
│                                                │
│  Restrict methods/paths (optional):            │
│  [GET /v1/**                               ]   │
│                                               │
│  [Cancel]  [Add Route]                        │
└────────────────────────────────────────────────┘
```

### 2c. Runtime launch

**When the user opens or restarts a kernel:**

If the notebook has a sandbox profile attached, the daemon uses `nono run` to wrap the
kernel launch. If no profile is attached, the kernel launches normally (direct internet,
no proxy).

The user sees a status indicator in the notebook header:

```
Notebook header (with sandbox active):

  [kernel: Python 3.12 ▼]  [● Proxied | analytics_api, openai]  [▶ Run All]

   ↑
   Clicking this opens the Runtime Sandbox Status panel (see §2d)
```

If the profile references credentials that are not available in the Keychain, launch
is blocked with an error:

```
┌──────────────────────────────────────────────────────────────────┐
│  ⚠  Cannot start kernel                                           │
│                                                                   │
│  This notebook requires credential "analytics_api" but it is not  │
│  available in your Keychain.                                      │
│                                                                   │
│  [Add credential now]    [Run without sandbox]    [Cancel]        │
└──────────────────────────────────────────────────────────────────┘
```

"Run without sandbox" is an escape hatch for users who have the credential set
directly in their shell environment and don't need proxy injection. This choice should
be recorded in the notebook session state but NOT saved to the notebook profile (to
avoid accidentally committing a weaker policy).

### 2d. In-flight visibility

The Runtime Sandbox Status panel shows live proxy state:

```
Runtime Sandbox Status
────────────────────────────────────────────────────────────────────
Kernel:   Python 3.12 (uv:inline)
Sandbox:  ● Active — credential injection mode

Credential routes:
  analytics_api  →  https://analytics.example.com  ● available
  openai         →  https://api.openai.com          ● available

Recent proxy activity (last 10 requests):
  ✓  GET   https://analytics.example.com/v1/data    200   124ms
  ✓  POST  https://api.openai.com/v1/chat/completions 200  3.1s
  ✗  GET   https://raw.githubusercontent.com         403  (blocked)

  [View full audit log]
────────────────────────────────────────────────────────────────────
```

The audit log shows method, domain, status code, and latency. It never shows credential
values or request bodies. This is nono's existing audit log, surfaced via the daemon.

**For MVP:** The proxy activity section is omitted. The panel shows only credential
availability (green/red) and sandbox mode. Audit log is deferred to the post-MVP phase.

### 2e. Failure modes

| Failure | Behavior |
|---------|----------|
| Credential missing from Keychain | Kernel launch blocked; user prompted to add credential or run without sandbox |
| nono binary not found | Kernel launches without sandbox; warning badge on status indicator |
| Proxy crashes mid-session | Kernel loses all network access (fail-closed). nteract shows an error banner. User must restart kernel. |
| Domain not in allowlist (strict mode) | HTTP 403 from proxy; kernel code raises an exception. Status panel shows the blocked request. |
| Keychain prompt denied by user | Credential read fails; proxy startup fails; kernel launch blocked |
| Phantom token mismatch | HTTP 403 from proxy; this would indicate a proxy bug, not normal user error |

### 2f. "Ask to accept/reject" future (GUI)

When a cell makes a network call to a domain not in the notebook profile, a prompt
appears:

```
┌──────────────────────────────────────────────────────────────────────┐
│  🌐  Network request from kernel                                      │
│                                                                       │
│  POST  https://new-api.vendor.com/v1/ingest                          │
│                                                                       │
│  This domain is not in the notebook's allowed list.                   │
│                                                                       │
│  [Block]   [Allow once]   [Allow & add to notebook]                  │
│                                                                       │
│  ⏱ Auto-blocking in 30s                                              │
└──────────────────────────────────────────────────────────────────────┘
```

"Allow & add to notebook" adds the domain to the notebook profile's `allow_domain` list
and saves. The kernel cell that triggered the prompt is paused on the blocked request
(nono's proxy can hold the connection). If the user allows, the request proceeds;
if they block or timeout, the kernel gets a 403.

This requires **strict mode** to be active (domain allowlist enforcement). In
credential-injection-only mode (MVP), there is no domain gating, so this prompt
never fires.

### 2g. Full flow diagram (Story A)

```
  SETUP (one-time per machine)
  ─────────────────────────────
  User opens Settings → Credentials
       │
       ▼
  [Add Credential]
  Name: "analytics_api"
  Value: (entered, written to macOS Keychain by nteract)
       │
       ▼
  Credential stored in Keychain
  (nteract stores only the name, not the value)


  PER NOTEBOOK
  ─────────────
  User opens notebook
       │
       ▼
  Notebook has no sandbox profile
       │
       ▼
  Banner: "This notebook makes network calls. Add credential routes?"
  [Set up] or [Dismiss]
       │
  [Set up]
       │
       ▼
  Network & Credentials panel opens
  User selects credential: "analytics_api"
  User enters upstream: "https://analytics.example.com"
  User selects inject mode: "Authorization: Bearer"
  [Save to Notebook]
       │
       ▼
  Profile written to notebook metadata
  metadata.runt.sandbox.profile = { credentials: [...] }


  RUNTIME LAUNCH
  ───────────────
  User clicks [Run All] or opens kernel
       │
       ▼
  Daemon reads notebook profile
       │
       ├── nono binary found?
       │     NO → launch kernel without sandbox, show warning
       │
       ├── all credentials available in Keychain?
       │     NO → block launch, show "Add credential" prompt
       │
       └── YES → wrap kernel launch:
                 nono run --profile <inline-from-metadata> -- python -m ipykernel ...
                          │
                          ▼
                 nono proxy starts on 127.0.0.1:<ephemeral>
                 Phantom tokens injected into kernel env
                 Kernel process spawned
                          │
                          ▼
                 Status indicator: ● Proxied | analytics_api


  IN FLIGHT
  ──────────
  Cell executes:
    base = os.environ["ANALYTICS_API_BASE_URL"]
    resp = requests.get(f"{base}/v1/data",
                        headers={"Authorization": f"Bearer {os.environ['ANALYTICS_API_API_KEY']}"})
       │
       ▼
  requests routes through HTTPS_PROXY
       │
       ▼
  nono proxy: validates phantom token, injects real key, forwards to upstream
       │
       ▼
  Response returns to kernel
  Audit log entry created
       │
       ▼
  (optional, post-MVP): Status panel shows: ✓ GET analytics.example.com 200


  TEARDOWN
  ─────────
  User closes notebook / kernel dies
       │
       ▼
  nono proxy process terminates
  Phantom tokens invalidated
  Real secret wiped from memory (Zeroizing<String>)
```

---

## 3. Story B: Headless / AI agent user

An AI agent (e.g. Claude Desktop via MCP, or an automated CI pipeline) controls nteract
programmatically. There is no human watching a screen. The agent needs to execute
notebook cells that make credentialed API calls.

This is a meaningfully different situation from Story A:

1. **The agent cannot perform interactive authentication.** It cannot click "Allow" in
   a Keychain prompt, cannot enter credentials into a form, and cannot make a judgment
   call about an unexpected domain.

2. **The agent operates with delegated authority.** A human set up the machine, stored
   the credentials, and gave the agent access. The agent can only use credentials it
   was told to use — it cannot create new ones.

3. **Failure must be surfaced through data, not UI.** If a credential is missing, the
   agent must receive a structured error message it can reason about and report to
   a user.

4. **The agent is the notebook author.** For agent-created notebooks, the profile is
   part of the agent's work output, not a pre-existing artifact.

### 3a. Credential lifecycle (headless)

Credentials are machine-scoped. A human (the machine owner, an IT admin, or a CI
secrets manager) sets them up before the agent runs. The agent does not and should not
create credentials.

The agent can, however:
- **List** available credential names (not values) to discover what is usable.
- **Check** whether a specific credential is available and accessible.
- **Reference** credentials by name when authoring a notebook profile.

```
Human sets up machine (one-time):
  security add-generic-password -s "nono" -a "analytics_api" -w "sk-actual-secret"

Agent workflow:
  1. list_credentials()
     → ["analytics_api", "openai", "internal_db"]

  2. create_notebook_profile(notebook_id, credentials=["analytics_api"],
                              routes=[{name: "analytics_api",
                                       upstream: "https://analytics.example.com",
                                       inject_header: "Authorization",
                                       credential_format: "Bearer {}"}])
     → profile saved to notebook metadata

  3. launch_runtime(notebook_id)
     → runtime_id, sandbox_status

  4. execute_cell(notebook_id, cell_id, ...)
     → outputs
```

### 3b. Profile authoring (headless)

The agent authors the notebook profile as part of setting up a notebook. The profile
should be declarative and stored in the notebook's Automerge document so it is
durable and synced.

The agent has two options:

**Option 1 — explicit profile declaration** (recommended):
The agent calls `set_notebook_sandbox_profile` before launching the runtime, providing
the full profile. This is the "I know exactly what this notebook needs" path.

**Option 2 — profile from notebook metadata already present**:
If a human previously authored the notebook with a profile, the agent can simply
launch the runtime and the profile is applied automatically. The agent does not need
to re-declare it.

### 3c. Runtime launch (headless)

The agent calls `launch_runtime` (existing MCP tool) or a sandbox-aware variant.
The daemon checks:

1. Is there a sandbox profile in the notebook metadata?
2. Are all referenced credentials available?
3. Is nono installed?

If all checks pass, the runtime launches with the proxy active. The response includes
`sandbox_status` so the agent knows whether the sandbox is active and which credentials
are live.

**Critical design choice: should sandbox be opt-in or opt-out for agents?**

Recommendation: **opt-in per notebook, with a global agent permission flag.**

- A notebook with no profile launches without sandbox (existing behavior).
- A notebook with a profile gets the sandbox automatically.
- The agent can also pass `sandbox_mode: "off"` to explicitly suppress the sandbox
  even if a profile exists (escape hatch for debugging).

### 3d. In-flight visibility (headless)

The agent gets feedback through two channels:

**1. Execution output**: If a request fails (403, connection refused), the Python
exception is part of the cell output. The agent reads this like any other output.

**2. Sandbox status query**: Between cells (or after a block of cells), the agent can
call `get_runtime_sandbox_status(runtime_id)` to get:
- Which credentials are active
- A list of recent proxy events (domain, method, status code)
- Whether any domains were blocked

For MVP, the proxy event list is omitted. The agent only gets credential availability.

### 3e. Failure modes (headless)

The agent must be able to distinguish and handle each failure programmatically:

| Failure | Error type returned | Agent action |
|---------|--------------------|----|
| Credential missing | `SandboxError::CredentialNotFound { name }` | Report to human operator; do not proceed |
| nono binary not found | `SandboxError::NonoNotInstalled` | Launch without sandbox if policy allows; report |
| Profile validation error | `SandboxError::InvalidProfile { reason }` | Fix profile declaration; retry |
| Domain blocked (403) | Python exception in cell output (normal cell error) | Inspect output; may update domain allowlist and retry |
| Proxy crash mid-session | `RuntimeError::SandboxProxyDied` → runtime marked degraded | Restart runtime |
| Keychain prompt required | `SandboxError::KeychainInteractionRequired` | Cannot proceed headlessly; report to human |

**The `KeychainInteractionRequired` case deserves special attention.** On first access,
macOS prompts the user to authorize nono to access a Keychain item. This is a blocking
GUI prompt. An agent cannot click it. Design options:

- Pre-authorize in setup: the human runs `nono run --credential analytics_api -- true`
  once to trigger and dismiss the Keychain prompt, before the agent ever runs.
- Detect the failure: nteract detects the `errSecInteractionNotAllowed` error and
  returns `KeychainInteractionRequired` to the agent, which reports it upstream.

The pre-authorization approach is strongly preferred. It should be documented as a
required setup step.

### 3f. The "ask to accept/reject" future (headless)

This is the most complex design problem in the whole proposal.

**The problem:** In strict mode (domain allowlist enforcement), the kernel encounters a
domain not in the allowlist. In the GUI case, a human can make a real-time decision.
In the headless case, who decides?

**Option A — agent decides autonomously:**
The agent receives a `SandboxPrompt` event via MCP. It inspects the domain, evaluates
it against the notebook's purpose, and responds `allow` or `deny`. The proxy holds the
connection for up to N seconds.

This is powerful but raises a governance question: should an AI agent be able to
autonomously expand the sandbox boundary? This is exactly the kind of decision that
oversight frameworks (like nono's own positioning around "agent oversight") argue
should involve a human.

**Option B — agent escalates to human:**
The agent receives the `SandboxPrompt`, cannot decide autonomously, and uses a
side-channel (e.g. a Slack message, email, or a notification in the user's nteract app
even if they're not watching the notebook) to ask the human. The prompt is queued
with a timeout. If no human responds, the request is blocked.

**Option C — pre-declared policy only, no runtime prompts:**
In headless mode, there are no prompts. The agent must declare the full allowlist in the
profile before launching the runtime. If a domain is not in the allowlist, the request
is blocked with a 403. The agent receives this as a cell error, not as a prompt.

**Recommendation for MVP:** Option C. Pre-declared policy only. Prompts are a GUI-only
feature initially. This is the most predictable and least governance-risky approach.
Headless agents must know their dependencies upfront.

**Post-MVP:** Option A or B depending on the oversight philosophy the nteract team
adopts. This is a values question, not just a design question.

### 3g. Full flow diagram (Story B)

```
  SETUP (one-time, done by human before agent runs)
  ──────────────────────────────────────────────────
  Human stores credentials:
    security add-generic-password -s "nono" -a "analytics_api" -w "sk-..."
    
  Human pre-authorizes nono Keychain access:
    nono run --credential analytics_api -- true
    (macOS prompts once; human clicks "Always Allow")
    
  Human grants agent access to nteract MCP


  AGENT DISCOVERY
  ────────────────
  Agent calls: list_credentials()
    → { available: ["analytics_api", "openai"],
        unavailable: [],
        requires_interaction: [] }
    
  Agent inspects notebook metadata (or creates new notebook)
    → notebook has no sandbox profile yet


  AGENT PROFILE AUTHORING
  ────────────────────────
  Agent calls: set_notebook_sandbox_profile(
    notebook_id = "nb-abc",
    profile = {
      mode: "credential_injection",
      credentials: [
        {
          name: "analytics_api",
          upstream: "https://analytics.example.com",
          inject_header: "Authorization",
          credential_format: "Bearer {}",
          allowed_endpoints: [
            { method: "GET", path: "/v1/**" }
          ]
        }
      ]
    }
  )
    → { saved: true, profile_id: "prof-xyz" }


  AGENT RUNTIME LAUNCH
  ─────────────────────
  Agent calls: launch_runtime(notebook_id = "nb-abc")
    → daemon reads profile from notebook metadata
    → daemon checks credentials
    → daemon wraps kernel: nono run --profile <inline> -- python -m ipykernel ...
    → { runtime_id: "rt-123",
        sandbox: {
          active: true,
          mode: "credential_injection",
          credentials: [
            { name: "analytics_api", status: "available" }
          ]
        }
      }


  AGENT CELL EXECUTION
  ─────────────────────
  Agent calls: execute_cell(notebook_id, cell_id)
  
  Cell code:
    base = os.environ["ANALYTICS_API_BASE_URL"]
    resp = requests.get(f"{base}/v1/data",
                        headers={"Authorization": f"Bearer {os.environ['ANALYTICS_API_API_KEY']}"})
    print(resp.json())
    
    → nono proxy intercepts
    → validates phantom token
    → injects real key
    → forwards to https://analytics.example.com/v1/data
    → response returned
    
  Agent receives:
    { outputs: [{ type: "stream", text: '{"result": ...}' }],
      status: "success" }


  FAILURE CASE
  ─────────────
  If credential was not available:
  
  launch_runtime() returns:
    { error: "SandboxError::CredentialNotFound",
      missing_credentials: ["analytics_api"],
      message: "Credential 'analytics_api' not found in Keychain. ..."
    }
    
  Agent does NOT launch the runtime.
  Agent reports to user:
    "Cannot run notebook nb-abc: credential 'analytics_api' is missing.
     A human needs to add it to the macOS Keychain before this notebook can run."


  TEARDOWN
  ─────────
  Agent calls: stop_runtime(runtime_id)
    → nono proxy terminates
    → phantom tokens invalidated
    → real secrets wiped from proxy memory
```

---

## 4. Shared substrate: the notebook profile

Both story A and story B ultimately write to and read from the same artifact: the
**notebook sandbox profile**, stored in notebook metadata. This is the key to
making the two experiences coherent.

### 4a. Profile storage location

```
notebook metadata (Automerge document):
  metadata.runt.sandbox:
    version: "1.0"
    mode: "credential_injection"  | "strict" | "off"
    credentials:
      - name: "analytics_api"
        upstream: "https://analytics.example.com"
        inject_header: "Authorization"
        credential_format: "Bearer {}"
        allowed_endpoints:
          - method: "GET"
            path: "/v1/**"
    allow_domains: []  # populated in strict mode
    authored_by: "human" | "agent:<agent-id>"
    last_modified: "2026-06-08T..."
```

**Why notebook metadata, not a separate config file?**

- The notebook is the unit of trust. Someone sharing or opening a notebook gets its
  full policy declaration, including what network access it needs.
- Automerge sync: policy changes sync across peers automatically.
- The daemon already reads notebook metadata to make launch decisions
  (trust approval, dependency resolution). Adding sandbox profile is a natural extension.
- Avoids profile file sprawl in `~/.config/nono/profiles/`.

**Tradeoff:** Profile is embedded in the notebook file. If you share the notebook, you
share the policy (but NOT the credential values, which live only in Keychain). This is
intentional: the policy is not sensitive. Credential names are not sensitive. Only the
values are, and they never leave Layer 1.

### 4b. Profile resolution order

When the daemon launches a kernel, it resolves the effective profile from:

1. **Notebook metadata** (`metadata.runt.sandbox`) — highest priority
2. **Workspace profile** (`.nteract/sandbox-profile.json` in notebook directory) — fallback
3. **Global profile** (`~/.config/nteract/sandbox-profile.json`) — lowest priority
4. **None** — no sandbox (current behavior)

For MVP, only #1 and #4 are implemented. #2 and #3 are future scope.

### 4c. Profile portability and cross-user compatibility

A notebook with a sandbox profile will work for another user only if they have the
same credential names in their Keychain. The credential name is the contract.

This is analogous to how `.env` files work: the file lists the variable names;
each machine provides the values.

**Onboarding a notebook with a profile:** When a new user opens a notebook that has a
profile, and their Keychain is missing required credentials, the UI (Story A) shows
the credential setup flow. The MCP API (Story B) returns `CredentialNotFound` errors.

---

## 5. MCP tool surface

The following MCP tools are needed to support Story B. These extend the existing
nteract MCP tool surface.

### New tools (sandbox/credential-specific)

---

#### `list_credentials`

Returns the names of credentials available in the Keychain that nono can access.
Does NOT return values.

```
Input: {}

Output:
{
  "available": ["analytics_api", "openai"],
  "unavailable": [],             // known names that failed to load (error details included)
  "requires_interaction": [],    // names that need a GUI Keychain prompt to authorize
  "source": "keychain"           // or "1password", "env", etc.
}
```

**Implementation note:** This calls `nono` with a credential-check subcommand or
attempts a dry-run proxy start that loads each credential. The daemon caches results
for the session to avoid repeated Keychain hits.

---

#### `set_notebook_sandbox_profile`

Writes a sandbox profile into the notebook's Automerge metadata.

```
Input:
{
  "notebook_id": "nb-abc",
  "profile": {
    "mode": "credential_injection",   // or "strict" or "off"
    "credentials": [
      {
        "name": "analytics_api",
        "upstream": "https://analytics.example.com",
        "inject_header": "Authorization",
        "credential_format": "Bearer {}",
        "allowed_endpoints": [
          { "method": "GET", "path": "/v1/**" }
        ]
      }
    ],
    "allow_domains": []   // for strict mode
  }
}

Output:
{
  "saved": true,
  "profile_id": "prof-xyz",
  "warnings": []
}
```

**Validation:** The daemon validates credential names against available Keychain entries
and warns (but does not error) if a credential is not currently available. This allows
agents to author profiles for notebooks that will run on different machines.

---

#### `get_notebook_sandbox_profile`

Reads the current sandbox profile from notebook metadata.

```
Input: { "notebook_id": "nb-abc" }

Output:
{
  "profile": { ... },   // profile object, or null if none
  "source": "notebook_metadata"  // or "workspace", "global", "none"
}
```

---

#### `get_runtime_sandbox_status`

Returns the current sandbox state for a running runtime.

```
Input: { "runtime_id": "rt-123" }

Output:
{
  "active": true,
  "mode": "credential_injection",
  "proxy_port": 54321,
  "credentials": [
    { "name": "analytics_api", "status": "injecting", "requests_proxied": 3 }
  ],
  "recent_events": [             // MVP: empty array; future: populated
    {
      "timestamp": "...",
      "action": "allow",
      "method": "GET",
      "domain": "analytics.example.com",
      "path": "/v1/data",
      "status_code": 200,
      "credential_used": "analytics_api"  // name only, never value
    }
  ],
  "blocked_requests": []
}
```

---

#### `remove_notebook_sandbox_profile`

Clears the sandbox profile from notebook metadata. The next kernel launch will use
no sandbox.

```
Input: { "notebook_id": "nb-abc" }
Output: { "removed": true }
```

---

### Modifications to existing tools

#### `launch_runtime` (existing tool — extend)

Add optional `sandbox_override` field:

```
Input (additions):
{
  "sandbox_override": "off"  // optional; "off" suppresses sandbox even if profile exists
}

Output (additions):
{
  "sandbox": {
    "active": true | false,
    "mode": "credential_injection" | "strict" | "off",
    "error": null | { "type": "CredentialNotFound", "credential": "analytics_api" }
  }
}
```

If `sandbox.error` is non-null and the sandbox is required (cannot fall back to
unsandboxed), the runtime launch fails. The agent must handle this error before
attempting to execute cells.

---

### Tool sequencing for a first-time agent setup

```
1. list_credentials()
   → confirm "analytics_api" is available

2. get_notebook_sandbox_profile(notebook_id)
   → null (no profile yet)

3. set_notebook_sandbox_profile(notebook_id, profile={...})
   → { saved: true }

4. launch_runtime(notebook_id)
   → { runtime_id: "rt-123", sandbox: { active: true, ... } }

5. execute_cell(notebook_id, cell_id)
   → { outputs: [...] }

6. get_runtime_sandbox_status(runtime_id)
   → { credentials: [{ name: "analytics_api", requests_proxied: 1 }] }
```

For subsequent runs (profile already saved to notebook):

```
1. list_credentials()           ← optional but recommended
2. launch_runtime(notebook_id)  ← profile auto-applied
3. execute_cell(...)
```

---

## 6. MVP scope vs. future scope

### MVP

**Goal:** A notebook cell can do `requests.get(...)` and nono.sh injects the credential
transparently. Both a GUI user and an MCP agent can set this up.

| Feature | Story A (GUI) | Story B (Agent) |
|---------|--------------|-----------------|
| Credential Manager UI | Minimal list + add | N/A (not needed) |
| Profile authoring | Network & Credentials panel | `set_notebook_sandbox_profile` |
| Runtime launch with proxy | Automatic when profile present | `launch_runtime` response includes `sandbox` field |
| Credential availability check | Blocking dialog on launch failure | `list_credentials` + `launch_runtime` error |
| Sandbox status indicator | Static badge (active/inactive, credential names) | `sandbox` field in `launch_runtime` response |
| Audit log / proxy events | Not shown | Not returned |
| Real-time accept/reject prompts | Not implemented | Not implemented |
| Domain allowlist (strict mode) | Not implemented | Not implemented |
| nono not installed | Warning, graceful degradation | `NonoNotInstalled` error in `launch_runtime` |

**MVP profile format** (minimal):

```json
{
  "mode": "credential_injection",
  "credentials": [
    {
      "name": "analytics_api",
      "upstream": "https://analytics.example.com",
      "inject_header": "Authorization",
      "credential_format": "Bearer {}"
    }
  ]
}
```

**MVP daemon change** (minimal):

The daemon, when launching a kernel, checks `metadata.runt.sandbox`. If present and
`mode != "off"`, it prepends `nono run --profile <inline-profile>` to the kernel
command. nono is called as a subprocess; no nono Rust library integration needed.

The inline profile is serialized to a temp file (or passed via stdin if nono supports
it) to avoid embedding secrets in process args. The temp file contains only the profile
structure (credential names, routes) — no secret values. Credential values are read by
nono from the Keychain at runtime.

### Future scope

#### Phase 2: Audit and observability

- Proxy event stream surfaced in the daemon's `RuntimeStateDoc`.
- GUI: proxy activity list in the Sandbox Status panel.
- MCP: `recent_events` in `get_runtime_sandbox_status`.
- Audit log persistence (session-scoped, not stored in notebook).

#### Phase 3: Strict mode (domain allowlist)

- `allow_domains` in the profile, activating nono's CONNECT tunnel domain filtering.
- Kernel-level enforcement via macOS Seatbelt (all outbound TCP blocked except proxy).
- GUI: blocked request notifications in status panel.
- MCP: `blocked_requests` in `get_runtime_sandbox_status`.

#### Phase 4: Real-time accept/reject prompts (GUI only initially)

- Strict mode blocks unknown domains; nono holds the connection.
- GUI: prompt dialog (§2f) with 30s timeout.
- Agent response: pre-declared policy only (no runtime prompts in headless mode).

#### Phase 5: Agent-mediated prompts

- `SandboxPrompt` MCP event/notification.
- Agent can respond `allow`/`deny` with a rationale.
- Governance question: log agent decisions; require human review for expansion.

#### Phase 6: Dynamic credential updates

- Add/remove credentials without restarting the kernel.
- Requires nono-core Rust integration (not CLI wrapper).
- GUI: "Add credential route" in the status panel while kernel is running.

#### Phase 7: Filesystem sandbox

- nono filesystem restrictions (`read_only`, `no_write_outside_workdir`).
- Separate UI panel for filesystem access policy.
- Higher user friction; must be positioned as "isolation" not just "credentials".

---

## 7. Open design questions

These are questions that require explicit decisions before implementation begins.

### Q1: nono binary installation: bundled or external?

**Options:**
- A) Bundle `nono` binary inside the nteract app (like nteract bundles `uv`).
- B) Require the user to install nono separately (`brew install nono`).
- C) Download nono on first use with a UI prompt.

**Considerations:**
- Option A gives the smoothest UX but ties nteract to a specific nono version and
  requires a binary per platform (macOS arm64, macOS x86, Linux x86, Linux arm).
- Option B is simpler to ship but creates a setup barrier, especially for non-technical
  users. "Credential injection requires nono. Install with `brew install nono`."
- Option C has licensing and supply-chain trust implications.
- The nono license (Q7 in the investigation doc) must be clarified before Option A.

**Recommendation:** Start with Option B for MVP (external install, with a clear error
message and setup guide). Move to Option A post-MVP once the license is confirmed.

---

### Q2: Should sandbox be opt-in or default-on?

**Options:**
- A) Off by default. Users/agents explicitly opt in by adding a profile.
- B) Default-on with a passthrough profile that does nothing until credentials are added.
- C) Default-on only for notebooks with API calls (detected by static analysis — not
  feasible for MVP).

**Considerations:**
- The current behavior is no sandbox. Changing that default would break existing
  notebooks and surprise users.
- Option A is the safest and most clearly communicates consent.
- The trust model in AGENTS.md does not mandate sandboxing — it is additive, not
  required.

**Recommendation:** Option A. Opt-in. Sandbox is a capability, not a security
requirement at the system level.

---

### Q3: What is the profile inline format for the daemon → nono CLI call?

nono accepts profiles as files (`--profile path/to/profile.json`). The profile contains
no secrets — it references credential names. So the temp file approach is safe.

**Options:**
- A) Write profile to a temp file on each kernel launch; pass `--profile /tmp/...`.
- B) Support nono's stdin profile mode (if it exists; needs verification).
- C) Integrate nono-core Rust library to avoid subprocess overhead.

**Recommendation:** Option A for MVP. Temp file in the daemon's cache dir
(`~/.cache/runt/sandbox-profiles/<notebook-id>-<launch-id>.json`), deleted after
kernel launch. Option C is the long-term path but requires significantly more work.

---

### Q4: Who is responsible for profile validation — daemon or client?

When an agent calls `set_notebook_sandbox_profile`, the daemon could:
- A) Accept and store anything, validate only at launch time.
- B) Validate the profile structure immediately, warn on missing credentials.
- C) Validate fully and reject invalid profiles.

**Recommendation:** Option B for MVP. Store whatever is given (it's just metadata), but
return `warnings` for structural issues and missing credentials. Fail-closed at launch
time (if credentials are missing, don't launch).

---

### Q5: How are credential names communicated to kernel authors?

The kernel code must use `os.environ["ANALYTICS_API_BASE_URL"]` — it must know
the name. This is a usability gap.

**Options:**
- A) Document the env var naming convention (`<NAME_UPPER>_BASE_URL`, `<NAME_UPPER>_API_KEY`).
- B) Expose the env vars in the sandbox status panel / MCP response so the user/agent
  can copy them.
- C) Generate a notebook cell stub when a profile is created: pre-filled code showing
  how to use the injected env vars.

**Recommendation:** Option C for GUI (it turns setup into onboarding). Option B for
agents (include `env_vars` in the `get_runtime_sandbox_status` response — the var
names, not values). Option A as baseline documentation.

---

### Q6: How does the "run without sandbox" escape hatch interact with notebook portability?

If a user opts to "run without sandbox" (§2c), should that choice be:
- A) Session-only — applies to this run, not saved.
- B) Saved to notebook metadata as `mode: "off"`.
- C) Saved to user preferences as "always allow unsandboxed" for this notebook.

**Recommendation:** Option A (session-only). Never weaken the declared policy
permanently from an escape hatch. The user can explicitly edit the profile to `mode: off`
if they want that permanently.

---

### Q7: Keychain pre-authorization for agents — whose responsibility?

The macOS Keychain prompt on first nono access is a GUI event. An agent cannot handle
it. Options:

- A) Require the human to pre-authorize once before the agent runs (documented setup step).
- B) nteract detects the failure and notifies the human via a system notification, even
  if the agent triggered it.
- C) nteract pre-authorizes all credentials in the Credential Manager at save time
  (by doing a dry-run access) to front-load the prompt.

**Recommendation:** Option A for MVP. Option C post-MVP (it makes the Credential Manager
UI more useful — saving a credential immediately tests it and triggers the Keychain
prompt while the user is at the keyboard).

---

### Q8: What is the nono license?

Not yet verified. Must be confirmed before bundling nono (Option A in Q1). If nono is
commercial or has a source-available license with restrictions, bundling may require
a commercial agreement.

---

### Q9: Should the sandbox profile be version-controlled?

Notebook files in nteract are Automerge documents (binary). If notebooks are exported
as `.ipynb` JSON (standard Jupyter format), the profile should survive the round-trip.

**Consideration:** `.ipynb` format stores metadata in the `metadata` key. nteract's
`metadata.runt.sandbox` would survive export to `.ipynb` as long as the export path
preserves notebook metadata. An agent or user opening the `.ipynb` in a different
notebook app would see the metadata but not benefit from the sandbox (other apps don't
know about nono). This is acceptable — the profile is advisory, not mandatory.

---

## 8. Tensions and tradeoffs

### Tension 1: Transparency vs. magic

nono's core value proposition is transparent credential injection — the kernel code
looks normal, the proxy is invisible. But for users to trust the system, they need to
understand what is happening. Too much magic creates confusion ("why isn't my API call
working?"); too much transparency creates friction ("I have to configure all this just
to call an API?").

**Resolution:** Default to showing the sandbox status indicator (so users know the proxy
is active) but keep cell-level interaction invisible. The audit log is opt-in (click to
expand), not in-your-face.

---

### Tension 2: Notebook portability vs. machine-local credentials

The notebook profile is stored in notebook metadata (portable). The credentials are
stored in the Keychain (machine-local). This creates a portability cliff: a notebook
that works perfectly on machine A will fail on machine B with `CredentialNotFound`.

This is intentional (credentials should not travel in the notebook file) but it must
be communicated clearly. The profile should include `required_credentials` with human-
readable descriptions:

```json
"credentials": [
  {
    "name": "analytics_api",
    "upstream": "https://analytics.example.com",
    "description": "API key for analytics.example.com — ask your team lead",
    "inject_header": "Authorization",
    "credential_format": "Bearer {}"
  }
]
```

The `description` field is surfaced in the "credential missing" error message.

---

### Tension 3: Agent autonomy vs. human oversight

An agent that can autonomously add domains to the sandbox allowlist (Phase 5) can
expand the sandbox boundary without human review. An agent that can only use pre-
declared policy is more predictable but less flexible.

This tension does not have a universal resolution — it depends on the risk tolerance of
the deployment. The design should support both modes:

- **Constrained mode** (default): agent can read and reference credentials, can author
  profiles before kernel launch, cannot expand a running runtime's allowed domains.
- **Supervised mode** (opt-in): agent can propose expansions, which are queued for
  human approval (real-time or async).
- **Autonomous mode** (admin opt-in): agent can approve its own expansions, with full
  audit logging.

For MVP, only constrained mode exists. The architecture should not foreclose the others.

---

### Tension 4: Fail-closed security vs. usability

nono's proxy is fail-closed: if the proxy dies, the kernel loses all network access.
This is the right security default. But it creates a sharp usability cliff — a kernel
that was working suddenly can't reach anything, and the error in Python looks like a
generic `ConnectionError`, not "your sandbox proxy crashed."

**Resolution:** The daemon should monitor the nono process (it already monitors the
kernel process). If the nono supervisor exits unexpectedly, the daemon should:
1. Mark the runtime as `sandbox_degraded` in the RuntimeStateDoc.
2. Surface a banner in the GUI.
3. Return `RuntimeError::SandboxProxyDied` in the next MCP status query.

The kernel does not need to know — it will simply fail its next network call. The
daemon's response to the failure is what matters.

---

### Tension 5: Credential name as API surface

The credential name (`analytics_api`) is used in env var names (`ANALYTICS_API_BASE_URL`,
`ANALYTICS_API_API_KEY`). Once a name is chosen and notebook code is written to use
it, renaming the credential requires updating both the Keychain entry AND all notebook
cells that reference the env var.

This is a refactoring hazard. Options:

- A) Accept it — credential names are stable identifiers, similar to environment
  variable names. Document this clearly.
- B) Add an alias system: the profile maps a canonical name to potentially multiple
  Keychain entries (for rotation / per-environment variation).

**Recommendation:** Option A for MVP, with clear naming guidance (use stable, lowercase,
underscore-separated names that describe the service, not the user's specific API key).
`openai` not `johns_openai_key`. `analytics_api` not `analytics_api_production_key_2026`.

---

### Tension 6: Daemon architecture — CLI wrapper vs. deep integration

The MVP recommends the CLI wrapper approach (prepend `nono run` to the kernel command).
This is the right call for speed, but it creates an awkward architectural seam:

- The daemon knows about the profile (it reads it from notebook metadata).
- But nono handles the actual credential loading and proxy startup.
- If nono crashes or can't be found, the daemon finds out only by seeing the kernel
  fail to start (or the nono process exit unexpectedly).

The deeper integration (nono-core Rust crate) would let the daemon own the proxy
lifecycle, get programmatic access to proxy events, and handle failures more gracefully.
This is the right long-term architecture. The CLI wrapper is an acceptable MVP shortcut
if the team is willing to refactor in Phase 2.

---

### Tension 7: Agent as notebook author vs. agent as notebook executor

Story B conflates two different agent roles:
- **Author**: the agent creates the notebook and its profile (sets up the policy).
- **Executor**: the agent runs an existing notebook created by a human.

These have different requirements. An executor agent does not need `set_notebook_sandbox_profile` — it just needs `launch_runtime` to work. An author agent needs the full profile authoring API.

In practice, the most common agent workflows will be:
- CI/automation: executing pre-authored notebooks (executor role).
- Coding agents (Claude Desktop): creating and running new notebooks (author + executor).

Both should work seamlessly. The distinction matters for access control: should an
executor agent be allowed to modify a human-authored profile? Probably not without
explicit permission. This is a future concern but the data model should not make it
impossible to enforce.

---

*End of document.*
