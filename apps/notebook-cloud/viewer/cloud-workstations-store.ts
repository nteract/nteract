/**
 * Cloud viewer workstations store: the single owner of the hosted workstation
 * registry, the attach/default mutations, and the pairing-code lifecycle. One
 * store serves both the notebook rail manager and the standalone `/workstations`
 * page, replacing the three duplicate chained-timeout polls (rail registry, page
 * registry, pairing) with injected-scheduler RxJS drivers.
 *
 * The registry has two fetch phases with different error policy: a gate-driven
 * initial load and every `refreshNow()` surface an error (`status = "error"`),
 * while the background poll swallows failures and keeps the last-good registry.
 * Mutation refetches and the pairing `onRegistered` refetch run through one
 * `concatMap`-ordered action stream, deliberately off the poll loop so the
 * mutation->refetch coupling stays uncancelable by the poll and the cadence is
 * never perturbed. The dynamic registry cadence (`cloudWorkstationRefreshIntervalMs`,
 * null / 2.5s / 10s) is fed the store-derived mutation kind and registry size, so
 * an attach in flight speeds the poll without any external wiring.
 *
 * The auth-flip clear is split per surface and provided through `inputs$`: the
 * rail wipes the registry only when it loses authenticated identity, while the
 * standalone page flips to a `signed_out`/`loading` status without wiping. Both
 * are expressed as the consumer-supplied `closedGate`.
 *
 * The drivers live behind `activate(inputs$, deps)`, which returns a disposer.
 * Every timer threads `deps.scheduler`, the pairing-expiry clock reads
 * `deps.now()`, and every network operation is injectable, so the whole store is
 * virtual-time-total and node-testable without a browser.
 */

import {
  BehaviorSubject,
  EMPTY,
  Subject,
  Subscription,
  catchError,
  combineLatest,
  concatMap,
  defer,
  distinctUntilChanged,
  finalize,
  from,
  map,
  of,
  shareReplay,
  switchMap,
  timer,
  type Observable,
  type SchedulerLike,
} from "rxjs";
import { ObservableStore, createPoll, select } from "runtimed";
import type { NotebookRegisteredWorkstation, WorkstationAttachmentState } from "runtimed";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import {
  CLOUD_WORKSTATION_PAIRING_POLL_INTERVAL_MS,
  cloudWorkstationConnectCommand,
  cloudWorkstationPairingCommands,
  cloudWorkstationRefreshIntervalMs,
  fetchCloudWorkstations,
  fetchCloudWorkstationPairingStatus,
  mintCloudWorkstationPairingCode,
  requestCloudWorkstationAttachment,
  setCloudDefaultWorkstation,
  type CloudWorkstationAttachmentRequestResult,
  type CloudWorkstationPairingCommand,
  type CloudWorkstationPairingStatus,
  type CloudWorkstationPairingStatusState,
  type MintedCloudWorkstationPairing,
} from "./workstations-client";

/** Message shown while an attach mutation waits for the workstation to join. */
const DEFAULT_ATTACH_MESSAGE =
  "Starting compute. Waiting for the workstation to join this notebook.";

/** Rejection sentinel for a fetch that should no-op (missing endpoint/gate). */
const POLL_SKIP = Symbol("cloud-workstations-poll-skip");

/**
 * Pairing-code lifecycle shared by the notebook rail panel and the workstations
 * management page: mint a code, poll redemption, flip to expired client-side,
 * and resolve the registered workstation's name against the registry.
 */
export interface CloudWorkstationPairing {
  id: string;
  code: string;
  connectCommand: string;
  commands: readonly CloudWorkstationPairingCommand[];
  expiresAt: string;
  status: CloudWorkstationPairingStatus;
  workstationId: string | null;
  workstationName: string | null;
  error: string | null;
}

/** The registry payload the fetch resolves. */
export interface CloudWorkstationsRegistry {
  defaultWorkstationId: string | null;
  workstations: readonly NotebookRegisteredWorkstation[];
}

/** The in-flight mutation, surfaced to the toolbar/panel. */
export interface CloudWorkstationMutationState {
  kind: "idle" | "default" | "attach";
  message: string | null;
  workstationId: string | null;
}

/**
 * Registry lifecycle status. The standalone page renders it directly
 * (loading/signed-out/error/ready); the rail manager ignores it and reads the
 * registry, error, and mutation slices.
 */
export type CloudWorkstationsRegistryStatus = "idle" | "loading" | "signed_out" | "ready" | "error";

/** The store's authoritative registry + mutation + pairing state. */
export interface CloudWorkstationsState {
  status: CloudWorkstationsRegistryStatus;
  registry: CloudWorkstationsRegistry;
  error: string | null;
  mutation: CloudWorkstationMutationState;
  pairing: CloudWorkstationPairing | null;
}

