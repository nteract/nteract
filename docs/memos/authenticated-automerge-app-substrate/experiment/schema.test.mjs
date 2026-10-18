import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import { createPeer, connectPeers, closePeers, eventually } from "./backend.mjs";

// A deliberately small reader fixture, not a shared document schema or editor.
// It never writes its narrower projection back to the Automerge document.
function project(doc) {
  const diagnostics = [];
  const title = typeof doc.title === "string" ? doc.title : "Unsupported title";
  if (typeof doc.title !== "string") diagnostics.push("title must be text");
  const blocks = [];
  for (const [id, block] of Object.entries(doc.blocks ?? {})) {
    if (block?.kind !== "paragraph") {
      blocks.push({ id, status: "unsupported" });
    } else if (typeof block.text !== "string") {
      diagnostics.push(`${id}: paragraph text is malformed`);
      blocks.push({ id, status: "invalid" });
    } else {
      blocks.push({ id, status: "supported", text: block.text });
    }
  }
  return { title, blocks, diagnostics };
}

test(
  "typed reader diagnoses malformed known fields while old-client edits preserve newer content",
  { timeout: 15000 },
  async () => {
    const newer = createPeer(),
      older = createPeer();
    const wires = [];
    try {
      const doc = await newer.repo.create({
        schemaVersion: 9,
        title: { futureTitleRepresentation: "Keep me" },
        blocks: {
          intro: { kind: "paragraph", text: "Editable", extensions: { future: true } },
          chart: { kind: "future-chart", samples: [1, 2, 3] },
          malformed: { kind: "paragraph", text: ["unsupported", "shape"] },
        },
        futureRoot: { authorIntent: "Retain this too" },
      });
      wires.push(await connectPeers(newer, older));
      const old = await older.repo.find(doc.documentId);
      const before = project(old.doc());
      assert.equal(before.blocks.find((block) => block.id === "chart").status, "unsupported");
      assert.deepEqual(before.diagnostics, [
        "title must be text",
        "malformed: paragraph text is malformed",
      ]);
      await old.change((value) => {
        A.updateText(value, ["blocks", "intro", "text"], "Old client changed only a known field");
      });
      await older.repo.flush();
      await eventually(() => assert.deepEqual(old.doc(), doc.doc()));
      assert.deepEqual(doc.doc().blocks.chart.samples, [1, 2, 3]);
      assert.deepEqual(doc.doc().blocks.malformed.text, ["unsupported", "shape"]);
      assert.equal(doc.doc().blocks.intro.extensions.future, true);
      assert.equal(doc.doc().schemaVersion, 9);
      assert.equal(doc.doc().futureRoot.authorIntent, "Retain this too");
      assert.deepEqual(doc.doc().title, { futureTitleRepresentation: "Keep me" });
      // No claim about Markdown/ipynb export or an actual editor's projection.
    } finally {
      assert.deepEqual(await closePeers([newer, older], wires), []);
    }
  },
);
