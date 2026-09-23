/** Clean runtimes are assigned once; released tenant state is always destroyed. */
export class SessionPool {
  #create;
  #sessions = new Map();
  #warm = [];
  #closed = false;
  #clock;
  #maxSessions;
  #warmCount;
  #idleMs;
  #runtimeCount = 0;

  constructor({ create, maxSessions = 4, warmCount = 1, idleMs = 15 * 60_000, clock = Date.now }) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error("Invalid session limit");
    if (!Number.isInteger(warmCount) || warmCount < 0 || warmCount > maxSessions)
      throw new Error("Invalid warm pool size");
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Invalid idle timeout");
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
          let disposed = false;
          return {
            runtime: {
              info: runtime.info,
              execute: (execution) => runtime.execute(execution),
              dispose: async () => {
                if (disposed) return;
                disposed = true;
                try {
                  await runtime.dispose();
                } finally {
                  this.#runtimeCount--;
                }
              },
            },
          };
        },
        (error) => {
          this.#runtimeCount--;
          return { error };
        },
      );
  }

  warm() {
    if (this.#closed) return;
    while (this.#warm.length < this.#warmCount && this.#runtimeCount < this.#maxSessions) {
      this.#warm.push(this.#fresh());
    }
  }

  async prewarm() {
    this.warm();
    const results = await Promise.all(this.#warm);
    for (const result of results) if (result.error) throw result.error;
    return results.map((result) => result.runtime.info);
  }

  async open(key) {
    if (this.#closed) throw new Error("Provider is closed");
    if (typeof key !== "string" || !key) throw new Error("Missing session identity");
    let session = this.#sessions.get(key);
    if (session) return session.ready;
    if (this.#sessions.size >= this.#maxSessions)
      throw new Error("Preview Python capacity reached");
    const candidate = this.#warm.shift() ?? this.#fresh();
    session = {
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
        throw error;
      }
      if (this.#sessions.get(key) !== session || this.#closed) {
        await runtime.dispose();
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
    if (expected.runtime) await expected.runtime.dispose();
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
