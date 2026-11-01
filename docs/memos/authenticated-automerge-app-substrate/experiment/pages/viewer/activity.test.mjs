import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  activitySnapshot,
  activityIdentity,
  presenceLabel,
  progressPassages,
  pageActivity,
} from "./activity.mjs";
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

test("a person in the browser is presented by name; other clients keep their label", () => {
  assert.equal(presenceLabel({ displayName: "Kyle Kelley", driver: "Browser" }), "Kyle Kelley");
  assert.equal(presenceLabel({ displayName: "Kyle Kelley", driver: " browser " }), "Kyle Kelley");
  assert.equal(presenceLabel({ displayName: "Kyle Kelley" }), "Kyle Kelley");
  assert.equal(
    presenceLabel({ displayName: "Kyle Kelley", driver: "Mobile" }),
    "Kyle Kelley · Mobile",
  );
  assert.equal(presenceLabel({ driver: "Browser" }), "Collaborator");
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

test("a caret and a progress lease from one agent session are one participant", async () => {
  const { agentParticipants } = await import("./activity.mjs");
  const who = { principal: "user:kyle", displayName: "Kyle", driver: "Kilo" };
  const caret = (id, extra) => [
    id,
    { ...who, agent_id: id, state: "active", until: 5000, ...extra },
  ];
  const lease = (id, extra) => [
    id,
    { ...who, progress_id: id, message: id, until: 4000, updated: 100, ...extra },
  ];
  const cases = [
    {
      name: "labeled caret joins its labeled leases, newest update first",
      presence: [caret("c1", { agent: "release agent" })],
      progress: [
        lease("old", { agent: "release agent", updated: 100 }),
        lease("new", { agent: "release agent", updated: 200 }),
      ],
      expect: [["release agent", "c1", ["new", "old"]]],
    },
    {
      name: "unlabeled lease joins an unlabeled caret",
      presence: [caret("c1", { agent: null })],
      progress: [lease("p", { agent: null })],
      expect: [[null, "c1", ["p"]]],
    },
    {
      name: "a label mismatch keeps them apart",
      presence: [caret("c1", { agent: "rich text" })],
      progress: [lease("p", { agent: null })],
      expect: [
        ["rich text", "c1", []],
        [null, null, ["p"]],
      ],
    },
    {
      name: "two accounts with the same harness and label stay separate",
      presence: [
        caret("c1", { agent: "bot" }),
        caret("c2", { agent: "bot", principal: "user:ana" }),
      ],
      progress: [lease("p", { agent: "bot", principal: "user:ana" })],
      expect: [
        ["bot", "c1", []],
        ["bot", "c2", ["p"]],
      ],
    },
    {
      name: "expired leases drop out",
      presence: [caret("c1", { agent: "bot" })],
      progress: [lease("gone", { agent: "bot", until: 500 })],
      expect: [["bot", "c1", []]],
    },
  ];
  for (const item of cases) {
    const participants = agentParticipants(
      { agentPresence: new Map(item.presence), agentProgress: new Map(item.progress) },
      1000,
    );
    assert.deepEqual(
      participants.map((p) => [
        p.agent,
        p.presence?.agent_id ?? null,
        p.progress.map((x) => x.message),
      ]),
      item.expect,
      item.name,
    );
  }
  // A participant stays until both its caret and its last lease expire.
  for (const [caretUntil, leaseUntil] of [
    [2000, 3000],
    [3000, 2000],
  ]) {
    const session = {
      agentPresence: new Map([caret("c1", { agent: "bot", until: caretUntil })]),
      agentProgress: new Map([lease("p", { agent: "bot", until: leaseUntil })]),
    };
    assert.equal(agentParticipants(session, 1999).length, 1);
    assert.equal(agentParticipants(session, Math.min(caretUntil, leaseUntil)).length, 1);
    assert.equal(agentParticipants(session, Math.max(caretUntil, leaseUntil)).length, 0);
  }
  const counted = pageActivity(
    {
      agentPresence: new Map(cases[0].presence),
      agentProgress: new Map(cases[0].progress),
      peers: new Map(),
    },
    1000,
    { resolveSelections: false },
  );
  assert.equal(counted.agents.length, 1);
});

test("the newest progress is the latest accepted update, even with equal expiries", () => {
  const raw = message();
  const base = raw.progress[0];
  // Both reports landed in the credential's last minute, so they share an expiry.
  raw.progress = [
    { ...base, progress_id: "earlier", message: "Earlier", updated_at: "2026-10-28T00:00:01.000Z" },
    { ...base, progress_id: "later", message: "Later", updated_at: "2026-10-28T00:00:09.000Z" },
  ];
  raw.observed_at = "2026-10-28T00:00:10.000Z";
  raw.progress.forEach((item) => (item.expires_at = "2026-10-28T00:00:40.000Z"));
  const snapshot = activitySnapshot(raw, 50_000);
  const earlier = snapshot.progress.get("earlier"),
    later = snapshot.progress.get("later");
  assert.equal(earlier.until, later.until);
  assert.equal(later.updated - earlier.updated, 8000);
  assert.equal(later.updated, 50_000 - 1000);
});

test("progress snapshots keep the session label", () => {
  const raw = message();
  raw.progress[0].agent = "release agent";
  const snapshot = activitySnapshot(raw, 1000);
  assert.equal([...snapshot.progress.values()][0].agent, "release agent");
  const unlabeled = activitySnapshot(message(), 1000);
  assert.equal([...unlabeled.progress.values()][0].agent, null);
});

test("a caret and a lease merge only within one MCP session", async () => {
  const { agentParticipants } = await import("./activity.mjs");
  const who = { principal: "user:kyle", displayName: "Kyle", driver: "Kilo", agent: null };
  const session = {
    agentPresence: new Map([
      ["c1", { ...who, session: "aaaaaaaaaaaaaaaa", agent_id: "c1", state: "active", until: 5000 }],
      ["c2", { ...who, session: "bbbbbbbbbbbbbbbb", agent_id: "c2", state: "active", until: 5000 }],
    ]),
    agentProgress: new Map([
      [
        "p1",
        {
          ...who,
          session: "bbbbbbbbbbbbbbbb",
          progress_id: "p1",
          message: "B",
          until: 4000,
          updated: 1,
        },
      ],
    ]),
  };
  assert.deepEqual(
    agentParticipants(session, 1000).map((p) => [
      p.presence?.agent_id,
      p.progress.map((x) => x.message),
    ]),
    [
      ["c1", []],
      ["c2", ["B"]],
    ],
  );
});
