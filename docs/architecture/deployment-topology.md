# Deployment Topology for nteract Notebook Rooms

**Status:** Draft, 2026-05-21.

This ADR captures network-routing and process-placement decisions: where rooms live, how clients reach them, where kernels run, what crosses an organizational/network boundary, what TLS / CORS / origin policies apply, and where credential keyrings sit.

## What this ADR will cover

Sections to fill in:

1. **Client-to-room reachability patterns.**
   - Browser direct to hosted room over WebSocket.
   - Native client (desktop, TUI, agent) to hosted room over WebSocket.
   - Local-daemon-as-bridge: client talks to local daemon (Tauri IPC or Unix socket), daemon holds credentials and proxies to a remote room. This is one of several valid topologies; the identity layer does not assume it.
   - Mixed: a single process simultaneously holds connections to local and remote rooms.

2. **Where the room-host runs.**
   - Local desktop daemon (per-user, same-host trust).
   - Cloudflare Worker + Durable Object (multi-tenant hosted).
   - JupyterHub-spawned (per-user, per-Hub-deployment).
   - Self-hosted (e.g., runtimed.com style but on-prem).

3. **Where the kernel runs relative to the room.**
   - Local: kernel sidecar on the same host as the user's runtimed daemon.
   - Remote: kernel attached to a hosted room via a `runtime_peer` scope connection from elsewhere.
   - Hub-spawned: kernel co-located with the JupyterHub single-user server hosting the room.

4. **Credential keyring placement and exchange.**
   - Per-user OS keychain on desktop.
   - Browser-local secure storage where applicable.
   - How agents (Claude, Codex, MCP tools) obtain delegated credentials without re-authenticating.
   - Token refresh ownership.

5. **TLS, CORS, and origin policy.**
   - Hosted Workers serving WebSocket at one origin and blob storage at another.
   - Signed short-lived URLs for output blobs.
   - Browser SameSite / cross-site cookie handling for JupyterHub.

6. **Failure modes.**
   - Local daemon down while user wants to reach a hosted room.
   - Remote host unreachable; cached snapshots / offline editing.
   - Credential expiry while connected.

## Out of scope

- *Who can do what* (lives in `identity-and-trust.md`).
- Wire protocol (lives in `crates/notebook-wire/AGENTS.md`).
- Storage shape for snapshots and blobs (separate forthcoming ADR alongside the hosted-room prototype).
- Specific ACL semantics (separate forthcoming ADR).

## Status

This file is a placeholder. It exists so the identity-and-trust ADR can reference deployment topology without inlining it. Real content lands as we wire in the hosted-rooms prototype and learn what the trade-offs actually look like.
