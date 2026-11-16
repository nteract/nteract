# Scoped channel connection bridge (disabled)

This bridge is intentionally deny-only. It does not enable channel expansion,
redeem a review ID, prepare or install an environment, or launch a kernel.

## Connection ownership

The four notebook handshake routes accept `scoped_channel_review_v1`, defaulting
to false when absent. Existing client entrypoints always send false. The daemon
captures the original request with the server-created peer ID and authenticated
local-owner/non-hosted facts, not in shared room or runtime documents.

The actual peer loop owns the lifetime lease. Its request worker can check but
cannot extend that lease. Loop exit, cancellation, and errors invalidate queued
review requests. A new connection cannot inherit its predecessor's authority.
All approval and decline requests still return an error, including those from
an opted-in local owner. Direct dispatcher callers retain the existing refusal.

`ProtocolCapabilities::v4` always returns false. The native ready payload copies
that effective response beside the existing relay generation. Native ready
state clears its cached payload when the generation changes, rejects writes
whose argument or payload generation is stale, and only returns a cache entry
for the current gate. The server peer ID and native relay generation are distinct
identities, not interchangeable counters.

## Required next integration

Before any effective true response is allowed:

1. Add explicit caller opt-in entrypoints for adapted UI relays. Existing library,
   CLI, agent, hosted and unsupported entrypoints must remain off.
2. Own the immutable prepared install and consent session within the room's
   local owner operation, bound to the live creating connection and review epoch.
   Invalidate IDs on disconnect, cancellation, or relevant input/selection change.
3. Route ID-only approvals to that exact session. Fence before every channel
   contact and environment mutation. Metadata permission is not install consent.
4. Intercept inline manual launch before legacy cache/pool/lock paths. Consume
   the exact final grant into staging and fence publication and kernel launch.
   Incomplete project, hot-sync, autolaunch and old-client paths stay disabled.
5. Demonstrate actual reviewed install through owner-approved kernel launch,
   including stale/replay, competing-peer and cancellation cases. Complete the
   quarantined-prefix/process-tree ownership gates and real Kilo compatibility.

The parent-process lock does not prove that vendor scripts or descendants have
stopped writing. The earlier staging slice conservatively retains externally
exposed prefixes; this bridge adds no recovery deletion or stronger claim.

## Regression boundaries

Protocol tests cover omitted and explicit capability values. Connection tests
cover legacy, non-owner, opted-in, disconnected, successor and mixed-peer cases.
The real request-worker regression checks both denials and unchanged runtime
projection, runtime-agent identity and environment path. It does not establish
filesystem or network noninterference for a future enabled implementation.
Native ready-state tests cover stale payloads, mismatched generations and cache
invalidation. Host/dialog tests retain their default-off epoch checks.
