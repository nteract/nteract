"use strict";

const { Subject } = require("rxjs");
const { parseJsonEvent } = require("./napi-observables.cjs");

class Session {
  constructor(nativeSession) {
    this._native = nativeSession;
    this._subscriptions = [];
    this._runtimeStateSubject = new Subject();
    this._executionTransitionsSubject = new Subject();
    this.runtimeState$ = this._runtimeStateSubject.asObservable();
    this.executionTransitions$ = this._executionTransitionsSubject.asObservable();

    if (typeof nativeSession.onRuntimeState === "function") {
      this._subscriptions.push(
        nativeSession.onRuntimeState((json) =>
          this._runtimeStateSubject.next(parseJsonEvent(json)),
        ),
      );
    }
    if (typeof nativeSession.onExecutionTransition === "function") {
      this._subscriptions.push(
        nativeSession.onExecutionTransition((json) =>
          this._executionTransitionsSubject.next(parseJsonEvent(json)),
        ),
      );
    }
  }

  get notebookId() {
    return this._native.notebookId;
  }

  queueCell(source, options) {
    return this._native.queueCell(source, options);
  }

  async waitForExecution(executionId, options = {}) {
    const { onUpdate, cellId, ...nativeOptions } = options ?? {};
    let progressSubscription = null;
    if (typeof onUpdate === "function" && typeof this._native.onExecutionProgress === "function") {
      progressSubscription = this._native.onExecutionProgress(
        executionId,
        cellId ?? null,
        (json) => {
          onUpdate(parseJsonEvent(json));
        },
      );
    }

    try {
      return await this._native.waitForExecution(executionId, nativeOptions);
    } finally {
      progressSubscription?.dispose?.();
    }
  }

  async runCell(source, options = {}) {
    if (typeof options?.onUpdate !== "function") {
      return this._native.runCell(source, options);
    }
    const queued = await this.queueCell(source, options);
    return this.waitForExecution(queued.executionId, {
      ...options,
      cellId: queued.cellId,
    });
  }

  saveNotebook(path) {
    return this._native.saveNotebook(path);
  }

  addUvDependency(pkg) {
    return this._native.addUvDependency(pkg);
  }

  dependencyFingerprint() {
    return this._native.dependencyFingerprint();
  }

  approveTrust(observedHeads) {
    return this._native.approveTrust(observedHeads);
  }

  syncEnvironment() {
    return this._native.syncEnvironment();
  }

  close() {
    for (const subscription of this._subscriptions.splice(0)) {
      subscription?.dispose?.();
    }
    this._runtimeStateSubject.complete();
    this._executionTransitionsSubject.complete();
    return this._native.close();
  }
}

module.exports = {
  Session,
};
