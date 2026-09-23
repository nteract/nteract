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
    if (this.#runtimeCount >= this.#maxSessions) throw new Error("Preview Python capacity reached");
    this.#runtimeCount++;
    return Promise.resolve()
      .then(this.#create)
      .then(
        (runtime) => {
          let disposal;
          return {
            runtime: {
              info: runtime.info,
              execute: (execution) => runtime.execute(execution),
              dispose: () =>
                (disposal ??= Promise.resolve().then(async () => {
                  await runtime.dispose();
                  this.#runtimeCount--;
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

  async open(key, owner = key) {
    if (this.#closed) throw new Error("Provider is closed");
    if (typeof key !== "string" || !key) throw new Error("Missing session identity");
    if (typeof owner !== "string" || !owner) throw new Error("Missing session owner");
    let session = this.#sessions.get(key);
    if (session) {
      if (session.owner !== owner) throw new Error("Session owner mismatch");
      return session.ready;
    }
    const owned = this.#ownerCounts.get(owner) ?? 0;
    if (owned >= this.#maxSessionsPerOwner)
      throw new Error(
        "Your Preview Python session limit was reached; stop another notebook session",
      );
    if (this.#sessions.size >= this.#maxSessions)
      throw new Error("Preview Python capacity reached");
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
    };
    this.#sessions.set(key, session);
    session.ready = candidate.then(async ({ runtime, error }) => {
      if (error) {
        if (this.#sessions.get(key) === session) this.#sessions.delete(key);
        if (warmCandidate || error?.runtimeRetained !== true) releaseOwner();
        throw error;
      }
      if (this.#sessions.get(key) !== session || this.#closed) {
        await runtime.dispose();
        releaseOwner();
        throw new Error("Session expired during allocation");
      }
      session.runtime = runtime;
      session.lastUsed = this.#clock();
      this.warm();
      return runtime.info;
    });
    return session.ready;
  }

  async execute(key, execution) {
    const session = this.#sessions.get(key);
    if (!session) throw new Error("Session expired; allocate a new runtime session");
    await session.ready;
    if (this.#sessions.get(key) !== session) throw new Error("Session was replaced");
    if (session.busy) throw new Error("Session is already executing");
    if (session.executions.has(execution.execution_id))
      throw new Error("Execution was already accepted");
    // Bound replay bookkeeping; a new generation is explicit rather than
    // forgetting IDs and accidentally replaying side effects after reconnect.
    if (session.executions.size >= 10_000)
      throw new Error("Session execution limit reached; restart");
    session.executions.add(execution.execution_id);
    session.busy = true;
    try {
      const result = await session.runtime.execute(execution);
      if (this.#sessions.get(key) !== session)
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
    this.#sessions.delete(key);
    // A pending allocation disposes itself when it notices removal.
    if (expected.runtime) {
      await expected.runtime.dispose();
      expected.releaseOwner();
    }
  }

  async expire() {
    const now = this.#clock();
    for (const [key, session] of this.#sessions) {
      if (!session.busy && now - session.lastUsed >= this.#idleMs) await this.release(key, session);
    }
    this.warm();
  }

  async close() {
    this.#closed = true;
    for (const key of this.#sessions.keys()) await this.release(key);
    await Promise.all(
      this.#warm.splice(0).map(async (pending) => {
        const { runtime } = await pending;
        await runtime?.dispose();
      }),
    );
  }
}