/**
 * What to do while the fetch gate is closed. The rail computes
 * `{ status: authed ? "loading" : "signed_out", wipeRegistry: !authed }` so a
 * transient loss of hosted eligibility keeps the registry, while a true
 * identity loss wipes it. The page computes `{ status: waiting ? "loading" :
 * "signed_out", wipeRegistry: false }` and hides the registry through `status`.
 */
export interface CloudWorkstationsClosedGate {
  status: "loading" | "signed_out";
  wipeRegistry: boolean;
}

/**
 * The React-owned inputs the drivers read. Assembled by the controller and
 * pushed through `useLiveInputs` on every render. The store treats these as the
 * fetch gate, the fetch identity, and the cadence inputs; it never mutates them.
 */
export interface CloudWorkstationsInputs {
  /** Stable fetch identity for every workstation request. */
  auth: CloudPrototypeAuthState;
  /** The registry + pairing endpoint (`/api/workstations`). */
  workstationsEndpoint: string | undefined;
  /** The set-default endpoint, or undefined when defaults are unavailable. */
  defaultEndpoint: string | undefined;
  /** The attach endpoint, or undefined when attach is unavailable. */
  attachEndpoint: string | undefined;
  /** Whether the registry may be fetched now (owner + authenticated + eligible). */
  canFetch: boolean;
  /** Feeds the dynamic cadence (rail: panel open; page: always true). */
  panelIsOpen: boolean;
  /**
   * Hold the background cadence until the registry status settles (ready or
   * error). The standalone page sets this so a first load with zero registered
   * workstations cannot start the 10s poll while the initial load is still
   * pending, overlapping it. The rail leaves it false and polls off the shared
   * cadence policy alone, having no lifecycle status to gate on. `error` stays a
   * polling state either way, so a failed load auto-recovers.
   */
  gateCadenceUntilSettled: boolean;
  /** The closed-gate outcome for this surface. */
  closedGate: CloudWorkstationsClosedGate;
}

/** Injected clock/scheduler/origin and the network operations. */
export interface CloudWorkstationsStoreDeps {
  scheduler?: SchedulerLike;
  /** Epoch milliseconds for the pairing-expiry clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Origin for the pairing connect command. Defaults to `window.location.origin`. */
  origin?: string;
  /** Live workstation attachment stream for the attach cross-channel confirm. */
  workstation$?: Observable<WorkstationAttachmentState | null>;
  loadWorkstations?: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
    signal: AbortSignal;
  }) => Promise<CloudWorkstationsRegistry>;
  setDefaultWorkstation?: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
    workstationId: string;
  }) => Promise<string | null>;
  attachWorkstation?: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
    workstationId: string;
    replaceExisting: boolean;
  }) => Promise<CloudWorkstationAttachmentRequestResult>;
  mintPairing?: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
  }) => Promise<MintedCloudWorkstationPairing>;
  fetchPairingStatus?: (params: {
    endpoint: string;
    auth: CloudPrototypeAuthState;
    pairingId: string;
    signal: AbortSignal;
  }) => Promise<CloudWorkstationPairingStatusState>;
}

/** Options for an attach mutation. */
export interface CloudWorkstationAttachOptions {
  message?: string;
  replaceExisting?: boolean;
}

interface ResolvedWorkstationsDeps {
  now: () => number;
  origin: string;
  loadWorkstations: NonNullable<CloudWorkstationsStoreDeps["loadWorkstations"]>;
  setDefaultWorkstation: NonNullable<CloudWorkstationsStoreDeps["setDefaultWorkstation"]>;
  attachWorkstation: NonNullable<CloudWorkstationsStoreDeps["attachWorkstation"]>;
  mintPairing: NonNullable<CloudWorkstationsStoreDeps["mintPairing"]>;
  fetchPairingStatus: NonNullable<CloudWorkstationsStoreDeps["fetchPairingStatus"]>;
}

interface RegistryGateInput {
  canFetch: boolean;
  endpoint: string | undefined;
  auth: CloudPrototypeAuthState;
  closedGate: CloudWorkstationsClosedGate;
}

const EMPTY_REGISTRY: CloudWorkstationsRegistry = {
  defaultWorkstationId: null,
  workstations: [],
};

const EMPTY_STATE: CloudWorkstationsState = {
  status: "idle",
  registry: EMPTY_REGISTRY,
  error: null,
  mutation: { kind: "idle", message: null, workstationId: null },
  pairing: null,
};

/** Dedup identity for the registry projection. */
export function cloudWorkstationsRegistryEquals(
  a: CloudWorkstationsRegistry,
  b: CloudWorkstationsRegistry,
): boolean {
  return (
    a === b ||
    (a.defaultWorkstationId === b.defaultWorkstationId && a.workstations === b.workstations)
  );
}
// Adding a field to `CloudWorkstationsRegistry` breaks this manifest's
// typecheck, flagging the comparator for update.
const _CLOUD_WORKSTATIONS_REGISTRY_FIELDS = {
  defaultWorkstationId: true,
  workstations: true,
} satisfies Record<keyof CloudWorkstationsRegistry, true>;
void _CLOUD_WORKSTATIONS_REGISTRY_FIELDS;

