import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { PageSession } from "./session.mjs";

test("a delayed old receipt cannot replace the Saved state from a newer edit", async (t) => {
  let doc = A.from({ text: "one" });
  const pending = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) =>
    new Promise((resolve) => pending.push({ heads: JSON.parse(request.body).heads, resolve }));
  t.after(() => {
    globalThis.fetch = original;
  });
  const session = new PageSession("fixture");
  session.handle = { doc: () => doc };
  session.repo = { flush: async () => {} };
  session.receiptRevision = 1;
  const old = session.saveReceipt();
  await new Promise((resolve) => setTimeout(resolve, 0));
  doc = A.change(doc, (d) => A.updateText(d, ["text"], "two"));
  session.receiptRevision = 2;
  const recent = session.saveReceipt();
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[1].resolve(
    new Response(JSON.stringify({ durableHeads: pending[1].heads }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  await recent;
  assert.equal(session.status, "Saved");
  pending[0].resolve(
    new Response(JSON.stringify({ durableHeads: pending[0].heads }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  await old;
  assert.equal(session.status, "Saved");
  assert.deepEqual(session.savedHeads, A.getHeads(doc));
});

test("only signed host profile hints name edits, including hints arriving before their changes", () => {
  let doc = A.from({ text: "one" });
  const later = A.change(A.clone(doc), (d) => A.updateText(d, ["text"], "two"));
  const session = new PageSession("fixture");
  session.handle = { doc: () => doc };
  session.connection = { serverSenderId: "verified-host" };
  const hint = {
    kind: "tool-edit",
    heads: A.getHeads(later),
    identity: { displayName: "Kyle Kelley", driver: "ChatGPT" },
  };
  session.ephemeral({ senderId: "untrusted-client", message: hint });
  assert.equal(session.toolHints.length, 0);
  session.ephemeral({ senderId: "verified-host", message: hint });
  assert.equal(session.toolHints.length, 1);
  doc = later;
  session.resolveToolHints();
  assert.equal(session.toolHints.length, 0);
  assert.equal(session.actorDisplayName(A.getActorId(later)), "Kyle Kelley · ChatGPT");
});
test("presence rejects malformed causal heads and ignores claimed display identity", () => {
  const session = new PageSession("fixture");
  session.connection = { serverSenderId: "verified-host" };
  session.profiles = { peer: { displayName: "Kyle Kelley", driver: "Mobile" } };
  session.ephemeral({
    senderId: "peer",
    message: {
      kind: "selection",
      value: { block_id: "b", start: "s", end: "e", heads: ["malformed"] },
    },
  });
  assert.equal(session.peers.size, 0);
  session.ephemeral({
    senderId: "peer",
    message: {
      kind: "selection",
      displayName: "Impersonated",
      value: { block_id: "b", start: "s", end: "e", heads: [] },
    },
  });
  assert.equal(session.peers.get("peer").displayName, "Kyle Kelley · Mobile");
});

test("a local write requests durability even when its handle emits no visible patch", async (t) => {
  const session = new PageSession("fixture");
  session.canWrite = true;
  session.status = "Saved";
  session.handle = {
    change(fn) {
      fn({});
      return Promise.resolve();
    },
  };
  session.change(() => {});
  assert.equal(session.status, "Saving");
  assert.ok(session.savedTimer);
  t.after(() => clearTimeout(session.savedTimer));
});
