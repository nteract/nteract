import { defineMachine } from "../shared/machine.mjs";

/**
 * One API intent's record reservation on a live Page.
 *
 * The storage bridge pins the exact record identities a key first reserved and
 * rejects a later reservation of that key that drops any of them. So the first
 * reservation's records stay the intent's records until release: a retry after
 * the edit applied reuses the held set instead of recomputing it from a handle
 * that already contains the edit, and storing writes that same set.
 *
 * States hold record identities (`commit/<hash>` or `fragment/<head>`); the
 * interpreter (DocumentAdmission) keeps the matching bytes. The bridge holds
 * reservations in memory only, so a restarted Page starts `unreserved` and
 * recovery reserves against the stored history it loaded.
 */
export const reservationMachine = defineMachine({
  name: "history-reservation",
  states: ["unreserved", "reserved", "stored"],
  events: ["reserve", "stored", "release"],
  initial: { name: "unreserved" },
  unreachable: [["unreserved", "stored", "records are stored only under a reservation"]],
  transition(state, event) {
    switch (event.type) {
      case "reserve":
        if (state.name === "unreserved")
          return {
            state: { name: "reserved", records: event.records },
            effects: [{ type: "reserve", records: event.records }],
          };
        // A retry reserves the held identities again, whatever it computed.
        return { state, effects: [{ type: "reserve", records: state.records }] };
      case "stored":
        return { state: { name: "stored", records: state.records }, effects: [] };
      case "release":
        return { state: { name: "unreserved" }, effects: [{ type: "release" }] };
    }
  },
});

export const recordIdentity = (record) =>
  `${record.kind}/${record.kind === "commit" ? record.id : record.head}`;
