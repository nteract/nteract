# notebook-sync

This crate is the client-side sync handle and socket task boundary for
NotebookDoc, RuntimeStateDoc, CommsDoc, CommentsDoc, PoolDoc, requests,
presence, blobs, and session status.

## Main pieces

- `DocHandle` is the caller-facing API. Synchronous document mutations go
  through `with_doc` or typed helpers, then notify the sync task.
- `SharedDocState` stores the local NotebookDoc, RuntimeStateDoc, CommsDoc,
  CommentsDoc, PoolDoc, snapshots, request waiters, blob waiters, and readiness
  phases shared with the socket task.
- `sync_task` owns typed-frame I/O. It sends and receives Automerge sync for
  `0x00` NotebookDoc, `0x05` RuntimeStateDoc, `0x06` PoolDoc, `0x09` CommsDoc,
  and `0x0a` CommentsDoc, plus request, response, presence, session-control,
  and `PUT_BLOB` frames. The Python sync task ignores `0x0a` CommentsDocSync
  frames; frontend/WASM handles comments directly.
- `execution_wait` / `execution_watch` observe RuntimeStateDoc terminal state;
  RuntimeStateDoc is the durable execution/output record, not broadcast replay.
- `relay` / `relay_task` are byte-pipe helpers for app relay paths; they do not
  become document authorities.

## Invariants

- Use `required_heads` / observed-head request variants when execution must be
  causally tied to the source a user saw.
- Do not treat viewer/read-only clients as non-participants. They still sync,
  receive changes, publish allowed presence, and send empty negotiation frames;
  authority denies their changes and mutating requests.
- Runtime peers author RuntimeStateDoc lifecycle/output state through policy
  gates. They do not gain NotebookDoc edit access.
- CommsDoc carries mutable widget state. RuntimeStateDoc carries comm topology;
  runtime/widget forwarding must gate CommsDoc state by RuntimeStateDoc
  membership.
- Presence is UX state. Current wire messages carry peer id, optional peer
  label, and optional actor label; structured actor projection is host/UI
  synthesis until the wire grows it.
- Keep request waiters keyed by request id and sync waiters keyed by target
  heads. Do not block the frame loop waiting for a request response inline.
- Local desktop, runtimed-wasm, Python/MCP clients, and hosted RoomHost need the
  same typed-frame semantics. If a frame or request contract changes, update the
  Rust protocol and `packages/runtimed` TypeScript surface together.
