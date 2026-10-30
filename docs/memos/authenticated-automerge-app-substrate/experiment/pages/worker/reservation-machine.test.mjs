import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { reservationMachine } from "./reservation-machine.mjs";

const held = ["commit/aa", "fragment/bb"];
const recomputed = [];

test("a reservation keeps its first record identities until release", async () => {
  await runTable(reservationMachine, [
    {
      state: { name: "unreserved" },
      event: { type: "reserve", records: held },
      expect: {
        state: { name: "reserved", records: held },
        effects: [{ type: "reserve", records: held }],
      },
    },
    {
      label: "a retry before the records are stored reserves the held set",
      state: { name: "reserved", records: held },
      event: { type: "reserve", records: recomputed },
      expect: {
        state: { name: "reserved", records: held },
        effects: [{ type: "reserve", records: held }],
      },
    },
    {
      label: "a retry after the edit applied ignores the empty recomputation",
      state: { name: "stored", records: held },
      event: { type: "reserve", records: recomputed },
      expect: {
        state: { name: "stored", records: held },
        effects: [{ type: "reserve", records: held }],
      },
    },
    {
      state: { name: "reserved", records: held },
      event: { type: "stored" },
      expect: { state: { name: "stored", records: held }, effects: [] },
    },
    {
      label: "a retry stores the same records again",
      state: { name: "stored", records: held },
      event: { type: "stored" },
      expect: { state: { name: "stored", records: held }, effects: [] },
    },
    {
      label: "a receipt written before restart releases a reservation this Page never held",
      state: { name: "unreserved" },
      event: { type: "release" },
      expect: { state: { name: "unreserved" }, effects: [{ type: "release" }] },
    },
    {
      state: { name: "reserved", records: held },
      event: { type: "release" },
      expect: { state: { name: "unreserved" }, effects: [{ type: "release" }] },
    },
    {
      state: { name: "stored", records: held },
      event: { type: "release" },
      expect: { state: { name: "unreserved" }, effects: [{ type: "release" }] },
    },
  ]);
});