/** Dedup identity for the mutation projection. */
export function cloudWorkstationMutationEquals(
  a: CloudWorkstationMutationState,
  b: CloudWorkstationMutationState,
): boolean {
  return (
    a === b || (a.kind === b.kind && a.message === b.message && a.workstationId === b.workstationId)
  );
}
// Adding a field to `CloudWorkstationMutationState` breaks this manifest's
// typecheck, flagging the comparator for update.
const _CLOUD_WORKSTATION_MUTATION_FIELDS = {
  kind: true,
  message: true,
  workstationId: true,
} satisfies Record<keyof CloudWorkstationMutationState, true>;
void _CLOUD_WORKSTATION_MUTATION_FIELDS;

/** Dedup identity for the name-resolved pairing projection. */
export function cloudWorkstationPairingEquals(
  a: CloudWorkstationPairing | null,
  b: CloudWorkstationPairing | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.id === b.id &&
    a.code === b.code &&
    a.connectCommand === b.connectCommand &&
    a.commands === b.commands &&
    a.expiresAt === b.expiresAt &&
    a.status === b.status &&
    a.workstationId === b.workstationId &&
    a.workstationName === b.workstationName &&
    a.error === b.error
  );
}
// Adding a field to `CloudWorkstationPairing` breaks this manifest's typecheck,
// flagging the comparator for update.
const _CLOUD_WORKSTATION_PAIRING_FIELDS = {
  id: true,
  code: true,
  connectCommand: true,
  commands: true,
  expiresAt: true,
  status: true,
  workstationId: true,
  workstationName: true,
  error: true,
} satisfies Record<keyof CloudWorkstationPairing, true>;
void _CLOUD_WORKSTATION_PAIRING_FIELDS;

/** Dedup the registry gate: refetch only on a fetch-identity or gate change. */
function registryGateEquals(a: RegistryGateInput, b: RegistryGateInput): boolean {
  return (
    a.canFetch === b.canFetch &&
    a.endpoint === b.endpoint &&
    a.auth === b.auth &&
    a.closedGate.status === b.closedGate.status &&
    a.closedGate.wipeRegistry === b.closedGate.wipeRegistry
  );
}

/** Whether the pairing status is one the redemption poll should chase. */
function pairingPollActive(pairing: CloudWorkstationPairing | null): boolean {
  return (
    pairing !== null &&
    pairing.id !== "" &&
    (pairing.status === "pending" || pairing.status === "redeemed")
  );
}

