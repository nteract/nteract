/**
 * Execute only room-accepted entries from RuntimeStateDoc. The connection owns
 * the WASM handle and sync transport; the pool owns interpreter lifetime.
 * publish() must resolve after the room accepts the peer's pending changes.
 * prepareOutputs() uploads blobs and returns canonical output manifests without
 * mutating the peer. This keeps async output preparation behind session fencing.
 */
export class PythonRuntimePeer {
  #peer;
  #pool;
  #key;
  #current;
  #publish;
  #prepare;
  #closed = false;
  #halted = false;
  #draining;

  constructor({ peer, pool, sessionKey, isCurrent, publish, prepareOutputs }) {
    this.#peer = peer;
    this.#pool = pool;
    this.#key = sessionKey;
    this.#current = isCurrent;
    this.#publish = publish;
    this.#prepare = prepareOutputs;
  }

  #assertCurrent() {
    if (this.#closed || !this.#current(this.#peer.get_runtime_state())) {
      throw new Error("Preview Python runtime peer session expired");
    }
  }

  drain() {
    this.#draining ??= this.#drain()
      .catch((error) => {
        this.#halted = true;
        throw error;
      })
      .finally(() => {
        this.#draining = undefined;
      });
    return this.#draining;
  }

  async #drain() {
    while (!this.#closed && !this.#halted) {
      this.#assertCurrent();
      const entry = Object.entries(this.#peer.get_runtime_state().executions ?? {})
        .filter(([, execution]) => execution.status === "queued")
        .sort(
          ([idA, a], [idB, b]) =>
            (a.seq ?? Infinity) - (b.seq ?? Infinity) || idA.localeCompare(idB),
        )[0];
      if (!entry) return;
      const [executionId, accepted] = entry;
      if (
        typeof accepted.source !== "string" ||
        !accepted.cell_id ||
        !Number.isSafeInteger(accepted.seq)
      ) {
        throw new Error("Room execution lacks synced-cell provenance");
      }
      // Publish running before invoking Python. A reconnect must not rerun
      // entries that may already have produced side effects.
      this.#peer.set_execution_running(executionId);
      await this.#publish();
      this.#assertCurrent();
      let result;
      try {
        result = await this.#pool.execute(this.#key, {
          execution_id: executionId,
          source: accepted.source,
        });
      } catch (error) {
        this.#assertCurrent();
        this.#peer.append_output_json(
          executionId,
          JSON.stringify({
            output_type: "error",
            output_id: crypto.randomUUID(),
            ename: "RuntimeError",
            evalue: String(error),
            traceback: [],
          }),
        );
        this.#peer.set_execution_done(executionId, false);
        this.#peer.set_kernel_error("Python session ended; restart to continue");
        await this.#publish();
        throw error;
      }
      this.#assertCurrent();
      const manifests = await this.#prepare(result.outputs);
      this.#assertCurrent();
      this.#peer.set_execution_count(executionId, result.execution_count);
      for (const manifest of manifests) {
        this.#peer.append_output_json(executionId, JSON.stringify(manifest));
      }
      this.#peer.set_execution_done(executionId, result.success);
      await this.#publish();
      // Stop the queue on Python errors; the room coordinator owns cancellation
      // of subsequent accepted requests and any future retry decision.
      if (!result.success) {
        this.#halted = true;
        return;
      }
    }
  }

  async close() {
    this.#closed = true;
    await this.#pool.release(this.#key);
  }
}
