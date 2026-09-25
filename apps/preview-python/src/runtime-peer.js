/**
 * Execute only room-accepted entries from RuntimeStateDoc. The connection owns
 * the WASM handle and sync transport; the pool owns interpreter lifetime.
 * publish() must resolve after the room accepts the peer's pending changes.
 * prepareOutputs() uploads blobs and returns canonical output manifests without
 * mutating the peer. This keeps async output preparation behind session fencing.
 */
// Live output bounds: stop in-place updates past this much text per execution
// (large text becomes blobs; the batch still carries everything), and sync live
// changes to peers at most this often, without a storage checkpoint.
const LIVE_STREAM_BYTES = 64 * 1024;
const LIVE_PUBLISH_INTERVAL_MS = 150;

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
  #interruptEpoch = 0;
  #interrupting;
  #publishLive;
  #live;
  #liveTimer;

  constructor({ peer, pool, sessionKey, isCurrent, publish, publishLive, prepareOutputs }) {
    this.#peer = peer;
    this.#pool = pool;
    this.#key = sessionKey;
    this.#current = isCurrent;
    this.#publish = publish;
    this.#publishLive = publishLive;
    this.#prepare = prepareOutputs;
  }

  /**
   * Live stream text while a cell runs (advisory). One record per stream run
   * is replaced in place; the final batch replaces every live record before
   * the execution becomes terminal, so room state ends identical to batch mode.
   */
  #onLive(executionId, event) {
    const live = this.#live;
    if (!live || live.executionId !== executionId || live.closed) return;
    live.chain = live.chain.then(async () => {
      if (
        live.closed ||
        live.stopped ||
        this.#closed ||
        !this.#current(this.#peer.get_runtime_state())
      )
        return;
      if (event.type === "live_stopped") {
        live.stopped = true;
        return;
      }
      if (event.type === "boundary") {
        live.record = null;
        return;
      }
      live.bytes += event.text.length;
      if (live.bytes > LIVE_STREAM_BYTES) {
        live.stopped = true;
        return;
      }
      const record =
        live.record?.name === event.name
          ? live.record
          : { name: event.name, text: "", outputId: null };
      record.text += event.text;
      const [manifest] = await this.#prepare([
        { output_type: "stream", name: record.name, text: record.text },
      ]);
      if (live.closed) return;
      if (record.outputId) {
        manifest.output_id = record.outputId;
        this.#peer.replace_output_json(executionId, record.outputId, JSON.stringify(manifest));
      } else {
        record.outputId = this.#peer.append_output_json(executionId, JSON.stringify(manifest));
      }
      live.record = record;
      live.written = true;
      this.#scheduleLivePublish();
    });
    live.chain = live.chain.catch(() => {
      // Live output is advisory; the final batch is still published.
      live.stopped = true;
    });
  }

  #scheduleLivePublish() {
    if (this.#liveTimer || !this.#publishLive) return;
    this.#liveTimer = setTimeout(() => {
      this.#liveTimer = undefined;
      if (this.#live && !this.#live.closed) void this.#publishLive().catch(() => undefined);
    }, LIVE_PUBLISH_INTERVAL_MS);
  }

  async #closeLive() {
    const live = this.#live;
    if (!live) return false;
    live.closed = true;
    clearTimeout(this.#liveTimer);
    this.#liveTimer = undefined;
    await live.chain;
    this.#live = undefined;
    return live.written;
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

  /**
   * Interrupt cancels intent that has not started, as desktop kernels do. The
   * running cell is interrupted by the provider; its result arrives through
   * drain. Work queued after this call is a new explicit action and runs.
   */
  interrupt() {
    this.#interrupting ??= this.#interrupt().finally(() => {
      this.#interrupting = undefined;
    });
    return this.#interrupting;
  }

  async #interrupt() {
    this.#assertCurrent();
    this.#interruptEpoch++;
    // Include room-accepted work that has not reached this peer yet.
    await this.#publish();
    this.#assertCurrent();
    let cancelled = false;
    for (const [executionId, execution] of Object.entries(
      this.#peer.get_runtime_state().executions ?? {},
    )) {
      if (execution.status === "queued") {
        this.#peer.set_execution_cancelled(executionId);
        cancelled = true;
      }
    }
    if (!cancelled) return;
    this.#peer.refresh_execution_queue();
    await this.#publish();
  }

  async #drain() {
    while (!this.#closed && !this.#halted) {
      this.#assertCurrent();
      // Never claim an entry while Interrupt is still cancelling pre-click work.
      if (this.#interrupting) await this.#interrupting.catch(() => undefined);
      this.#assertCurrent();
      const epoch = this.#interruptEpoch;
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
      this.#peer.refresh_execution_queue();
      await this.#publish();
      this.#assertCurrent();
      if (epoch !== this.#interruptEpoch) {
        // Interrupt arrived after this entry was claimed but before Python saw
        // it. Do not execute stale intent. A runtime peer may not move running
        // back to cancelled, so finish it as interrupted without running.
        this.#peer.append_output_json(
          executionId,
          JSON.stringify({
            output_type: "error",
            output_id: crypto.randomUUID(),
            ename: "KeyboardInterrupt",
            evalue: "Interrupted before this cell started",
            traceback: { inline: "[]" },
          }),
        );
        this.#peer.set_execution_done(executionId, false);
        this.#peer.refresh_execution_queue();
        await this.#publish();
        continue;
      }
      let result;
      if (this.#publishLive)
        this.#live = {
          executionId,
          chain: Promise.resolve(),
          record: null,
          bytes: 0,
          written: false,
          stopped: false,
          closed: false,
        };
      try {
        result = await this.#pool.execute(
          this.#key,
          {
            execution_id: executionId,
            cell_id: accepted.cell_id,
            source: accepted.source,
          },
          this.#publishLive ? { onLive: (event) => this.#onLive(executionId, event) } : undefined,
        );
      } catch (error) {
        await this.#closeLive();
        this.#assertCurrent();
        this.#peer.append_output_json(
          executionId,
          JSON.stringify({
            output_type: "error",
            output_id: crypto.randomUUID(),
            ename: "RuntimeError",
            evalue: String(error),
            traceback: { inline: "[]" },
          }),
        );
        this.#peer.set_execution_done(executionId, false);
        this.#peer.refresh_execution_queue();
        this.#peer.set_kernel_error("Python session ended; restart to continue");
        await this.#publish();
        throw error;
      }
      const wroteLive = await this.#closeLive();
      this.#assertCurrent();
      const manifests = await this.#prepare(result.outputs);
      this.#assertCurrent();
      // The batch is authoritative: drop live records, then write it in order.
      if (wroteLive) this.#peer.clear_execution_outputs(executionId);
      this.#peer.set_execution_count(executionId, result.execution_count);
      let clearBeforeNextOutput = false;
      for (const manifest of manifests) {
        if (manifest.output_type === "clear_output") {
          if (manifest.wait) clearBeforeNextOutput = true;
          else {
            this.#peer.clear_execution_outputs(executionId);
            clearBeforeNextOutput = false;
          }
          continue;
        }
        if (clearBeforeNextOutput) {
          this.#peer.clear_execution_outputs(executionId);
          clearBeforeNextOutput = false;
        }
        if (manifest.output_type === "update_display_data") {
          this.#peer.update_display_data_json(
            manifest.transient.display_id,
            JSON.stringify(manifest.data),
            JSON.stringify(manifest.metadata),
          );
        } else this.#peer.append_output_json(executionId, JSON.stringify(manifest));
      }
      this.#peer.set_execution_done(executionId, result.success);
      this.#peer.refresh_execution_queue();
      await this.#publish();
      // Abort already queued work after a Python error, but keep the interpreter
      // usable for a later explicit execution. Never replay the failed request.
      if (!result.success) {
        this.#assertCurrent();
        for (const [queuedId, queued] of Object.entries(
          this.#peer.get_runtime_state().executions ?? {},
        )) {
          if (queued.status === "queued") this.#peer.set_execution_cancelled(queuedId);
        }
        this.#peer.refresh_execution_queue();
        await this.#publish();
        return;
      }
    }
  }

  async close() {
    this.#closed = true;
    await this.#pool.release(this.#key);
  }
}
