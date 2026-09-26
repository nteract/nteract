import { EMPTY, Subject, catchError, concatMap, defer, ignoreElements, lastValueFrom } from "rxjs";
import { liveOutputBatches } from "./live-output-stream.js";

/**
 * Execute only room-accepted entries from RuntimeStateDoc. The connection owns
 * the WASM handle and sync transport; the pool owns interpreter lifetime.
 * publish() must resolve after the room accepts the peer's pending changes.
 * prepareOutputs() uploads blobs and returns canonical output manifests without
 * mutating the peer. This keeps async output preparation behind session fencing.
 */
// Live output bounds. Each live record stays below the 1 KiB inline-content
// threshold so live updates never create blobs; records, document writes and
// buffered events are capped per execution (the batch still carries
// everything). Live changes reach peers at most every flush interval, through
// sync only, without a storage checkpoint.
const LIVE_RECORD_BYTES = 960;
const LIVE_MAX_RECORDS = 48;
const LIVE_MAX_WRITES = 400;
const utf8 = new TextEncoder();

function utf8Length(text) {
  return utf8.encode(text).length;
}

/** Split `text` so the first part is at most `maxBytes` UTF-8 bytes. */
function splitUtf8(text, maxBytes) {
  if (maxBytes <= 0) return ["", text];
  let bytes = 0;
  let index = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += char.length;
  }
  return [text.slice(0, index), text.slice(index)];
}

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
  #scheduler;

  constructor({
    peer,
    pool,
    sessionKey,
    isCurrent,
    publish,
    publishLive,
    prepareOutputs,
    scheduler,
  }) {
    this.#peer = peer;
    this.#pool = pool;
    this.#key = sessionKey;
    this.#current = isCurrent;
    this.#publish = publish;
    this.#publishLive = publishLive;
    this.#prepare = prepareOutputs;
    this.#scheduler = scheduler;
  }

  /**
   * Live stream text while a cell runs (advisory). Events only update an
   * in-memory buffer; the document is written on a timer, each live record at
   * most once per flush. Records stay below the inline-content threshold (no
   * blobs) and are bounded per execution. On success the validated batch
   * replaces every live record before the execution becomes terminal; if the
   * session fails mid-cell, the partial live output stays with the error.
   */
  #onLive(executionId, event) {
    const live = this.#live;
    if (!live || live.executionId !== executionId || live.closed || live.stopped) return;
    live.events.next(event);
  }

  #startLive(executionId) {
    const live = {
      executionId,
      events: new Subject(),
      record: null,
      records: 0,
      writes: 0,
      clearBeforeNext: false,
      written: false,
      stopped: false,
      closed: false,
    };
    live.completion = lastValueFrom(
      liveOutputBatches(live.events.asObservable(), { scheduler: this.#scheduler }).pipe(
        concatMap((batch) => {
          if (batch.stopped) {
            live.stopped = true;
            return EMPTY;
          }
          return defer(() => this.#flushLive(live, batch.events)).pipe(
            catchError(() => {
              // Live output is advisory; the final batch is still published.
              live.stopped = true;
              live.events.complete();
              return EMPTY;
            }),
          );
        }),
        ignoreElements(),
      ),
      { defaultValue: undefined },
    );
    this.#live = live;
  }

  #clearLive(live) {
    this.#peer.clear_execution_outputs(live.executionId);
    live.record = null;
    live.records = 0;
    live.written = true;
    live.writes++;
  }

  async #flushLive(live, pending) {
    if (live.closed || live.stopped || this.#closed || !pending.length) return;
    if (!this.#current(this.#peer.get_runtime_state())) {
      live.stopped = true;
      return;
    }
    const touched = new Set();
    for (const op of pending) {
      if (op.type === "boundary") {
        live.record = null;
        continue;
      }
      if (op.type === "clear") {
        if (op.wait) live.clearBeforeNext = true;
        else {
          touched.clear();
          this.#clearLive(live);
        }
        continue;
      }
      if (live.clearBeforeNext) {
        live.clearBeforeNext = false;
        touched.clear();
        this.#clearLive(live);
      }
      let text = op.text;
      while (text && !live.stopped) {
        let record = live.record?.name === op.name ? live.record : null;
        const used = record ? utf8Length(record.text) : 0;
        if (!record || used >= LIVE_RECORD_BYTES) {
          if (live.records >= LIVE_MAX_RECORDS) {
            live.stopped = true;
            break;
          }
          record = { name: op.name, text: "", outputId: null };
          live.records++;
        }
        const [piece, rest] = splitUtf8(text, LIVE_RECORD_BYTES - utf8Length(record.text));
        if (!piece) {
          // The next character does not fit; start a new record.
          live.record = null;
          continue;
        }
        record.text += piece;
        text = rest;
        live.record = record;
        touched.add(record);
      }
    }
    for (const record of touched) {
      if (live.writes >= LIVE_MAX_WRITES) {
        live.stopped = true;
        break;
      }
      const [manifest] = await this.#prepare([
        { output_type: "stream", name: record.name, text: record.text },
      ]);
      if (live.closed || this.#closed || !this.#current(this.#peer.get_runtime_state())) return;
      if (record.outputId) {
        manifest.output_id = record.outputId;
        this.#peer.replace_output_json(live.executionId, record.outputId, JSON.stringify(manifest));
      } else {
        record.outputId = this.#peer.append_output_json(live.executionId, JSON.stringify(manifest));
      }
      live.written = true;
      live.writes++;
    }
    if (live.written && this.#publishLive) await this.#publishLive();
  }

  async #closeLive() {
    const live = this.#live;
    if (!live) return false;
    live.closed = true;
    live.events.complete();
    // Completing the source releases its scheduler; concatMap still waits for
    // the active write before the authoritative batch can replace live output.
    await live.completion;
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
      if (this.#publishLive) this.#startLive(executionId);
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
    await this.#closeLive();
    await this.#pool.release(this.#key);
  }
}