/** Join the pairing's registered workstation against the registry for its name. */
function resolvePairingName(
  pairing: CloudWorkstationPairing | null,
  workstations: readonly NotebookRegisteredWorkstation[],
): CloudWorkstationPairing | null {
  if (!pairing) {
    return null;
  }
  if (!pairing.workstationId) {
    return pairing;
  }
  const registered = workstations.find((workstation) => workstation.id === pairing.workstationId);
  return registered ? { ...pairing, workstationName: registered.displayName } : pairing;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export class CloudWorkstationsStore extends ObservableStore<CloudWorkstationsState> {
  /** Registry lifecycle status; the page renders it directly. */
  readonly status$: Observable<CloudWorkstationsRegistryStatus>;
  /** The registered workstations + default id. */
  readonly registry$: Observable<CloudWorkstationsRegistry>;
  /** Last surfaced registry error (initial load, mutation, or `refreshNow`). */
  readonly error$: Observable<string | null>;
  /** The in-flight mutation for the toolbar/panel. */
  readonly mutation$: Observable<CloudWorkstationMutationState>;
  /** The pairing with its registered workstation's display name resolved. */
  readonly pairingWithName$: Observable<CloudWorkstationPairing | null>;

  // A BehaviorSubject so the cadence `combineLatest` sees the current inputs the
  // moment it subscribes, not only the next push.
  private readonly _inputs$ = new BehaviorSubject<CloudWorkstationsInputs | null>(null);
  private latestInputs: CloudWorkstationsInputs | null = null;
  private resolvedDeps: ResolvedWorkstationsDeps | null = null;
  /**
   * Monotonic activation counter, bumped on every `activate` and its disposer.
   * An imperative mutation captures the epoch it was issued under so a completion
   * that lands after a dispose/re-activate drops itself rather than writing into
   * the current mount. This is the mint/attach/set-default analogue of the poll
   * paths' `RegistryTick`/`PairingStatusTick` auth tag.
   */
  private activationEpoch = 0;
  /**
   * Activation epoch of the in-flight pairing mint, or null when none is pending.
   * Unlike `attach`/`setDefault`, which set a mutation state synchronously (so the
   * UI disables their control during the request), `startPairing` writes no state
   * until the mint resolves, so nothing stops a second click from minting a
   * second, orphaned pairing code. Latching the epoch gives the action
   * `exhaustMap` semantics for concurrent calls under one mount, while staying
   * lifecycle-owned: dispose / re-activate / the signed-out gate all bump the
   * epoch (like the `captureMutationIssue` guard), so a mint left in flight across
   * that boundary neither blocks a fresh mint nor lets its late completion clear a
   * newer mint's latch.
   */
  private pairingMintEpoch: number | null = null;
  /** Ordered refetch action stream; each carries a settle callback. */
  private readonly refetchRequests$ = new Subject<() => void>();

  constructor() {
    super(EMPTY_STATE);
    this.status$ = this.select((state) => state.status);
    this.registry$ = this.select((state) => state.registry, cloudWorkstationsRegistryEquals);
    this.error$ = this.select((state) => state.error);
    this.mutation$ = this.select((state) => state.mutation, cloudWorkstationMutationEquals);
    this.pairingWithName$ = combineLatest([
      this.select((state) => state.pairing),
      this.select((state) => state.registry.workstations),
    ]).pipe(
      map(([pairing, workstations]) => resolvePairingName(pairing, workstations)),
      distinctUntilChanged(cloudWorkstationPairingEquals),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
  }

  /**
   * Start the workstation drivers and return a disposer. Called once per mount
   * from the controller; the state is reset first so a fresh mount (or a new
   * page) starts from a clean registry.
   */
  activate(
    inputs$: Observable<CloudWorkstationsInputs>,
    deps: CloudWorkstationsStoreDeps,
  ): () => void {
    const epoch = (this.activationEpoch += 1);
    this.resetState(EMPTY_STATE);
    const resolved = this.resolveDeps(deps);
    this.resolvedDeps = resolved;

    const subscription = new Subscription();

    // Track the latest inputs first, so every fetch closure and the cadence read
    // the current gate/identity rather than a stale render's.
    subscription.add(
      inputs$.subscribe((inputs) => {
        this.latestInputs = inputs;
        this._inputs$.next(inputs);
      }),
    );

    // Gate driver: a fetch-identity/gate rise loads once and surfaces an error; a
    // gate fall applies the surface's closed-gate outcome. `switchMap` inside
    // `fetchLatest` aborts a superseded load.
    subscription.add(
      select(
        inputs$,
        (inputs): RegistryGateInput => ({
          canFetch: inputs.canFetch && Boolean(inputs.workstationsEndpoint),
          endpoint: inputs.workstationsEndpoint,
          auth: inputs.auth,
          closedGate: inputs.closedGate,
        }),
        registryGateEquals,
      )
        .pipe(
          switchMap((gate) =>
            gate.canFetch && gate.endpoint
              ? defer(() => {
                  this.beginLoad();
                  const controller = new AbortController();
                  return from(
                    resolved.loadWorkstations({
                      endpoint: gate.endpoint as string,
                      auth: gate.auth,
                      signal: controller.signal,
                    }),
                  ).pipe(
                    finalize(() => controller.abort()),
                    map((registry) => ({ registry })),
                    catchError((error) => {
                      this.applyRegistryError(errorMessage(error));
                      return EMPTY;
                    }),
                  );
                })
              : defer(() => {
                  this.applyClosedGate(gate.closedGate);
                  return EMPTY;
                }),
          ),
        )
        .subscribe((result) => this.applyRegistrySuccess(result.registry)),
    );

    // Background poll: dynamic cadence off `cloudWorkstationRefreshIntervalMs`,
    // fed the store-derived mutation kind and registry size so an attach speeds
    // it up. `after-settle` cannot overlap, and failures are swallowed to keep
    // the last-good registry. Each result carries the auth it was fetched under,
    // so an auth flip mid-flight drops the stale response at apply time (the poll
    // loop does not resubscribe on an auth change, unlike the gate driver).
    subscription.add(
      createPoll<RegistryTick>({
        strategy: "after-settle",
        interval$: this.registryInterval$(),
        scheduler: deps.scheduler,
        fetch: (signal) => this.runBackgroundLoad(signal),
        onError: () => {},
      }).subscribe((tick) => this.applyRegistryTickIfCurrent(tick)),
    );

    // Ordered refetch actions: mutation refetches, the pairing `onRegistered`
    // refetch, and manual refreshes run in order, off the poll loop, and surface
    // their error. Each resolves its caller's `refreshNow()` promise on settle.
    subscription.add(
      this.refetchRequests$
        .pipe(
          concatMap((done) =>
            defer(() => {
              this.beginLoad();
              // The refetch runs under whichever identity is current when its
              // turn in the queue comes, but its response can land after a
              // later flip - so it is tagged and dropped at apply exactly like
              // a background tick, and its error write is guarded the same way.
              const auth = this.latestInputs?.auth ?? null;
              const controller = new AbortController();
              return from(this.runCurrentLoad(controller.signal)).pipe(
                // `runCurrentLoad` rejects when inputs (and thus auth) are
                // missing, so a resolved registry always carries an identity.
                map((registry) => ({ auth: auth as CloudPrototypeAuthState, registry })),
                catchError((error) => {
                  if (error !== POLL_SKIP && this.latestInputs?.auth === auth) {
                    this.applyRegistryError(errorMessage(error));
                  }
                  return EMPTY;
                }),
                finalize(() => {
                  controller.abort();
                  done();
                }),
              );
            }),
          ),
        )
        .subscribe((tick) => this.applyRegistryTickIfCurrent(tick)),
    );

    // Pairing redemption poll: chases {pending, redeemed} at 2s, stops on
    // {registered, expired}. Stale responses are dropped by the id guard, and by
    // the auth-identity guard when an auth flip lands mid-flight.
    subscription.add(
      createPoll<PairingStatusTick>({
        strategy: "after-settle",
        interval$: this.select((state) =>
          pairingPollActive(state.pairing) ? CLOUD_WORKSTATION_PAIRING_POLL_INTERVAL_MS : null,
        ),
        scheduler: deps.scheduler,
        fetch: (signal) => this.runPairingStatus(signal),
        onError: () => {},
      }).subscribe((tick) => this.applyPairingStatus(tick)),
    );

    // Pairing expiry: a client-driven flip so the card expires even if no poll
    // lands on the boundary. The remaining time reads `deps.now()`, never
    // `Date.now()`, so the clock stays virtual-time-total.
    subscription.add(
      this.select((state) => state.pairing)
        .pipe(
          switchMap((pairing) => {
            if (!pairing || pairing.status !== "pending") {
              return EMPTY;
            }
            const remaining = Date.parse(pairing.expiresAt) - resolved.now();
            if (!Number.isFinite(remaining)) {
              return EMPTY;
            }
            const pairingId = pairing.id;
            return remaining <= 0
              ? of(pairingId)
              : timer(remaining, deps.scheduler).pipe(map(() => pairingId));
          }),
        )
        .subscribe((pairingId) => this.expirePairing(pairingId)),
    );

    // Attach cross-channel confirm: the live runtime attachment (a different
    // channel than the HTTP response) clears the attach mutation once the target
    // workstation joins.
    if (deps.workstation$) {
      subscription.add(deps.workstation$.subscribe((attachment) => this.confirmAttach(attachment)));
    }

    return () => {
      if (this.activationEpoch === epoch) {
        this.activationEpoch += 1;
      }
      subscription.unsubscribe();
      this.resolvedDeps = null;
      this.latestInputs = null;
    };
  }

  /** Mint a pairing code and show it as pending; a mint failure shows expired. */
  async startPairing(): Promise<void> {
    const inputs = this.latestInputs;
    const deps = this.resolvedDeps;
    if (!inputs || !deps || !inputs.workstationsEndpoint) {
      return;
    }
    if (this.pairingMintEpoch === this.activationEpoch) {
      return;
    }
    const mintEpoch = this.activationEpoch;
    this.pairingMintEpoch = mintEpoch;
    const endpoint = inputs.workstationsEndpoint;
    const issue = this.captureMutationIssue(inputs.auth, endpoint);
    try {
      const minted = await deps.mintPairing({ endpoint, auth: inputs.auth });
      if (!this.mutationStillCurrent(issue, this.latestInputs?.workstationsEndpoint)) {
        return;
      }
      this.updateState((state) => ({
        ...state,
        pairing: {
          id: minted.id,
          code: minted.code,
          connectCommand: cloudWorkstationConnectCommand(deps.origin, minted.code),
          commands: cloudWorkstationPairingCommands(deps.origin, minted.code),
          expiresAt: minted.expiresAt,
          status: "pending",
          workstationId: null,
          workstationName: null,
          error: null,
        },
      }));
    } catch (error) {
      if (!this.mutationStillCurrent(issue, this.latestInputs?.workstationsEndpoint)) {
        return;
      }
      this.updateState((state) => ({
        ...state,
        pairing: {
          id: "",
          code: "",
          connectCommand: "",
          commands: [],
          expiresAt: new Date(0).toISOString(),
          status: "expired",
          workstationId: null,
          workstationName: null,
          error: errorMessage(error),
        },
      }));
    } finally {
      // Clear only if this call still owns the latch. A mint whose epoch was
      // superseded by a dispose/re-activate must not clear a newer mint's latch.
      if (this.pairingMintEpoch === mintEpoch) {
        this.pairingMintEpoch = null;
      }
    }
  }

  /** Drop the pairing card. */
  cancelPairing(): void {
    this.updateState((state) => (state.pairing === null ? state : { ...state, pairing: null }));
  }

  /**
   * Set the default workstation: optimistically patch the id, then run an
   * ordered refetch. The mutation kind is held through the refetch and cleared in
   * `finally` (success or failure).
   */
  async setDefault(workstationId: string): Promise<void> {
    const inputs = this.latestInputs;
    const deps = this.resolvedDeps;
    if (!inputs || !deps || !inputs.defaultEndpoint) {
      return;
    }
    const issue = this.captureMutationIssue(inputs.auth, inputs.defaultEndpoint);
    const mutation: CloudWorkstationMutationState = {
      kind: "default",
      message: null,
      workstationId,
    };
    this.setMutation(mutation);
    try {
      const defaultWorkstationId = await deps.setDefaultWorkstation({
        endpoint: inputs.defaultEndpoint,
        auth: inputs.auth,
        workstationId,
      });
      if (!this.mutationStillCurrent(issue, this.latestInputs?.defaultEndpoint)) {
        return;
      }
      this.updateState((state) => ({
        ...state,
        registry: {
          ...state.registry,
          defaultWorkstationId: defaultWorkstationId ?? workstationId,
        },
      }));
      this.clearError();
      await this.refreshNow();
    } catch (error) {
      if (this.mutationStillCurrent(issue, this.latestInputs?.defaultEndpoint)) {
        this.setError(errorMessage(error));
      }
    } finally {
      // A still-current action clears to idle unconditionally. A superseded one
      // must not write idle over a mutation the new identity started, so it
      // clears only the object it owns - covering the drop paths above AND an
      // identity flip that lands during the post-success refetch await.
      if (this.mutationStillCurrent(issue, this.latestInputs?.defaultEndpoint)) {
        this.setMutation({ kind: "idle", message: null, workstationId: null });
      } else {
        this.clearMutationIfOwned(mutation);
      }
    }
  }

  /**
   * Request a workstation attach. Sets the attach mutation, POSTs, then runs an
   * ordered refetch (on success and failure). On success the mutation stays
   * "attach" until the cross-channel confirm clears it; on failure it clears
   * immediately.
   */
  async attach(
    workstationId: string,
    options: CloudWorkstationAttachOptions = {},
  ): Promise<boolean> {
    const inputs = this.latestInputs;
    const deps = this.resolvedDeps;
    if (!inputs || !deps || !inputs.attachEndpoint) {
      return false;
    }
    const issue = this.captureMutationIssue(inputs.auth, inputs.attachEndpoint);
    const mutation: CloudWorkstationMutationState = {
      kind: "attach",
      message: options.message ?? DEFAULT_ATTACH_MESSAGE,
      workstationId,
    };
    this.setMutation(mutation);
    try {
      const attached = await deps.attachWorkstation({
        endpoint: inputs.attachEndpoint,
        auth: inputs.auth,
        workstationId,
        replaceExisting: options.replaceExisting === true,
      });
      if (!this.mutationStillCurrent(issue, this.latestInputs?.attachEndpoint)) {
        this.clearMutationIfOwned(mutation);
        return false;
      }
      const acknowledgedWorkstationId = trimToNull(attached.workstationId) ?? workstationId;
      if (acknowledgedWorkstationId !== mutation.workstationId) {
        this.setMutation({ ...mutation, workstationId: acknowledgedWorkstationId });
      }
      this.clearError();
      await this.refreshNow();
      return true;
    } catch (error) {
      if (!this.mutationStillCurrent(issue, this.latestInputs?.attachEndpoint)) {
        this.clearMutationIfOwned(mutation);
        return false;
      }
      this.setError(errorMessage(error));
      this.setMutation({ kind: "idle", message: null, workstationId: null });
      await this.refreshNow();
      return false;
    }
  }

  /** Enqueue an ordered, error-surfacing registry refetch. */
  refreshNow(): Promise<void> {
    return new Promise<void>((resolve) => this.refetchRequests$.next(resolve));
  }

  /**
   * The dynamic registry cadence: null / 2.5s / 10s per the shared policy. When
   * the surface asks to gate on a settled status, an unsettled status (idle or
   * loading) forces null so a background tick cannot overlap the initial load;
   * `ready` and `error` both poll, keeping error auto-recovery.
   */
  private registryInterval$(): Observable<number | null> {
    return combineLatest([
      this._inputs$.pipe(
        map((inputs) => Boolean(inputs?.canFetch)),
        distinctUntilChanged(),
      ),
      this.select((state) => state.registry.workstations.length > 0),
      this.select((state) => state.mutation.kind),
      this._inputs$.pipe(
        map((inputs) => Boolean(inputs?.panelIsOpen)),
        distinctUntilChanged(),
      ),
      this._inputs$.pipe(
        map((inputs) => Boolean(inputs?.gateCadenceUntilSettled)),
        distinctUntilChanged(),
      ),
      this.select((state) => state.status),
    ]).pipe(
      map(
        ([
          canFetch,
          hasRegisteredWorkstations,
          mutationKind,
          panelIsOpen,
          gateUntilSettled,
          status,
        ]) => {
          if (gateUntilSettled && status !== "ready" && status !== "error") {
            return null;
          }
          return cloudWorkstationRefreshIntervalMs({
            canChooseHostedWorkstation: canFetch,
            hasRegisteredWorkstations,
            mutationKind,
            panelIsOpen,
          });
        },
      ),
      distinctUntilChanged(),
    );
  }

  /** Fetch the registry with the current inputs, or skip when the gate is shut. */
  private runCurrentLoad(signal: AbortSignal): Promise<CloudWorkstationsRegistry> {
    const inputs = this.latestInputs;
    const deps = this.resolvedDeps;
    if (!inputs || !deps || !inputs.canFetch || !inputs.workstationsEndpoint) {
      return Promise.reject(POLL_SKIP);
    }
    return deps.loadWorkstations({
      endpoint: inputs.workstationsEndpoint,
      auth: inputs.auth,
      signal,
    });
  }

  /**
   * Fetch the registry for the background poll, tagged with the auth identity it
   * was issued under. The apply step drops a tick whose identity no longer
   * matches, so an auth flip mid-flight cannot overwrite the registry with data
   * fetched under the superseded identity.
   */
  private runBackgroundLoad(signal: AbortSignal): Promise<RegistryTick> {
    const auth = this.latestInputs?.auth ?? null;
    return this.runCurrentLoad(signal).then((registry) => ({
      // `runCurrentLoad` rejects when inputs (and thus auth) are missing, so a
      // resolved registry always carries a captured identity.
      auth: auth as CloudPrototypeAuthState,
      registry,
    }));
  }

  /** Fetch the current pairing's redemption status, tagged with its id and auth. */
  private async runPairingStatus(signal: AbortSignal): Promise<PairingStatusTick> {
    const inputs = this.latestInputs;
    const deps = this.resolvedDeps;
    const pairing = this.snapshot.pairing;
    if (!inputs || !deps || !inputs.workstationsEndpoint || !pairing || !pairing.id) {
      return Promise.reject(POLL_SKIP);
    }
    const auth = inputs.auth;
    const pairingId = pairing.id;
    const status = await deps.fetchPairingStatus({
      endpoint: inputs.workstationsEndpoint,
      auth,
      pairingId,
      signal,
    });
    return { pairingId, auth, status };
  }

  /** Reset to loading before a fetch, unless the registry is already shown. */
  private beginLoad(): void {
    this.updateState((state) =>
      state.status === "ready" ? state : { ...state, status: "loading" },
    );
  }

  /** Apply a resolved registry: mark ready and clear the error. */
  private applyRegistrySuccess(registry: CloudWorkstationsRegistry): void {
    this.updateState((state) => ({ ...state, status: "ready", registry, error: null }));
  }

  /**
   * Apply a background poll result, dropping a response whose issuing auth no
   * longer matches the current fetch identity (an auth flip landed mid-flight).
   */
  private applyRegistryTickIfCurrent(tick: RegistryTick): void {
    if (this.latestInputs?.auth !== tick.auth) {
      return;
    }
    this.applyRegistrySuccess(tick.registry);
  }

  /** Surface a registry load failure without dropping the last-good registry. */
  private applyRegistryError(message: string): void {
    this.updateState((state) => ({ ...state, status: "error", error: message }));
  }

  /**
   * Apply the surface's closed-gate outcome: flip status, wipe the registry only
   * when asked (rail lost-identity), and clear the error. A `signed_out` gate is
   * the singleton's stand-in for the manager hook unmounting, so it also drops
   * the mutation and pairing and invalidates in-flight issues; a `loading` gate
   * is a recoverable eligibility dip and keeps them.
   */
  private applyClosedGate(gate: CloudWorkstationsClosedGate): void {
    // Only a lost identity is the unmount analog. A transient `loading` gate
    // (eligibility dip with the user still signed in) keeps the pairing card,
    // the mutation, and in-flight issues alive, matching the per-component
    // hooks that stayed mounted through it. On `signed_out`, captured mutation
    // issues die with the gate: a mint/attach/set-default resolving after the
    // close must stay dropped even when the auth reference and endpoint are
    // unchanged, so clearing the visible card below is not enough on its own.
    const identityLost = gate.status === "signed_out";
    if (identityLost) {
      this.activationEpoch += 1;
    }
    this.updateState((state) => ({
      ...state,
      status: gate.status,
      registry: gate.wipeRegistry ? EMPTY_REGISTRY : state.registry,
      error: null,
      mutation: identityLost
        ? { kind: "idle", message: null, workstationId: null }
        : state.mutation,
      pairing: identityLost ? null : state.pairing,
    }));
  }

  /** Apply a pairing status tick, dropping a stale-id or stale-auth response. */
  private applyPairingStatus(tick: PairingStatusTick): void {
    const { pairingId, auth, status } = tick;
    // An auth flip landed mid-flight: the status was fetched under a superseded
    // identity, so drop it rather than apply it to the current pairing.
    if (this.latestInputs?.auth !== auth) {
      return;
    }
    const current = this.snapshot.pairing;
    if (!current || current.id !== pairingId) {
      return;
    }
    this.updateState((state) =>
      state.pairing && state.pairing.id === pairingId
        ? {
            ...state,
            pairing: {
              ...state.pairing,
              status: status.status,
              workstationId: status.workstationId,
              error: null,
            },
          }
        : state,
    );
    if (status.status === "registered") {
      void this.refreshNow();
    }
  }

  /** Flip a still-pending pairing to expired when its deadline passes. */
  private expirePairing(pairingId: string): void {
    this.updateState((state) =>
      state.pairing && state.pairing.id === pairingId && state.pairing.status === "pending"
        ? { ...state, pairing: { ...state.pairing, status: "expired" } }
        : state,
    );
  }

  /** Clear the attach mutation once the target workstation joins the runtime. */
  private confirmAttach(attachment: WorkstationAttachmentState | null): void {
    const mutation = this.snapshot.mutation;
    if (mutation.kind !== "attach" || !attachment?.workstation_id) {
      return;
    }
    if (!mutation.workstationId || mutation.workstationId === attachment.workstation_id) {
      this.setMutation({ kind: "idle", message: null, workstationId: null });
    }
  }

  /** Snapshot the identity an imperative mutation is issued under. */
  private captureMutationIssue(
    auth: CloudPrototypeAuthState,
    endpoint: string,
  ): WorkstationsMutationIssue {
    return { epoch: this.activationEpoch, auth, endpoint };
  }

  /**
   * Whether a mutation issued under `issue` may still apply its completion. The
   * store is one singleton shared by the rail and `/workstations`, so a sign-out,
   * auth flip, or dispose/re-activate can land while a mint/attach/set-default is
   * in flight. A bumped epoch or a changed auth reference or endpoint means the
   * resolved (or rejected) response belongs to a superseded identity, so its
   * state writes and refetch dispatches drop, mirroring the poll paths' auth tag.
   */
  private mutationStillCurrent(
    issue: WorkstationsMutationIssue,
    currentEndpoint: string | undefined,
  ): boolean {
    return (
      this.activationEpoch === issue.epoch &&
      this.latestInputs?.auth === issue.auth &&
      currentEndpoint === issue.endpoint
    );
  }

  private setMutation(mutation: CloudWorkstationMutationState): void {
    this.updateState((state) => ({ ...state, mutation }));
  }

  /**
   * Clear a mutation indicator written by a now-superseded action. Ownership is
   * the exact object the action wrote: a newer identity's `setMutation` has
   * replaced the object, so a stale clear can never clobber a mutation the
   * current identity started, while a stuck indicator from the old identity
   * cannot outlive its dropped completion.
   */
  private clearMutationIfOwned(owned: CloudWorkstationMutationState): void {
    if (this.snapshot.mutation === owned) {
      this.setMutation({ kind: "idle", message: null, workstationId: null });
    }
  }

  private setError(message: string): void {
    this.updateState((state) => ({ ...state, error: message }));
  }

  private clearError(): void {
    this.updateState((state) => (state.error === null ? state : { ...state, error: null }));
  }

  private resolveDeps(deps: CloudWorkstationsStoreDeps): ResolvedWorkstationsDeps {
    return {
      now: deps.now ?? (() => Date.now()),
      origin: deps.origin ?? defaultOrigin(),
      loadWorkstations:
        deps.loadWorkstations ??
        (({ endpoint, auth, signal }) => fetchCloudWorkstations(endpoint, auth, signal)),
      setDefaultWorkstation:
        deps.setDefaultWorkstation ??
        (({ endpoint, auth, workstationId }) =>
          setCloudDefaultWorkstation(endpoint, auth, workstationId)),
      attachWorkstation:
        deps.attachWorkstation ??
        (({ endpoint, auth, workstationId, replaceExisting }) =>
          requestCloudWorkstationAttachment(endpoint, auth, workstationId, { replaceExisting })),
      mintPairing:
        deps.mintPairing ??
        (({ endpoint, auth }) => mintCloudWorkstationPairingCode(endpoint, auth)),
      fetchPairingStatus:
        deps.fetchPairingStatus ??
        (({ endpoint, auth, pairingId, signal }) =>
          fetchCloudWorkstationPairingStatus(endpoint, auth, pairingId, signal)),
    };
  }
}

/**
 * The identity an imperative mutation captured at issue. Its post-await guard
 * drops the completion when the activation epoch, auth reference, or endpoint no
 * longer matches the live activation.
 */
interface WorkstationsMutationIssue {
  epoch: number;
  auth: CloudPrototypeAuthState;
  endpoint: string;
}

/** One background registry poll result, tagged with the auth it was fetched under. */
interface RegistryTick {
  auth: CloudPrototypeAuthState;
  registry: CloudWorkstationsRegistry;
}

/** One pairing redemption poll result, tagged with the id and auth it used. */
interface PairingStatusTick {
  pairingId: string;
  auth: CloudPrototypeAuthState;
  status: CloudWorkstationPairingStatusState;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The workstations store singleton. Survives route changes like the other cloud
 * viewer stores; each page load starts from a clean registry because `activate`
 * resets the state.
 */
export const cloudWorkstationsStore = new CloudWorkstationsStore();
