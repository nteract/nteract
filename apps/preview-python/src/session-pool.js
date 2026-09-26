/** Clean runtimes are assigned once; released tenant state is always destroyed. */
export class SessionPool {
  #create;
  #sessions = new Map();
  #warm = [];
  #warmQuarantined = false;
  #closed = false;
  #clock;
  #maxSessions;
  #warmCount;
  #idleMs;
  #runtimeCount = 0;
  #ownerCounts = new Map();
  #maxSessionsPerOwner;

  constructor({
    create,
    maxSessions = 4,
    warmCount = 1,
    idleMs = 15 * 60_000,
    clock = Date.now,
    maxSessionsPerOwner = maxSessions,
  }) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("Invalid session limit");
    if (!Number.isInteger(warmCount) || warmCount < 0 || warmCount > maxSessions)
      throw new Error("Invalid warm pool size");
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Invalid idle timeout");
    if (
      !Number.isInteger(maxSessionsPerOwner) ||
      maxSessionsPerOwner < 1 ||
      maxSessionsPerOwner > maxSessions
    )
      throw new Error("Invalid owner session limit");
    this.#maxSessionsPerOwner = maxSessionsPerOwner;
    this.#create = create;
    this.#clock = clock;
    this.#maxSessions = maxSessions;
    this.#warmCount = warmCount;
    this.#idleMs = idleMs;
  }

  #fresh() {
    // Settled failures are retained for admission to report, never unhandled.
    if (this.#runtimeCount >= this.#maxSessions)
      throw new Error("Python (sandboxed) capacity reached");
    this.#runtimeCount++;
    return Promise.resolve()
      .then(this.#create)
      .then(
        (runtime) => {
          let disposal;
          return {
            runtime: {
              info: runtime.info,
              execute: (execution, options) => runtime.execute(execution, options),
              install: (payload) => runtime.install(payload),
              dispose: () =>
                (disposal ??= Promise.resolve()
                  .then(async () => {
                    await runtime.dispose();
                    this.#runtimeCount--;
                  })
                  .catch((error) => {
                    disposal = undefined;
                    throw error;
                  })),
            },
          };
        },
        (error) => {
          // Trusted factory reports uncertain host cleanup; quarantine the
          // reservation rather than admitting beyond the deployment limit.
          if (error?.runtimeRetained !== true) this.#runtimeCount--;
          return { error };
        },
      );
  }

  warm() {
    if (this.#closed || this.#warmQuarantined) return;
    while (this.#warm.length < this.#warmCount && this.#runtimeCount < this.#maxSessions) {
      const candidate = this.#fresh();
      this.#warm.push(candidate);
      void candidate.then((result) => {
        if (result.error) {
          if (result.error.runtimeRetained === true) this.#warmQuarantined = true;
          const index = this.#warm.indexOf(candidate);
          if (index !== -1) this.#warm.splice(index, 1);
          // A normal startup failure can retry on later discovery. Unconfirmed
          // destruction stops background warming until provider restart, so
          // polling cannot quarantine every deployment slot after a host fault.
        }
      });
    }
  }

  async prewarm() {
    this.warm();
    const results = await Promise.all(this.#warm);
    for (const result of results) if (result.error) throw result.error;
    return results.map((result) => result.runtime.info);
  }

  has(key) {
    const session = this.#sessions.get(key);
    return !this.#closed && !!session && !session.cancelled;
  }

  async open(key, owner = key, { resumeOnly = false } = {}) {
    if (this.#closed) throw new Error("Provider is closed");
    if (typeof key !== "string" || !key) throw new Error("Missing session identity");
    if (typeof owner !== "string" || !owner) throw new Error("Missing session owner");
    let session = this.#sessions.get(key);
    if (session) {
      if (session.owner !== owner) throw new Error("Session owner mismatch");
      if (session.cancelled) throw new Error("Session is being released");
      return session.ready;
    }
    if (resumeOnly) throw new Error("Session expired; allocate a new runtime session");
    const owned = this.#ownerCounts.get(owner) ?? 0;
    if (owned >= this.#maxSessionsPerOwner)
      throw new Error(
        "Your Python session limit was reached. Stop another notebook session and try again.",
      );
    if (this.#sessions.size >= this.#maxSessions)
      throw new Error("Python (sandboxed) capacity reached");
    const warmCandidate = this.#warm.shift();
    const candidate = warmCandidate ?? this.#fresh();
    this.#ownerCounts.set(owner, owned + 1);
    let reserved = true;
    const releaseOwner = () => {
      if (!reserved) return;
      reserved = false;
      const remaining = this.#ownerCounts.get(owner) - 1;
      if (remaining) this.#ownerCounts.set(owner, remaining);
      else this.#ownerCounts.delete(owner);
    };
    session = {
      owner,
      releaseOwner,
      runtime: null,
      ready: null,
      lastUsed: this.#clock(),
      busy: false,
      executions: new Set(),
      packageOperations: new Set(),
      installed: [],
      included: [],
      packageAbort: null,
      cancelled: false,
      cleanupComplete: false,
      closing: undefined,
    };
    this.#sessions.set(key, session);
    session.ready = candidate.then(async ({ runtime, error }) => {
      if (error) {
        if (warmCandidate || error?.runtimeRetained !== true) {
          releaseOwner();
          session.cleanupComplete = true;
          if (this.#sessions.get(key) === session) this.#sessions.delete(key);
        }
        throw error;
      }
      session.runtime = runtime;
      session.installed = runtime.info.installed ?? [];
      session.included = runtime.info.included ?? [];
      if (session.cancelled || this.#sessions.get(key) !== session || this.#closed) {
        await runtime.dispose();
        releaseOwner();
        session.cleanupComplete = true;
        throw new Error("Session expired during allocation");
      }
      session.lastUsed = this.#clock();
      this.warm();
      return runtime.info;
    });
    return session.ready;
  }

  async execute(key, execution, options) {
    const session = this.#sessions.get(key);
    if (!session) throw new Error("Session expired; allocate a new runtime session");
    await session.ready;
    if (this.#sessions.get(key) !== session || session.cancelled)
      throw new Error("Session was replaced");
    if (session.busy) throw new Error("Session is already executing");
    if (session.packageDamaged) throw new Error("Package state is uncertain; restart Python");
    if (session.executions.has(execution.execution_id))
      throw new Error("Execution was already accepted");
    // Bound replay bookkeeping; a new generation is explicit rather than
    // forgetting IDs and accidentally replaying side effects after reconnect.
    if (session.executions.size >= 10_000)
      throw new Error("Session execution limit reached; restart");
    session.executions.add(execution.execution_id);
    session.busy = true;
    try {
      const result = await session.runtime.execute(execution, options);
      if (this.#sessions.get(key) !== session || session.cancelled)
        throw new Error("Discarded output from expired session");
      return result;
    } catch (error) {
      await this.release(key, session);
      throw error;
    } finally {
      session.busy = false;
      session.lastUsed = this.#clock();
    }
  }

  async release(key, expected = this.#sessions.get(key)) {
    if (!expected || this.#sessions.get(key) !== expected) return;
    expected.cancelled = true;
    expected.packageAbort?.abort();
    expected.closing ??= (async () => {
      if (!expected.runtime) {
        try {
          await expected.ready;
        } catch (error) {
          if (!expected.cleanupComplete && !expected.runtime) throw error;
        }
      }
      if (!expected.cleanupComplete) {
        await expected.runtime.dispose();
        expected.releaseOwner();
        expected.cleanupComplete = true;
      }
      if (this.#sessions.get(key) === expected) this.#sessions.delete(key);
    })().finally(() => {
      expected.closing = undefined;
    });
    return expected.closing;
  }

  async packages(key, operationId, operation) {
    const session = this.#sessions.get(key);
    if (!session) throw new Error("Session expired; start a new Python session");
    await session.ready;
    if (this.#sessions.get(key) !== session || session.cancelled)
      throw new Error("Session was replaced");
    if (session.busy) throw new Error("Python is busy. Wait for the current operation and retry.");
    if (session.packageDamaged) throw new Error("Package state is uncertain; restart Python");
    if (
      typeof operationId !== "string" ||
      !operationId ||
      operationId.length > 128 ||
      session.packageOperations.has(operationId)
    )
      throw new Error("Package operation was already accepted or is invalid");
    if (session.packageOperations.size >= 1000)
      throw new Error("Package operation limit reached; restart Python");
    session.packageOperations.add(operationId);
    session.busy = true;
    const abort = new AbortController();
    session.packageAbort = abort;
    try {
      const result = await operation({
        runtime: session.runtime,
        installed: session.installed,
        signal: abort.signal,
      });
      if (session.cancelled || this.#sessions.get(key) !== session)
        throw new Error("Package result belongs to an expired session");
      if (result.status === "ready") session.installed = result.installed;
      if (result.needs_restart) session.packageDamaged = true;
      return result;
    } finally {
      session.busy = false;
      session.packageAbort = null;
      session.lastUsed = this.#clock();
    }
  }

  packageInventory(key) {
    const session = this.#sessions.get(key);
    if (!session?.runtime || session.cancelled) throw new Error("Python session is unavailable");
    if (session.packageAbort || session.packageDamaged)
      throw new Error("Package state is uncertain; restart Python");
    return { installed: session.installed, included: session.included };
  }

  inspect(key) {
    const session = this.#sessions.get(key);
    if (!session) return { phase: "absent" };
    return {
      phase: session.cancelled ? "releasing" : session.runtime ? "ready" : "allocating",
      busy: session.busy,
      lastUsed: session.lastUsed,
    };
  }

  async expire() {
    const now = this.#clock();
    const pending = [];
    for (const [key, session] of this.#sessions) {
      if (session.cancelled || (!session.busy && now - session.lastUsed >= this.#idleMs))
        pending.push(this.release(key, session));
    }
    const results = await Promise.allSettled(pending);
    this.warm();
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Session cleanup failed",
      );
  }

  async close() {
    this.#closed = true;
    const results = await Promise.allSettled([
      ...Array.from(this.#sessions.keys(), (key) => this.release(key)),
      ...this.#warm.splice(0).map(async (pending) => {
        const { runtime } = await pending;
        await runtime?.dispose();
      }),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Session cleanup failed",
      );
  }
}
