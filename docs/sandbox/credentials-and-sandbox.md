# Credentials and network sandbox

nteract's network sandbox lets you inject API credentials into kernel network calls without exposing the real secret to notebook code. This page explains the credential store and the per-notebook sandbox profile.

## Credentials

Credentials are machine-local secrets stored in your **macOS Keychain** under the service name `nono`. They are scoped to your user account and are never included in the notebook file.

### Adding a credential

1. Open **Settings → Credentials** (or click "Add credential" in a notebook's sandbox panel).
2. Fill in:
   - **Name** — a stable identifier used by notebook profiles and agents. Must start with a letter and contain only letters, digits, and underscores (e.g. `analytics_api`). Names cannot be changed after creation.
   - **Description** (optional) — shown in the credential list and surfaced as a human-readable error when the credential is missing on another machine.
   - **Secret value** — the actual API key or token. This is stored in the keychain and never returned to the UI.
3. Click **Add credential**.

### Editing a credential

Click the edit icon next to a credential to update its description or rotate its secret value. The name cannot be changed — it is a stable identifier referenced by notebook profiles and any agents that use it.

### Deleting a credential

Click the delete icon. Any notebook that references this credential by name will show a "missing credential" indicator and will fail to launch a sandboxed kernel until a credential with the same name is re-added.

### Credential names are the cross-machine contract

Credential **names** — not values — are stored in the notebook file. Think of them like `.env` variable names:

- Machine A has `analytics_api = sk-abc123` in the keychain.
- Machine B must add its own `analytics_api = sk-xyz789` to its keychain.
- The notebook file only stores `analytics_api` and routing rules, never the secret.

When you share a notebook with a colleague, they need to add credentials with the same names to their own macOS Keychain. The sandbox panel shows a red indicator for any missing credential.

---

## Notebook sandbox panel

Each notebook has its own sandbox profile stored at `metadata.runt.sandbox` in the Automerge document. Multiple collaborators editing the same notebook see profile changes live.

Open the sandbox panel from the notebook toolbar (shield icon or **Notebook → Network sandbox**).

### Enabling the sandbox

Toggle **Enable sandbox** to on. When enabled, the daemon wraps kernel launch with `nono run`, routing credential injection through the proxy.

### Credentials in use

The **Credentials in use** section lists every `CredentialRef` in the profile.

| Indicator | Meaning |
|-----------|---------|
| ✅ Green check | Credential exists in your macOS Keychain |
| 🔴 Red exclamation | Credential is missing on this machine |

For missing credentials, click **Add credential** to open the Credential Manager pre-filled with the expected name.

Each credential reference has one or more **routes** that configure how the secret is injected:

| Field | Description |
|-------|-------------|
| Host | Hostname of the upstream service (no scheme, no path). Example: `api.example.com` |
| Injection type | `Header` / `Basic Auth` / `Query parameter` |
| Header name | Required when injection type is `Header`. Example: `Authorization` |
| Template | String containing `{credential}`, replaced with the real secret at runtime. Example: `Bearer {credential}` |

### Allowed domains

Add hostnames that the sandboxed kernel is allowed to call. Calls to hosts not in this list are blocked by the proxy.

### Saving the profile

Click **Save profile**. Changes take effect on the next kernel launch. A running kernel is not affected until it is restarted.

---

## How it works under the hood

```
Credential store (macOS Keychain)
  ↓  credential names only, never values
Notebook profile (Automerge metadata.runt.sandbox)
  ↓  at kernel launch
Daemon reads profile + fetches values from keychain
  ↓
nono proxy (ephemeral, kernel-scoped)
  ↓
Kernel network calls — intercepted, credential injected, forwarded
```

The kernel and all notebook code see only a phantom token, never the real secret. The real secret lives in the Keychain and is fetched once at proxy startup.

---

## Agents and credentials

Agents (via MCP) can **list credential names** and **reference them in a notebook profile**, but they **cannot create or read credentials** (D-9). A human must add credentials via this UI or via `security add-generic-password` in Terminal before an agent can use them.
