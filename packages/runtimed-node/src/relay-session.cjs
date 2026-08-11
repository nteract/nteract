"use strict";

/**
 * JavaScript-facing relay wrapper over the native `NativeRelaySession`.
 *
 * The native side owns the daemon connection and delivers ordered, lossless
 * typed frames. This wrapper only fans those frames out to host listeners and
 * normalizes ArrayBuffer views for N-API.
 */
class RelaySession {
  constructor(nativeSession) {
    this._native = nativeSession;
    this._frameListeners = new Set();
    this._pendingFrames = [];
    this._drainingPending = false;
    this._closeListeners = new Set();
    this._closeEmitted = false;
    this._subscription = nativeSession.subscribeFrames(
      (frame) => {
        if (this._frameListeners.size === 0 || this._drainingPending) {
          this._pendingFrames.push(frame);
          return;
        }
        for (const listener of Array.from(this._frameListeners)) listener(frame);
      },
      () => this._emitClose(),
    );
  }

  get notebookId() {
    return this._native.notebookId;
  }

  get info() {
    return normalizeRelayInfo(this._native.info);
  }

  get closed() {
    return this._closeEmitted || this._native.closed;
  }

  send(frame) {
    return this._native.send(toBuffer(frame));
  }

  onFrame(listener) {
    if (typeof listener !== "function") throw new TypeError("frame listener must be a function");
    if (this.closed) throw new Error("Relay is closed");
    this._frameListeners.add(listener);
    this._drainingPending = true;
    try {
      while (this._pendingFrames.length > 0) {
        const pending = this._pendingFrames;
        this._pendingFrames = [];
        for (const frame of pending) listener(frame);
      }
    } finally {
      this._drainingPending = false;
    }
    return () => this._frameListeners.delete(listener);
  }

  onClose(listener) {
    if (typeof listener !== "function") throw new TypeError("close listener must be a function");
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this._closeListeners.add(listener);
    return () => this._closeListeners.delete(listener);
  }

  async close() {
    if (this._native.closed) {
      this._emitClose();
      return;
    }
    this._native.close();
    this._emitClose();
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._frameListeners.clear();
    this._pendingFrames = [];
    this._drainingPending = false;
    for (const listener of Array.from(this._closeListeners)) listener();
    this._closeListeners.clear();
    this._subscription?.dispose?.();
    this._subscription = null;
  }
}

function toBuffer(frame) {
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof ArrayBuffer) return Buffer.from(frame);
  if (ArrayBuffer.isView(frame)) {
    return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  }
  throw new TypeError("relay frame must be a Buffer, ArrayBuffer view, or ArrayBuffer");
}

function normalizeRelayInfo(info) {
  const { commentsNotebookRefJson, featuresJson, ...rest } = info;
  let commentsNotebookRef = null;
  if (commentsNotebookRefJson) {
    try {
      commentsNotebookRef = JSON.parse(commentsNotebookRefJson);
    } catch {
      // Treat malformed optional metadata as unavailable. Frame transport and
      // notebook synchronization do not depend on this presentation hint.
    }
  }
  let features = {};
  if (featuresJson) {
    try {
      const parsed = JSON.parse(featuresJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        features = Object.fromEntries(
          Object.entries(parsed).filter(
            ([name, version]) => name.length > 0 && Number.isInteger(version) && version >= 0,
          ),
        );
      }
    } catch {
      // Missing/malformed optional capabilities are treated as unsupported.
    }
  }
  return { ...rest, commentsNotebookRef, features };
}

module.exports = { RelaySession, normalizeRelayInfo, toBuffer };
