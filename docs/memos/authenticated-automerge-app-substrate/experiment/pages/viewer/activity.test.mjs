import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { activitySnapshot, activityIdentity, progressPassages, pageActivity } from "./activity.mjs";
import { createProgressTargets } from "../model/presence.mjs";
import { enableRich, textPath } from "../model/richtext.mjs";

const message = () => ({
  kind: "page-activity",
  epoch: "host-epoch",
  revision: 1,
  observed_at: "2026-10-28T00:00:00Z",
  progress: [
    {
      progress_id: "agent-one",
      principal: "account",
      displayName: "Kyle Kelley",
      driver: "ChatGPT",
      message: "Checking the introduction",
      targets: [],
      expires_at: "2026-10-28T00:01:00Z",
      lease_token: "must-not-leak",
    },
  ],
});

test("activity uses server-relative expiry and keeps only presentation fields", () => {
  const snapshot = activitySnapshot(message(), 500);
  assert.equal(snapshot.progress.get("agent-one").until, 60500);
  assert.equal(JSON.stringify([...snapshot.progress]).includes("must-not-leak"), false);
  const expired = message();
  expired.observed_at = "2026-10-28T00:02:00Z";
  assert.equal(activitySnapshot(expired).progress.size, 0);
  for (const mutate of [
    (m) => {
      m.revision = -1;
    },
    (m) => {
      m.observed_at = "no date";
    },
    (m) => {
      m.progress[0].expires_at = "2026-10-28T00:02:00Z";
    },
    (m) => {
      m.progress.push({ ...m.progress[0] });
    },
    (m) => {
      m.progress[0].targets = [{ block_id: "b", quote: "passage", target: {} }];
    },
  ]) {
    const invalid = message();
    mutate(invalid);
    assert.equal(activitySnapshot(invalid), null);
  }
});

test("activity keeps account attribution explicit without calling browser selections typing", () => {
  assert.equal(
    activityIdentity({ displayName: "Kyle Kelley", driver: "ChatGPT" }).label,
    "ChatGPT on behalf of Kyle Kelley",
  );
  assert.equal(
    activityIdentity({ displayName: "Kyle Kelley", driver: "Browser" }).label,
    "Kyle Kelley",
  );
  assert.equal(activityIdentity({}).label, "Collaborator");
});

test("a closed activity count does not read or project the document", () => {
  const item = { ...message().progress[0], until: 2000 };
  const session = {
    agentProgress: new Map([[item.progress_id, item]]),
    peers: new Map([["peer", { at: 1000, displayName: "Kyle", value: {} }]]),
    get doc() {
      throw Error("Document projection must stay lazy");
    },
  };
  const activity = pageActivity(session, 1000, { resolveSelections: false });
  assert.equal(activity.progress.length + activity.peers.length, 2);
  assert.equal(activity.peers[0].displayName, "Kyle");
  assert.equal(Object.hasOwn(activity.peers[0], "selection"), false);
  assert.throws(() => pageActivity(session, 1000), /projection must stay lazy/);
});

test("progress ranges follow edits, detach on deletion, and never mutate the document", () => {
  let doc = A.from({ blocks: { first: { kind: "markdown", markdown: "Hello **world**." } } });
  doc = A.change(doc, (d) => enableRich(d, "first"));
  const targets = createProgressTargets(
    doc,
    [{ block_id: "first", match_text: "world" }],
    A.getHeads(doc),
  );
  const progress = { ...message().progress[0], targets, until: 2000 };
  const session = {
    doc,
    agentProgress: new Map([[progress.progress_id, progress]]),
    peers: new Map(),
  };
  const before = A.getHeads(doc);
  assert.equal(progressPassages(session, 1000)[0].quote, "world");
  assert.deepEqual(A.getHeads(doc), before);
  session.doc = A.change(session.doc, (d) => A.splice(d, textPath("first"), 0, 0, "Prefix "));
  const passage = progressPassages(session, 1000)[0];
  assert.ok(passage.start_utf16 > 6);
  assert.equal(pageActivity(session, 2001).progress.length, 0);
  assert.equal(progressPassages(session, 2001).length, 0);
  session.doc = A.change(session.doc, (d) =>
    A.splice(d, textPath("first"), passage.start_utf16, 5, ""),
  );
  assert.equal(progressPassages(session, 1000).length, 0);
});

test("agent presence entries are validated one at a time", async () => {
  const { activitySnapshot } = await import("./activity.mjs");
  const observed = "2026-10-31T00:00:00.000Z";
  const good = {
    agent_id: "a1",
    principal: "user:kyle",
    displayName: "Kyle",
    driver: "Kilo",
    state: "active",
    seq: 1,
    targets: [{ kind: "block", block_id: "b1" }, { kind: "mystery" }],
    updated_at: observed,
    expires_at: "2026-10-31T00:00:15.000Z",
  };
  const snapshot = activitySnapshot(
    {
      kind: "page-activity",
      epoch: "e",
      revision: 1,
      observed_at: observed,
      progress: [],
      agents: [
        good,
        { ...good, agent_id: "bad", state: "typing" },
        { ...good, agent_id: "late", expires_at: "2026-10-31T00:05:00.000Z" },
      ],
    },
    5000,
  );
  assert.deepEqual([...snapshot.agents.keys()], ["a1"]);
  assert.deepEqual(snapshot.agents.get("a1").targets, [{ kind: "block", block_id: "b1" }]);
  assert.equal(snapshot.agents.get("a1").until, 5000 + 15_000);
  // An older host sends no agents at all.
  const older = activitySnapshot({
    kind: "page-activity",
    epoch: "e",
    revision: 1,
    observed_at: observed,
    progress: [],
  });
  assert.equal(older.agents.size, 0);
});
