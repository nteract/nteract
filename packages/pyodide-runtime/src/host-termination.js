import { defer, firstValueFrom, ReplaySubject, share } from "rxjs";

/** Control methods contain no guest dispatch; only the host can invalidate entry. */
export function retryableTermination(terminate) {
  const termination$ = defer(terminate).pipe(
    share({
      connector: () => new ReplaySubject(1),
      resetOnError: true,
      resetOnComplete: false,
      resetOnRefCountZero: false,
    }),
  );
  return () => firstValueFrom(termination$);
}

export async function terminateLoadedPython(stub) {
  const control = () =>
    stub.getEntrypoint("RuntimeControl", {
      limits: { cpuMs: 10, subRequests: 0 },
    });
  try {
    await control().terminate();
  } catch {
    // Neither a CPU-looking guest error nor this call returning proves death.
  }
  let probeError;
  try {
    await control().isAlive();
  } catch (error) {
    probeError = error;
  }
  // celld rejects invalidated RPC entry before entering JavaScript. Guest
  // exceptions are wrapped as "rejected: ..." and must not match this marker.
  if (
    probeError?.message !==
    "Python runtime invalidated after execution termination; recreate the worker"
  ) {
    throw new Error("Python host did not confirm session invalidation", { cause: probeError });
  }
}
