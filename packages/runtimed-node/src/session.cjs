"use strict";

const { Subject } = require("rxjs");
const { parseJsonEvent } = require("./napi-observables.cjs");

class Session {
  constructor(nativeSession) {
    this._native = nativeSession;
    this._subscriptions = [];
    this._runtimeStateSubject = new Subject();
    this._executionTransitionsSubject = new Subject();
    this._executionViewChangesSubject = new Subject();
    this._cellChangesSubject = new Subject();
    this._broadcastsSubject = new Subject();
    this._sessionStatusSubject = new Subject();
    this.runtimeState$ = this._runtimeStateSubject.asObservable();
    this.executionTransitions$ = this._executionTransitionsSubject.asObservable();
    this.executionViewChanges$ = this._executionViewChangesSubject.asObservable();
    this.cellChanges$ = this._cellChangesSubject.asObservable();
    this.broadcasts$ = this._broadcastsSubject.asObservable();
    this.sessionStatus$ = this._sessionStatusSubject.asObservable();

    if (typeof nativeSession.onRuntimeState === "function") {
      this._subscriptions.push(
        nativeSession.onRuntimeState((json) =>
          this._runtimeStateSubject.next(parseJsonEvent(json)),
        ),
      );
    }
    if (typeof nativeSession.onCellChange === "function") {
      this._subscriptions.push(
        nativeSession.onCellChange((json) => this._cellChangesSubject.next(parseJsonEvent(json))),
      );
    }
    if (typeof nativeSession.onBroadcast === "function") {
      this._subscriptions.push(
        nativeSession.onBroadcast((json) => this._broadcastsSubject.next(parseJsonEvent(json))),
      );
    }
    if (typeof nativeSession.onSessionStatus === "function") {
      this._subscriptions.push(
        nativeSession.onSessionStatus((json) =>
          this._sessionStatusSubject.next(parseJsonEvent(json)),
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
    if (typeof nativeSession.onExecutionViewChange === "function") {
      this._subscriptions.push(
        nativeSession.onExecutionViewChange((json) =>
          this._executionViewChangesSubject.next(parseJsonEvent(json)),
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
    const { onUpdate, ...nativeOptions } = options ?? {};
    const cellId = nativeOptions.cellId;
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

  listCells() {
    return this._native.listCells();
  }

  getCell(cellId) {
    return this._native.getCell(cellId);
  }

  createCell(source, options) {
    return this._native.createCell(source, options);
  }

  setCell(cellId, options) {
    return this._native.setCell(cellId, options);
  }

  deleteCell(cellId) {
    return this._native.deleteCell(cellId);
  }

  moveCell(cellId, afterCellId) {
    return this._native.moveCell(cellId, afterCellId == null ? undefined : { afterCellId });
  }

  executeCell(cellId, options) {
    return this._native.executeCell(cellId, options);
  }

  showNotebook() {
    return this._native.showNotebook();
  }

  interruptKernel() {
    return this._native.interruptKernel();
  }

  shutdownKernel() {
    return this._native.shutdownKernel();
  }

  restartKernel() {
    return this._native.restartKernel();
  }

  shutdownNotebook() {
    return this._native.shutdownNotebook();
  }

  addDependency(pkg, options) {
    return this._native.addDependency(pkg, normalizeDependencyOptions(options));
  }

  addDependencies(packages, options) {
    return this._native.addDependencies(
      normalizePackages(packages),
      normalizeDependencyOptions(options),
    );
  }

  removeDependency(pkg, options) {
    return this._native.removeDependency(pkg, normalizeDependencyOptions(options));
  }

  removeDependencies(packages, options) {
    return this._native.removeDependencies(
      normalizePackages(packages),
      normalizeDependencyOptions(options),
    );
  }

  getDependencyStatus() {
    return this._native.getDependencyStatus();
  }

  getRuntimeStatus() {
    return this._native.getRuntimeStatus();
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
    this._executionViewChangesSubject.complete();
    this._cellChangesSubject.complete();
    this._broadcastsSubject.complete();
    this._sessionStatusSubject.complete();
    return this._native.close();
  }
}

function normalizePackages(packages) {
  if (!Array.isArray(packages)) {
    throw new TypeError("packages must be an array of dependency specifiers");
  }
  return Array.from(new Set(packages.map((pkg) => String(pkg).trim()).filter(Boolean)));
}

function normalizeDependencyOptions(options) {
  if (!options?.packageManager) {
    return undefined;
  }
  return { packageManager: options.packageManager };
}

module.exports = {
  Session,
};
