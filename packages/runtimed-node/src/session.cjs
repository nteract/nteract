"use strict";

const { ReplaySubject, Subject } = require("rxjs");
const { parseJsonEvent } = require("./napi-observables.cjs");

class Session {
  constructor(nativeSession) {
    this._native = nativeSession;
    this._subscriptions = [];
    this._executionView = emptyExecutionView();
    this._runtimeStateSubject = new Subject();
    this._executionTransitionsSubject = new Subject();
    this._executionViewChangesSubject = new Subject();
    this._cellChangesSubject = new Subject();
    this._broadcastsSubject = new Subject();
    // Native status subscriptions synchronously emit their current value when
    // registered. Replay it so a host that subscribes after Session
    // construction cannot miss an already-disconnected handle.
    this._sessionStatusSubject = new ReplaySubject(1);
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
          this._sessionStatusSubject.next(parseSessionStatus(json)),
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
        nativeSession.onExecutionViewChange((json) => {
          const changeset = parseJsonEvent(json);
          applyExecutionViewChangeset(this._executionView, changeset);
          this._executionViewChangesSubject.next(changeset);
        }),
      );
    }
  }

  get notebookId() {
    return this._native.notebookId;
  }

  queueCell(source, options) {
    return this._native.queueCell(source, options);
  }

  queueExistingCell(cellId, options) {
    return this._native.queueExistingCell(cellId, options);
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

  exportSnapshotPair() {
    return this._native.exportSnapshotPair();
  }

  listCells() {
    return this._native.listCells();
  }

  getCell(cellId) {
    return this._native.getCell(cellId);
  }

  getCellOutputs(cellId) {
    return this._native.getCellOutputs(cellId);
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

  cancelExecution(executionId) {
    return this._native.cancelExecution(executionId);
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

  getExecutionView() {
    return cloneExecutionView(this._executionView);
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

function parseSessionStatus(json) {
  const status = parseJsonEvent(json);
  return {
    connection: enumPhase(status.connection, "connection", ["connected", "disconnected"]),
    notebook_doc: enumPhase(status.notebook_doc, "notebook_doc", [
      "pending",
      "syncing",
      "interactive",
    ]),
    runtime_state: enumPhase(status.runtime_state, "runtime_state", [
      "pending",
      "syncing",
      "ready",
    ]),
    initial_load: initialLoadPhase(status.initial_load),
  };
}

function enumPhase(value, field, allowed) {
  if (typeof value !== "string") throw new TypeError(`Invalid session status ${field}`);
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new TypeError(`Invalid session status ${field}: ${value}`);
  }
  return normalized;
}

function initialLoadPhase(value) {
  const allowed = ["not_needed", "streaming", "ready", "failed"];
  if (typeof value === "string") {
    const phase = enumPhase(value, "initial_load", allowed);
    if (phase === "failed") throw new TypeError("Invalid failed session status initial_load");
    return { phase };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.phase === "string") {
      const phase = enumPhase(value.phase, "initial_load.phase", allowed);
      if (phase === "failed") {
        if (typeof value.reason !== "string") {
          throw new TypeError("Invalid failed session status initial_load.reason");
        }
        return { phase, reason: value.reason };
      }
      return { phase };
    }
    const failed = value.Failed ?? value.failed;
    if (failed && typeof failed === "object" && typeof failed.reason === "string") {
      return { phase: "failed", reason: failed.reason };
    }
  }
  throw new TypeError("Invalid session status initial_load");
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

function emptyExecutionView() {
  return {
    cell_execution_ids: {},
    executions: {},
    queue: null,
  };
}

function applyExecutionViewChangeset(view, changeset) {
  for (const [cellId, executionId] of changeset?.cell_pointer_changes ?? []) {
    if (executionId == null) {
      delete view.cell_execution_ids[cellId];
    } else {
      view.cell_execution_ids[cellId] = executionId;
    }
  }

  for (const [executionId, snapshot] of changeset?.execution_upserts ?? []) {
    view.executions[executionId] = cloneExecutionSnapshot(snapshot);
  }

  for (const executionId of changeset?.removed_execution_ids ?? []) {
    delete view.executions[executionId];
  }

  if (Object.hasOwn(changeset ?? {}, "queue")) {
    view.queue = cloneQueueProjection(changeset.queue ?? null);
  }
}

function cloneExecutionView(view) {
  return {
    cell_execution_ids: { ...view.cell_execution_ids },
    executions: Object.fromEntries(
      Object.entries(view.executions).map(([executionId, snapshot]) => [
        executionId,
        cloneExecutionSnapshot(snapshot),
      ]),
    ),
    queue: cloneQueueProjection(view.queue),
  };
}

function cloneExecutionSnapshot(snapshot) {
  return {
    ...snapshot,
    output_ids: Array.from(snapshot?.output_ids ?? []),
  };
}

function cloneQueueProjection(queue) {
  if (queue == null) return null;
  return {
    executing_execution_id: queue.executing_execution_id ?? null,
    queued_execution_ids: Array.from(queue.queued_execution_ids ?? []),
    notebook:
      queue.notebook == null
        ? queue.notebook
        : {
            executing_cell_id: queue.notebook.executing_cell_id ?? null,
            queued_cell_ids: Array.from(queue.notebook.queued_cell_ids ?? []),
          },
  };
}

module.exports = {
  Session,
};
