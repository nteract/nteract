# runtimed TypeScript store primitives

Scope: the DOM-free store mechanism in `packages/runtimed/src`
(`observable-store.ts`, `poll.ts`, the free `select`, and store subclasses like
`runtime-state-store.ts`). Mechanism only - no React and no `document`/
`window`/`Date.now()` in this layer. The React binding is
`src/components/notebook/state/observable-binding.ts`; host-policy stores
(cloud auth/access-request/catalog/workstations) live in
`apps/notebook-cloud/viewer/` per the convergence memo's do-not-converge list.

## Invariants

- **`ObservableStore` emission order is load-bearing.** `setState` emits state
  before the `loaded$` gate; `resetState` flips the gate false before the
  default state lands. A subscriber combining the two must never see
  `loaded=true` alongside a not-yet-applied state.
- **`createPoll` after-settle re-arms on completion (`repeat`), never on
  emission.** A rejected fetch is swallowed to `EMPTY` and emits nothing; if
  re-arm depended on emission, one transient error would kill the loop.
- **`createPoll` fixed-rate funnels every trigger through ONE `exhaustMap`.**
  Interval tick, gate rise, and wakeups share a single in-flight guard; a
  trigger landing mid-fetch is dropped, never a concurrent request.
- **`interval$` is the teardown lever.** A new cadence (or `null`) tears down
  the running loop and aborts the in-flight fetch via `finalize`. Model dynamic
  cadence policy as this stream; do not add a second stop mechanism.
- **Every timer takes an injectable `SchedulerLike`.** New pipelines here must
  be virtual-time-total; tests never sleep on the wall clock.
- **Comparators are named and manifest-backed.** `distinctUntilChanged` uses
  named field-by-field `fooEquals` functions carrying a colocated
  `satisfies Record<keyof T, true>` manifest (keys listed, not proven
  compared). Never deep-equal or JSON in a dedup position.
- **The barrel uses explicit re-exports.** A new export must be added to
  `src/index.ts` or the `pnpm --dir apps/notebook build` tsc gate fails.

Decision record: `docs/adr/frontend-sync-bridge.md` Decision 8. How-to depth:
frontend-dev skill, "Module-Singleton Source Stores". Rust daemon guidance is
separate: `crates/runtimed/AGENTS.md`.
