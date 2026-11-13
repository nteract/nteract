import * as A from "@automerge/automerge";
import { cbor, documentIdToBinary } from "@automerge/automerge-repo";
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree";
import { Subject, concatMap, defer, EMPTY, catchError } from "rxjs";

export const hostTreeOf = (id) => sedimentreeId(documentIdToBinary(id));

export function handleLifecycle(state, event) {
  if (state === "open" && event === "drain") return "draining";
  if (state === "draining" && event === "finish") return "closed";
  return state;
}

/** Only the handle surface used by the Page worker; SyncHost owns all live history. */
export class HostRepo {
  #handles = new Map();
  #state = "open";
  #shutdown;

  constructor(host) {
    this.host = host;
  }

  assertOpen() {
    if (this.#state !== "open") throw Error("HostRepo is shut down");
  }

  #handle(id) {
    this.assertOpen();
    const tree = hostTreeOf(id);
    if (!this.#handles.has(tree)) this.#handles.set(tree, new HostHandle(this, id));
    return this.#handles.get(tree);
  }

  async find(id, { signal } = {}) {
    signal?.throwIfAborted();
    const handle = this.#handle(id);
    const loaded = handle.run(async () => {
      if (!(await this.host.document(handle.tree))) throw Error(`Unknown document ${id}`);
      return handle;
    });
    if (!signal) return loaded;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      loaded.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  import(bytes, { docId }) {
    const handle = this.#handle(docId);
    // Own the input before it waits behind another write.
    const saved = bytes.slice();
    return handle.run(async () => {
      const imported = A.load(saved);
      try {
        await this.host.applyChanges(handle.tree, A.getAllChanges(imported));
        return handle;
      } finally {
        A.free(imported);
      }
    });
  }

  flush(ids) {
    this.assertOpen();
    return Promise.all(
      ids.map((id) => {
        const handle = this.#handle(id);
        return handle.run(() => this.host.durable(handle.tree));
      }),
    );
  }

  /** Remove document `id`. A handle held from before stays closed; once the
   * removal finishes, the next find or import of `id` gets a new handle, so a
   * document that is deleted can be made again under the same id. */
  async delete(id) {
    const handle = this.#handle(id);
    await handle.close(() => this.host.remove(hostTreeOf(id)));
    if (this.#handles.get(handle.tree) === handle) this.#handles.delete(handle.tree);
  }

  shutdown() {
    if (this.#shutdown) return this.#shutdown;
    this.#state = handleLifecycle(this.#state, "drain");
    this.#shutdown = (async () => {
      await Promise.all([...this.#handles.values()].map((handle) => handle.close()));
      await this.host.close();
      this.#state = handleLifecycle(this.#state, "finish");
    })();
    return this.#shutdown;
  }
}

export class HostHandle {
  #state = "open";
  #work = new Subject();
  #listeners = new Map();
  #close;

  constructor(repo, documentId) {
    this.repo = repo;
    this.documentId = documentId;
    this.tree = hostTreeOf(documentId);
    this.#work
      .pipe(
        concatMap(({ work, resolve, reject }) =>
          defer(async () => {
            resolve(await work());
          }).pipe(
            catchError((error) => {
              reject(error);
              return EMPTY;
            }),
          ),
        ),
      )
      .subscribe();
  }

  #assertOpen() {
    this.repo.assertOpen();
    if (this.#state !== "open") throw Error(`Document ${this.documentId} is deleted`);
  }

  #enqueue(work) {
    return new Promise((resolve, reject) => this.#work.next({ work, resolve, reject }));
  }

  run(work) {
    this.#assertOpen();
    return this.#enqueue(work);
  }

  doc() {
    this.#assertOpen();
    const doc = this.repo.host.doc(this.tree);
    if (!doc) throw Error(`Document ${this.documentId} is not loaded`);
    return doc;
  }

  update(fn, { internal = false } = {}) {
    return this.run(async () => {
      const host = this.repo.host;
      try {
        // Build only after earlier queued bytes are committed, so read-modify-write
        // callbacks observe their effects instead of authoring a concurrent edit.
        await host.durable(this.tree);
      } catch (cause) {
        if (cause.code === "pending_retry_refused") throw cause;
        throw Object.assign(
          new Error("Earlier pending changes could not be persisted; retry this call", { cause }),
          {
            code: "pending_retry_failed",
            queued: false,
          },
        );
      }
      const base = await host.document(this.tree);
      const actor =
        host.hostActorPrefix &&
        host.hostActorPrefix + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const clone = A.clone(base, actor ? { actor } : undefined);
      let candidate = clone;
      let changes;
      try {
        candidate = fn(clone);
        if (candidate?.then) throw Error("HostHandle.update requires a synchronous callback");
        if (A.getMissingDeps(candidate).length)
          throw Error("Recorded edit dependencies are unavailable");
        // Journal replay must preserve the original actors and hashes, not re-author edits.
        changes = A.getChanges(base, candidate);
      } finally {
        A.free(clone);
      }
      try {
        return await host.applyChanges(this.tree, changes, { fenceExempt: internal === true });
      } catch (error) {
        if (!error.queued) throw error;
        // This callback's exact bytes are pending. Confirm them, never re-run fn.
        // A prerequisite pending_retry_failed belongs to an earlier call instead.
        try {
          await host.durable(this.tree);
        } catch (cause) {
          if (cause.code === "pending_retry_refused") throw cause;
          throw error;
        }
        return { heads: A.getHeads(host.doc(this.tree)), changes };
      }
    });
  }

  change(fn, opts = {}) {
    return this.update((doc) => A.change(doc, opts, fn));
  }

  on(name, listener) {
    this.#assertOpen();
    if (!["change", "heads-changed", "ephemeral-message"].includes(name))
      throw Error(`Unsupported handle event ${name}`);
    const event = name === "ephemeral-message" ? "ephemeral" : name;
    if (!this.#listeners.has(name)) this.#listeners.set(name, new Map());
    const listeners = this.#listeners.get(name);
    if (listeners.has(listener)) return this;
    const forward = (payload) => {
      if (payload.id !== this.tree || this.#state !== "open") return;
      listener(
        name === "ephemeral-message"
          ? {
              handle: this,
              senderId: payload.senderId,
              message: cbor.decode(payload.message.payload),
            }
          : { handle: this, ...payload },
      );
    };
    listeners.set(listener, forward);
    this.repo.host.on(event, forward);
    return this;
  }

  off(name, listener) {
    const listeners = this.#listeners.get(name);
    const forward = listeners?.get(listener);
    if (forward) this.repo.host.off(name === "ephemeral-message" ? "ephemeral" : name, forward);
    listeners?.delete(listener);
    return this;
  }

  broadcast(message) {
    this.#assertOpen();
    this.repo.host.broadcast(this.tree, {
      messageId: crypto.randomUUID(),
      origin: { kind: "repo", id: this.repo.host.hostId },
      payload: new Uint8Array(cbor.encode(message)),
    });
  }

  close(remove = async () => {}) {
    if (this.#close) return this.#close;
    this.#state = handleLifecycle(this.#state, "drain");
    for (const [name, listeners] of this.#listeners)
      for (const listener of listeners.keys()) this.off(name, listener);
    this.#close = this.#enqueue(remove).then(
      () => {
        this.#state = handleLifecycle(this.#state, "finish");
        this.#work.complete();
      },
      (error) => {
        // Keep the handle invalid, but allow a failed deletion to be retried.
        this.#close = undefined;
        throw error;
      },
    );
    return this.#close;
  }
}
