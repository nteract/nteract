import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { commentsGenesis } from "./comments-doc.mjs";
import { applyComment } from "./comments.mjs";
import { admitCommentChanges } from "./comment-authority.mjs";
import { readCommentAuthor, commentAssertionsFromRequest } from "./comment-assertions.mjs";
import { clientProvenance, withMcpAgent } from "../worker/client-provenance.mjs";
import { attribution } from "../viewer/comment-thread-display.mjs";
import { projectComments } from "./comments.mjs";
import { projectReadComments } from "./read-comments.mjs";
import { commentDecision } from "./comment-rules.mjs";

test("construction checks scale with ops and preserve max-byte current-writer labels", (t) => {
  const counts = [];
  for (const count of [1, 8, 32]) {
    const f = native();
    const started = performance.now();
    const candidate = A.change(A.clone(f.base), (draft) => {
      for (let n = 0; n < count; n++)
        applyComment(
          draft,
          { block_id: "block", body: "Body" },
          {
            principal: "Alice",
            displayName: "Alice",
            driver: "Browser",
            clientAssertions: { version: 1, name: "\u00e9".repeat(40), model: "\u00e9".repeat(60) },
          },
          undefined,
          { page: f.page, role: "owner" },
        );
    });
    const result = admitCommentChanges(f.base, A.getChanges(f.base, candidate), "Alice", {
      role: "owner",
    });
    assert.equal(result.ok, true, JSON.stringify(result.reason));
    assert.ok(result.stats.pathLookups <= result.stats.ops);
    assert.equal(result.stats.assertionObjectReads, count * 2);
    counts.push(result.stats.ops);
    t.diagnostic(
      `${count} comments: ${result.stats.ops} ops, ${result.stats.pathLookups} path lookups, ${result.stats.assertionObjectReads} bounded object reads, ${(performance.now() - started).toFixed(1)}ms construct+admit`,
    );
    for (const doc of [result.next, candidate, f.base, f.created, f.page]) A.free(doc);
  }
  assert.equal(counts[1], counts[0] * 8);
  assert.equal(counts[2], counts[0] * 32);
});

test("review P1: name-only request never publishes private header model or harness", () => {
  const request = withMcpAgent(
    new Request("https://pages.invalid/mcp", {
      headers: {
        "x-pages-model": "private-model-label",
        "x-pages-client": "private-harness",
      },
    }),
    { name: "Explicit" },
  );
  assert.deepEqual(commentAssertionsFromRequest(clientProvenance(request)), {
    version: 1,
    name: "Explicit",
  });
});

test("review P2: native immutable principals remain distinct and readable", () => {
  const a = readCommentAuthor({
    principal: new A.ImmutableString("Alice"),
    displayName: new A.ImmutableString("Alice"),
    driver: new A.ImmutableString("Browser"),
  });
  const b = readCommentAuthor({
    principal: new A.ImmutableString("Bob"),
    displayName: new A.ImmutableString("Bob"),
    driver: new A.ImmutableString("Browser"),
  });
  assert.equal(a.principal, "Alice");
  assert.equal(b.principal, "Bob");
  assert.notEqual(attribution(a).key, attribution(b).key);
});

test("admitted native immutable authors survive compact and legacy projections with ownership intact", () => {
  const f = native();
  let doc = A.clone(f.base);
  for (const principal of ["Alice", "Bob"]) {
    const next = A.change(A.clone(doc), (draft) => {
      applyComment(
        draft,
        { block_id: "block", body: principal },
        {
          principal: new A.ImmutableString(principal),
          displayName: new A.ImmutableString(principal),
          driver: new A.ImmutableString("Browser"),
        },
        undefined,
        { page: f.page, role: "owner" },
      );
    });
    const admitted = admitCommentChanges(doc, A.getChanges(doc, next), principal, {
      role: "owner",
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted.reason));
    A.free(doc);
    A.free(next);
    doc = admitted.next;
  }
  for (const threads of [projectComments(f.page, doc), projectReadComments(f.page, {}, doc)]) {
    const messages = threads.flatMap((thread) => thread.messages);
    assert.deepEqual(messages.map((message) => message.author.principal).sort(), ["Alice", "Bob"]);
    assert.notEqual(attribution(messages[0].author).key, attribution(messages[1].author).key);
    for (const message of messages)
      assert.equal(
        commentDecision({ action: "edit", principal: "Alice", role: "owner", message }).allowed,
        message.author.principal === "Alice",
      );
  }
  for (const owned of [doc, f.base, f.created, f.page]) A.free(owned);
});

function native() {
  const base = commentsGenesis(crypto.randomUUID());
  const page = A.from({ blocks: { block: { id: "block" } } });
  let ids;
  const created = A.change(A.clone(base), (draft) => {
    ids = applyComment(
      draft,
      { block_id: "block", body: "Comment" },
      { principal: "Alice", displayName: "Alice", driver: "Browser" },
      undefined,
      { page, role: "owner" },
    );
  });
  return {
    base,
    created,
    page,
    ids,
    path: ["threads", ids.thread_id, "messages", ids.message_id, "author", "clientAssertions"],
  };
}

for (const kind of ["map", "field", "version", "mark", "block"])
  test(`review P2: native assertion ${kind} cannot hide unvalidated payload`, () => {
    const f = native();
    const withClaims = A.change(A.clone(f.created), (draft) => {
      draft.threads[f.ids.thread_id].messages[f.ids.message_id].author.clientAssertions = {
        version: 1,
        name: "Agent",
      };
    });
    let candidate;
    if (["map", "field", "version"].includes(kind)) {
      const fork = (actor, bad) =>
        A.change(A.clone(kind === "map" ? f.created : withClaims, { actor }), (draft) => {
          const author = draft.threads[f.ids.thread_id].messages[f.ids.message_id].author;
          if (kind === "map")
            author.clientAssertions = bad
              ? { version: 1, model: "x".repeat(5000), session_url: "private" }
              : { version: 1, name: "Agent" };
          else if (kind === "field")
            author.clientAssertions.name = new A.ImmutableString(bad ? "x".repeat(5000) : "Agent");
          else {
            author.clientAssertions.version = 3;
            author.clientAssertions.version = bad ? 2 : 1;
          }
        });
      const bad = fork("11".repeat(16), true),
        good = fork("ff".repeat(16), false);
      candidate = A.merge(A.clone(bad), A.clone(good));
      assert.equal(
        candidate.threads[f.ids.thread_id].messages[f.ids.message_id].author.clientAssertions
          .version,
        1,
      );
      A.free(bad);
      A.free(good);
    } else
      candidate = A.change(A.clone(withClaims), (draft) => {
        const path = [...f.path, "name"];
        if (kind === "mark") A.mark(draft, path, { start: 0, end: 1 }, "session_url", "private");
        else A.splitBlock(draft, path, 0, { type: "private", payload: "private" });
      });
    const result = admitCommentChanges(f.base, A.getChanges(f.base, candidate), "Alice", {
      role: "owner",
    });
    if (result.ok) A.free(result.next);
    assert.equal(result.ok, false, "entire new-author batch must be rejected");
    for (const doc of [candidate, withClaims, f.created, f.base, f.page]) A.free(doc);
  });
