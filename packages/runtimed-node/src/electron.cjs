"use strict";

const ELECTRON_HOST_PROTOCOL_VERSION = 1;

const ELECTRON_HOST_METHODS = Object.freeze([
  "daemon.isConnected",
  "daemon.reconnect",
  "daemon.getInfo",
  "daemon.getReadyInfo",
  "relay.prepareSync",
  "relay.notifySyncReady",
  "blobs.getPort",
  "deps.checkTyposquats",
  "notebook.applyPathChanged",
  "notebook.getDefaultSaveDirectory",
  "notebook.openInNewWindow",
  "notebook.openHostedInNewWindow",
  "notebook.cloneToEphemeral",
  "window.getTitle",
  "window.setTitle",
  "window.setTheme",
  "system.getGitInfo",
  "system.getUsername",
  "system.getFontFamilies",
  "dialog.openFile",
  "dialog.saveFile",
  "externalLinks.open",
  "updater.check",
  "updater.beginUpgrade",
  "settings.openWindow",
  "settings.getSynced",
  "settings.setSynced",
  "settings.rotateInstallId",
]);
const HOST_METHODS = new Set(ELECTRON_HOST_METHODS);

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function normalizeFrame(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((part) => Number.isInteger(part))) {
    return new Uint8Array(value);
  }
  return null;
}

function isHostNotification(value) {
  if (!isRecord(value) || !isRecord(value.params) || typeof value.params.message !== "string") {
    return false;
  }
  return ["log.debug", "log.info", "log.warn", "log.error"].includes(String(value.method));
}

/**
 * Attach an authorized RelaySession and an allowlisted host handler to one
 * MessagePortMain. This opens no listener and never exposes the daemon socket.
 */
function serveElectronNotebookHost(options) {
  let closed = false;
  let relayClosed = false;

  const emitEvent = (event, payload) => {
    if (!closed) options.port.postMessage({ type: "nteract:host-event", event, payload });
  };

  const sendResponse = (id, response) => {
    if (!closed) options.port.postMessage({ type: "nteract:host-response", id, ...response });
  };

  const server = {
    emit: emitEvent,
    async close() {
      if (closed) return;
      closed = true;
      options.port.off("message", onPortMessage);
      options.port.off("close", onPortClose);
      unlistenFrame();
      unlistenClose();
      options.port.close();
      await options.relay.close();
    },
  };

  const closeBestEffort = () => {
    void server.close().catch(() => {});
  };

  const onPortMessage = (event) => {
    if (closed || !isRecord(event.data)) return;
    const message = event.data;

    if (message.type === "nteract:frame") {
      const frame = normalizeFrame(message.frame);
      if (frame) {
        void options.relay.send(frame).catch(() => {
          emitEvent("transport.status", "offline");
          closeBestEffort();
        });
      }
      return;
    }

    if (message.type === "nteract:host-notification") {
      if (isHostNotification(message.notification)) options.handler.notify?.(message.notification);
      return;
    }

    if (
      message.type !== "nteract:host-request" ||
      typeof message.id !== "string" ||
      !HOST_METHODS.has(message.method)
    ) {
      return;
    }

    void Promise.resolve(options.handler.invoke(message.method, message.params)).then(
      (value) => sendResponse(message.id, { ok: true, value }),
      (error) =>
        sendResponse(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  };

  const onPortClose = () => {
    closeBestEffort();
  };

  const unlistenFrame = options.relay.onFrame((frame) => {
    if (!closed) options.port.postMessage({ type: "nteract:frame", frame: Uint8Array.from(frame) });
  });
  const unlistenClose = options.relay.onClose(() => {
    relayClosed = true;
    emitEvent("transport.status", "offline");
    closeBestEffort();
  });

  options.port.on("message", onPortMessage);
  options.port.on("close", onPortClose);
  options.port.start();
  emitEvent("transport.status", relayClosed ? "offline" : "online");
  return server;
}

module.exports = {
  ELECTRON_HOST_METHODS,
  ELECTRON_HOST_PROTOCOL_VERSION,
  serveElectronNotebookHost,
};
