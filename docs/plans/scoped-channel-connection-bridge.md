# Scoped channel review for manual inline Conda launch

The local desktop relay explicitly opts into `scoped_channel_review_v1` on
open, create and attach. Older library entrypoints default off. The daemon
advertises effective support only to opted-in local owners; hosted connections
remain unsupported. Capability negotiation is protocol literacy, not consent.

## Operation ownership

The existing room launch gate admits one manual operation. Its immutable
`PreparedCondaInstall`, consent session and input fence belong to that operation,
not to the shared RuntimeStateDoc. The runtime document projects the pending
scope, exact source list and opaque ID for display.

The actual peer loop owns the connection lease. Approval/decline replies use a
separate bounded queue so they can unblock the launch waiting in the ordinary
queue without blocking socket ingress while waiting for document sync.
They still pass scope admission, observed-head checks, connection identity,
review ID and current-input validation. Each ID accepts one decision. Metadata
permission can only advance discovery; installation requires a fresh final ID.
A competing peer or successor connection cannot redeem the original ID.

Discovery checks the owner fence before cached/network metadata reads and after
asynchronous effects. Installation consumes the final grant into a new private
prefix, with automatic channel discovery disabled. Dependency/trust changes,
selection changes, notebook identity changes, cancellation and disconnect fence
publication and kernel dispatch. Ordinary cell edits do not revoke consent.
Shutdown wakes a waiting review without waiting for the launch queue to drain.
The same input locks and launch generation fence the runtime-agent RPC and final
launch publication. Validation waits for document contention rather than
revoking consent. Atomic commits acquire the launch gate before the connection,
selection and notebook identity locks. A rejected final commit retains the
launch token through shutdown and owned-agent teardown, including a lost shutdown
reply. Shutdown uses the control queue after capacity and causal validation. Its
queue state invalidates older launch tickets and holds later tickets until the
shutdown completes, including launches not yet admitted to the room gate.

## Compatibility and retained prefixes

The reviewed route intercepts manual `conda:inline` preparation before legacy
cache, pool and lock reconstruction. If discovery finds no additional sources,
it retains existing declared-only behavior without a second dialog. If initial
discovery is unavailable offline, declared-only resolution remains available;
failed discovery after metadata consent cannot proceed to installation.

Reviewed prefixes live under `reviewed-conda-envs`, outside legacy cache and
pool sweepers. Publication retains their original paths because Conda embeds
absolute prefixes. Installer/vendor effects may have descendants that outlive
cancellation, so exposed prefixes are retained even after failure. They are not
renamed, reused or automatically deleted. This deliberately trades disk space
for safe ownership; automatic reclamation needs process-tree quiescence proof.

Hot-sync refuses to mutate these prefixes and asks for a restart and fresh
review. Project, prewarm, captured-cache, automatic-launch, channel-qualified
spec and direct-URL paths retain their existing no-expansion behavior. Hosted
clients remain disabled. The native app opts in; other adapted hosts can use the
explicit relay options, but private Electron applications have not been tested.

## Verification boundaries

Connection/owner tests cover one-use IDs, wrong-peer and stale replies,
disconnect, cancellation, dependency/selection/identity changes and ordinary
cell edits, document-lock contention and ownership through rejected-launch
cleanup. Real IPC tests cover separate metadata/install scopes, replay, decline
without installation and shutdown from the reviewing connection. The opt-in `scoped_channel_live_install_launch_and_execute`
test downloads a real Conda environment, launches a runtime agent and executes a
synced cell. Native GUI interaction and Windows/macOS/Linux artifacts remain
separate verification surfaces.
