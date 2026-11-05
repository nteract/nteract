/**
 * Reopening a Page in place after its replica adopted the host's storage, as
 * a state machine. SessionHost keeps one per Page in this tab.
 *
 * A replica whose storage differs from the host's records its checkpoint,
 * final, under the host's storage (storage-switch-machine.mjs `adopted`).
 * The checkpoint is on the device, so the tab can close that session and open
 * a replacement from it, in the host's storage, without a reload. The
 * replacement restores the Page and comments documents from the checkpoint
 * and sends any unacknowledged local edits it holds.
 *
 * States:
 * - idle: no reopen has run for this Page in this tab.
 * - closing: the adopted session is closing: its final checkpoint, then its
 *   backend release.
 * - opening: the replacement session is opening from the recorded
 *   checkpoint.
 * - reopened: the replacement opened. Another adoption for this Page in this
 *   tab would be a loop, so it asks for a reload instead.
 * - failed: the close or the open failed, or an adoption repeated. The
 *   person is asked to reload; the checkpoint stays on the device.
 *
 * Events:
 * - adopted: an installed session recorded the host's storage.
 * - closed: the adopted session closed and released its replica.
 * - opened: the replacement session opened.
 * - failed: the running step failed.
 *
 * Effects:
 * - close: close the adopted session and wait for its release.
 * - open: open the replacement session.
 * - install: install the replacement; a navigation since then closes it.
 * - reloadRequired: tell the person to reload to keep editing.
 */
import { defineMachine, reject } from "../shared/machine.mjs";

const only = (keys) => (value) => {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`unexpected field ${key}`);
};

export const STORAGE_REOPEN_STATES = Object.freeze([
  "idle",
  "closing",
  "opening",
  "reopened",
  "failed",
]);

export const storageReopenSpec = Object.freeze({
  name: "storage-reopen",
  states: [...STORAGE_REOPEN_STATES],
  events: ["adopted", "closed", "opened", "failed"],
  validate: {
    states: Object.fromEntries(STORAGE_REOPEN_STATES.map((name) => [name, only(["name"])])),
    events: {
      adopted: only(["type"]),
      closed: only(["type"]),
      opened: only(["type"]),
      failed: only(["type"]),
    },
    effects: {
      close: only(["type"]),
      open: only(["type"]),
      install: only(["type"]),
      reloadRequired: only(["type"]),
    },
  },
});

export const REJECT = Object.freeze({
  busy: "This Page is already reopening",
  stale: "That step isn't running",
});

const ok = (name, effects = []) => ({ state: { name }, effects });

function transition(state, event) {
  switch (event.type) {
    case "adopted":
      if (state.name === "idle") return ok("closing", [{ type: "close" }]);
      if (state.name === "closing" || state.name === "opening") return reject(state, REJECT.busy);
      // The replacement adopted again, or an earlier reopen failed: a reload
      // is the only way forward that can't loop.
      return ok("failed", [{ type: "reloadRequired" }]);
    case "closed":
      if (state.name !== "closing") return reject(state, REJECT.stale);
      return ok("opening", [{ type: "open" }]);
    case "opened":
      if (state.name !== "opening") return reject(state, REJECT.stale);
      return ok("reopened", [{ type: "install" }]);
    case "failed":
      if (state.name !== "closing" && state.name !== "opening") return reject(state, REJECT.stale);
      return ok("failed", [{ type: "reloadRequired" }]);
  }
  throw new Error(`unknown event ${event.type}`);
}

export const storageReopenMachine = defineMachine({
  ...storageReopenSpec,
  initial: { name: "idle" },
  transition,
});
