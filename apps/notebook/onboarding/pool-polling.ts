import { createPoll, type PoolState } from "runtimed";
import {
  defer,
  distinctUntilChanged,
  map,
  of,
  scan,
  startWith,
  takeWhile,
  type Observable,
  type SchedulerLike,
} from "rxjs";
import {
  hasOnboardingPoolError,
  isOnboardingPoolReady,
  onboardingPoolErrorMessage,
  type PythonEnv,
} from "./pool-readiness";

export type OnboardingPoolGate =
  | {
      kind: "checking" | "warming";
      canContinue: false;
      label: string;
      stepStatus: "in_progress";
      errorMessage: null;
    }
  | {
      kind: "slow" | "unavailable";
      canContinue: true;
      label: string;
      stepStatus: "failed";
      errorMessage: null;
    }
  | {
      kind: "failed";
      canContinue: true;
      label: string;
      stepStatus: "failed";
      errorMessage: string;
    }
  | {
      kind: "retrying";
      canContinue: true;
      label: string;
      stepStatus: "in_progress";
      errorMessage: null;
    }
  | {
      kind: "ready";
      canContinue: true;
      label: string;
      stepStatus: "completed";
      errorMessage: null;
    };

type PoolPollOutcome =
  | { kind: "state"; state: PoolState }
  | { kind: "unavailable"; error: unknown };

type PoolPollAccumulator = {
  attempts: number;
  bypassAllowed: boolean;
  gate: OnboardingPoolGate;
};

export type ObserveOnboardingPoolOptions = {
  pythonEnv: PythonEnv;
  envLabel: string;
  fetchPoolState: (signal: AbortSignal) => Promise<PoolState>;
  pollIntervalMs?: number;
  idlePollAttempts?: number;
  warmingPollAttempts?: number;
  scheduler?: SchedulerLike;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_IDLE_POLL_ATTEMPTS = 10;
const DEFAULT_WARMING_POLL_ATTEMPTS = 180;

function checkingGate(envLabel: string): OnboardingPoolGate {
  return {
    kind: "checking",
    canContinue: false,
    label: `Checking ${envLabel} runtime`,
    stepStatus: "in_progress",
    errorMessage: null,
  };
}

function gatesEqual(left: OnboardingPoolGate, right: OnboardingPoolGate): boolean {
  return (
    left.kind === right.kind &&
    left.canContinue === right.canContinue &&
    left.label === right.label &&
    left.stepStatus === right.stepStatus &&
    left.errorMessage === right.errorMessage
  );
}
const _ONBOARDING_POOL_GATE_FIELDS = {
  kind: true,
  canContinue: true,
  label: true,
  stepStatus: true,
  errorMessage: true,
} satisfies Record<keyof OnboardingPoolGate, true>;
void _ONBOARDING_POOL_GATE_FIELDS;

function projectPoolGate({
  outcome,
  pythonEnv,
  envLabel,
  attempts,
  bypassAllowed,
  idlePollAttempts,
  warmingPollAttempts,
}: {
  outcome: PoolPollOutcome;
  pythonEnv: PythonEnv;
  envLabel: string;
  attempts: number;
  bypassAllowed: boolean;
  idlePollAttempts: number;
  warmingPollAttempts: number;
}): OnboardingPoolGate {
  if (outcome.kind === "unavailable") {
    if (bypassAllowed || attempts >= idlePollAttempts) {
      return {
        kind: "unavailable",
        canContinue: true,
        label: `Waiting for ${envLabel} runtime`,
        stepStatus: "failed",
        errorMessage: null,
      };
    }
    return checkingGate(envLabel);
  }

  const selected = outcome.state[pythonEnv];
  if (isOnboardingPoolReady(pythonEnv, outcome.state)) {
    return {
      kind: "ready",
      canContinue: true,
      label: `${envLabel} runtime ready`,
      stepStatus: "completed",
      errorMessage: null,
    };
  }

  if (selected.warming > 0 && bypassAllowed) {
    return {
      kind: "retrying",
      canContinue: true,
      label: `Retrying ${envLabel} runtime`,
      stepStatus: "in_progress",
      errorMessage: null,
    };
  }

  if (hasOnboardingPoolError(pythonEnv, outcome.state)) {
    return {
      kind: "failed",
      canContinue: true,
      label: `${envLabel} runtime setup failed`,
      stepStatus: "failed",
      errorMessage: onboardingPoolErrorMessage(envLabel, selected),
    };
  }

  if (selected.warming > 0) {
    if (attempts >= warmingPollAttempts) {
      return {
        kind: "slow",
        canContinue: true,
        label: `Still warming ${envLabel} runtime`,
        stepStatus: "failed",
        errorMessage: null,
      };
    }
    return {
      kind: "warming",
      canContinue: false,
      label: `Warming ${envLabel} runtime`,
      stepStatus: "in_progress",
      errorMessage: null,
    };
  }

  if (bypassAllowed || attempts >= idlePollAttempts) {
    return {
      kind: "unavailable",
      canContinue: true,
      label: `Waiting for ${envLabel} runtime`,
      stepStatus: "failed",
      errorMessage: null,
    };
  }

  return checkingGate(envLabel);
}

/**
 * Poll the selected runtime pool until it becomes ready.
 *
 * A slow or failed pool unlocks "continue anyway" without ending observation.
 * Unsubscribing drops an in-flight result, so switching environments cannot
 * apply a stale response to the new selection.
 */
export function observeOnboardingPool({
  pythonEnv,
  envLabel,
  fetchPoolState,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  idlePollAttempts = DEFAULT_IDLE_POLL_ATTEMPTS,
  warmingPollAttempts = DEFAULT_WARMING_POLL_ATTEMPTS,
  scheduler,
}: ObserveOnboardingPoolOptions): Observable<OnboardingPoolGate> {
  const initialGate = checkingGate(envLabel);

  return defer(() =>
    createPoll<PoolPollOutcome>({
      strategy: "fixed-rate",
      interval$: of(pollIntervalMs),
      wakeups$: of(undefined),
      scheduler,
      fetch: async (signal) => {
        try {
          return { kind: "state", state: await fetchPoolState(signal) };
        } catch (error) {
          return { kind: "unavailable", error };
        }
      },
    }).pipe(
      scan<PoolPollOutcome, PoolPollAccumulator>(
        (accumulator, outcome) => {
          const attempts = accumulator.attempts + 1;
          const gate = projectPoolGate({
            outcome,
            pythonEnv,
            envLabel,
            attempts,
            bypassAllowed: accumulator.bypassAllowed,
            idlePollAttempts,
            warmingPollAttempts,
          });
          return {
            attempts,
            bypassAllowed: accumulator.bypassAllowed || gate.canContinue,
            gate,
          };
        },
        { attempts: 0, bypassAllowed: false, gate: initialGate },
      ),
      map(({ gate }) => gate),
      startWith(initialGate),
      distinctUntilChanged(gatesEqual),
      takeWhile((gate) => gate.kind !== "ready", true),
    ),
  );
}
