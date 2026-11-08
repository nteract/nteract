import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as A from "@automerge/automerge";
import { commentsGenesis } from "./comments-doc.mjs";
import { applyComment, projectComments } from "./comments.mjs";
import { admitCommentChanges } from "./comment-authority.mjs";
import {
  commentAssertions,
  commentAssertionsFromRequest,
  readCommentAssertions,
} from "./comment-assertions.mjs";

test("stored v1 allowlist excludes private IDs, unsupported assurance, versions and malformed labels", () => {
  assert.equal(commentAssertions(undefined), undefined);
  assert.deepEqual(
    commentAssertionsFromRequest({
      assertions: { agent: { name: "\u00e9".repeat(60) }, model: "valid" },
    }),
    undefined,
  );
  assert.equal(
    commentAssertionsFromRequest({ assertions: { agent: { id: "private" } } }),
    undefined,
  );
  assert.deepEqual(
    commentAssertionsFromRequest({
      assertions: {
        harness: "Kilo",
        agent: { name: "Agent", id: "private" },
        model: "model",
        observations: ["verified"],
      },
      explicitAgent: { name: "Agent", model: "model", id: "private" },
    }),
    { version: 1, name: "Agent", model: "model" },
  );
  for (const value of [
    null,
    [],
    {},
    { version: 2, name: "A" },
    { version: 1 },
    { version: 1, name: "A", id: "private" },
    { version: 1, name: "A", assurance: "verified" },
    { version: 1, name: "a\u202eb" },
    { version: 1, model: "\u00e9".repeat(61) },
    { version: 1, harness: "x".repeat(121) },
  ]) {
    assert.throws(() => commentAssertions(value), { code: "invalid_arguments" });
    assert.equal(readCommentAssertions(value), undefined);
  }
});

// Execute the actual pre-assertion writer and validator, not an approximation
// of old-client behavior. Only relative import resolution changes in memory.
async function baselineModule(name) {
  const path = `docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/${name}`;
  const source = execFileSync("git", ["show", `943115c13706ab28b6bd1ddda775e57f3acf1b65:${path}`], {
    encoding: "utf8",
  });
  const resolved = source.replace(
    /from "([^"]+)"/g,
    (_match, specifier) =>
      `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, import.meta.url).href : import.meta.resolve(specifier))}`,
  );
  return import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
}

test("actual old writer and old validator accept ordinary writes after optional author assertions appear", async () => {
  const old = await baselineModule("comments.mjs");
  const oldAuthority = await baselineModule("comment-authority.mjs");
  const page = A.from({ blocks: { block: { id: "block" } } });
  const identity = { principal: "account:owner", displayName: "Owner", driver: "Browser" };
  const labels = { version: 1, name: "Agent", model: "model" };
  const genesis = commentsGenesis(crypto.randomUUID());
  let ids;
  const initial = A.change(A.clone(genesis), (draft) => {
    ids = applyComment(
      draft,
      { block_id: "block", body: "Created" },
      { ...identity, clientAssertions: labels },
      undefined,
      { page, role: "owner" },
    );
  });
  const authored = A.getChanges(genesis, initial);
  const accepted = admitCommentChanges(genesis, authored, identity.principal, { role: "owner" });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  A.free(accepted.next);
  const oldCreation = oldAuthority.admitCommentChanges(genesis, authored, identity.principal, {
    role: "owner",
  });
  assert.equal(oldCreation.ok, false, "an old HOST cannot admit newly asserted author shape");
  assert.equal(oldCreation.reason.code, "invalid_value");
  for (const bad of [
    { version: 1, name: "A", assurance: "verified" },
    { version: 1, name: "A", session_url: "https://private.invalid" },
    { version: 2, model: "future" },
  ]) {
    const next = A.change(A.clone(genesis), (draft) => {
      const made = applyComment(
        draft,
        { block_id: "block", body: "Spoofed" },
        identity,
        undefined,
        { page, role: "owner" },
      );
      draft.threads[made.thread_id].author.clientAssertions = bad;
      draft.threads[made.thread_id].messages[made.message_id].author.clientAssertions = bad;
    });
    const result = admitCommentChanges(genesis, A.getChanges(genesis, next), identity.principal, {
      role: "owner",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason.code, "invalid_value");
    A.free(next);
  }
  for (const action of [
    "reply",
    "edit",
    "resolve",
    "reopen",
    "delete_message",
    "delete_thread",
    "add",
  ]) {
    const next = A.change(A.clone(initial), (draft) =>
      old.applyComment(
        draft,
        { action, ...ids, block_id: "block", body: "Ordinary old writer" },
        identity,
        undefined,
        { page, role: "owner" },
      ),
    );
    const changes = A.getChanges(initial, next);
    for (const validate of [oldAuthority.admitCommentChanges, admitCommentChanges]) {
      const result = validate(initial, changes, identity.principal, { role: "owner" });
      assert.equal(result.ok, true, `${action}: ${JSON.stringify(result.reason)}`);
      if (action !== "delete_thread")
        assert.deepEqual(result.next.threads[ids.thread_id].author.clientAssertions, labels);
      A.free(result.next);
    }
    A.free(next);
  }
  for (const field of ["name", "model", "version"]) {
    const next = A.change(A.clone(initial), (draft) => {
      draft.threads[ids.thread_id].messages[ids.message_id].author.clientAssertions[field] =
        field === "version" ? 2 : "rewritten";
    });
    const result = admitCommentChanges(initial, A.getChanges(initial, next), identity.principal, {
      role: "owner",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason.code, "immutable_field");
    A.free(next);
  }
  const reopened = A.load(A.save(initial));
  assert.deepEqual(reopened.threads[ids.thread_id].author.clientAssertions, labels);
  assert.equal(reopened.schema, undefined, "no old-tab feature gate is stamped");
  const hostile = A.change(A.clone(initial), (draft) => {
    draft.threads[ids.thread_id].author.private_session = "private";
    draft.threads[ids.thread_id].messages[ids.message_id].author.private_session = "private";
    draft.threads[ids.thread_id].messages[ids.message_id].author.clientAssertions.session_url =
      "https://private.invalid";
  });
  const projected = projectComments(page, hostile);
  assert.ok(
    !JSON.stringify(projected).includes("private"),
    "legacy read/viewer projection is allowlisted too",
  );
  A.free(hostile);
  A.free(reopened);
  A.free(initial);
  A.free(genesis);
  A.free(page);
});
