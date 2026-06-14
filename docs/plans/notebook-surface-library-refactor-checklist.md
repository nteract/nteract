# Notebook Surface Library Refactor Checklist

**Status:** Active checklist, 2026-06-14.

This checklist coordinates the multi-PR effort to make Desktop, Cloud, and
Elements render from stable shared notebook libraries instead of app-to-app
imports, cloud/desktop wrapper layers, or duplicated React projection state.
It is intentionally allowed to grow as new seams appear. Each PR should either
retire at least one item or add evidence explaining why the item is host-owned.

## References

- [Shared-Store Projection Convergence](../adr/shared-store-projection-convergence.md)
- [Notebook Host Shell Convergence](../adr/notebook-host-shell-convergence.md)
- [Notebook Identity and Environment Surface Audit](../audits/notebook-identity-environment-surface-audit.md)
- [Hosted Cloud Rooms](../../apps/notebook-cloud/README.md)

## North Star

Shared libraries own notebook presentation, headless projection/state stores,
output identity invariants, runtime/output projection helpers, interaction
state, capability projection types, and reusable RxJS/store mechanics.

Host adapters own real authority and side effects: Tauri/filesystem/daemon,
Cloudflare/OIDC/D1/R2/Durable Object policy, credentials, ACL mutation,
runtime-peer attachment, package trust enforcement, and launch/transport
concerns.

## Active Checklist

- [ ] Remove cloud-to-desktop app imports for headless projection/store/reset
      behavior. Cloud may keep the intentional component bridge through
      `notebook-surface` while shared component packaging is still app-owned,
      but headless store/projection helpers should live in shared modules.
      Runtime-state reads/writes now import from
      `src/components/notebook/state/runtime-state.ts`; remaining blockers are
      the heavier runtime store projection reset.
- [x] Make output identity strict for modern cloud/runtime paths: missing
      `output_id` values now render as invariant errors instead of receiving
      `cloud-output:*` positional IDs in the cloud resolver.
- [ ] Move host-neutral projection lifecycle helpers into shared
      notebook/runtimed modules. The cloud `notebook-view-store-bridge` should
      eventually disappear or become a thin host call site instead of a named
      abstraction layer.
- [ ] Finish shared-store convergence for focus, interaction,
      runtime/workstation status, and output cache identity. Each fact should
      have one projection owner and host-local write authority.
- [ ] Deduplicate shell/runtime/workstation projection facts while keeping host
      authority local. Shared helpers should project facts, not own callbacks,
      credentials, ACLs, launch, or attach policy.
- [ ] Extract reusable RxJS projection-store patterns only after concrete
      duplicated stores prove the shape. Avoid generic factories that hide
      simple store logic without reducing real coupling.
- [ ] Add import guard tests so Cloud cannot depend on Desktop app internals
      for shared headless behavior. The current guard still allows
      `notebook-surface-stores` as a temporary exception.
- [ ] Keep durable docs updated as boundaries become real decisions. Amend this
      checklist for execution status; amend ADRs only when the boundary becomes
      durable architecture.

## Host-Owned Boundaries

- Hosted auth, OIDC refresh, ACL rows, public-link policy, invites, access
  requests, room mutation, R2/D1/Durable Object behavior, and dev-token
  transport remain cloud-owned.
- Local filesystem mutability, Tauri commands, daemon launch/readiness, local
  package trust, and local kernel lifecycle remain desktop-owned.
- Runtime peers author runtime state only. They must not become document edit,
  package, share, or credential authorities.
- RuntimeStateDoc remains authoritative for execution, queue, and output
  snapshots. Placeholder projections must release ownership when runtime-owned
  records arrive.

## Completed Slices

- 2026-06-14: Cloud render resolution no longer stamps missing output IDs with
  `cloud-output:*`; missing IDs are visible invariant errors with diagnostic
  `resolution-error:missing-output-id:*` identities.
- 2026-06-14: Promoted the runtime-state React adapter from the desktop app to
  `src/components/notebook/state/runtime-state.ts`; Desktop re-exports it for
  compatibility and Cloud imports runtime reset/set/hooks from the shared state
  module directly.
- 2026-06-14: Promoted bootstrap-preservation helpers to
  `src/components/notebook/state/bootstrap-preservation.ts`; Desktop re-exports
  the old path for compatibility and Cloud imports the preservation predicate
  through the shared projection-lifecycle helper.
