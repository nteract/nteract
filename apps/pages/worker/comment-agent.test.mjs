import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { agentAssertion, withMcpAgent } from "./client-provenance.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";

// Agent name and model a client asserts, stored once on the comment message's
// author and read back. They are client claims shown under the account.

const origin = "https://pages.invalid";
const agentFixture = (t) => fixture(t, { env: { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin } });
let keys = 0;
const key = () => `agent-${String(++keys).padStart(4, "0")}-${crypto.randomUUID()}`;

const request = (headers = {}) => new Request(`${origin}/api/tools`, { headers });
const meta = (agent) => withMcpAgent(request(), agent);

test("_meta.agent wins; headers fill what it lacks; a disagreement is refused", () => {
  assert.equal(agentAssertion(request()), undefined);
  assert.deepEqual(agentAssertion(meta({ name: "Rel", model: "m-1" })), {
    name: "Rel",
    model: "m-1",
  });
  assert.deepEqual(agentAssertion(request({ "x-pages-model": "m-2" }), "Header agent"), {
    name: "Header agent",
    model: "m-2",
  });
  const mixed = withMcpAgent(request({ "x-pages-model": "m-1" }), { name: "Rel" });
  assert.deepEqual(agentAssertion(mixed, "Rel"), { name: "Rel", model: "m-1" });
  assert.deepEqual(agentAssertion(mixed), { name: "Rel", model: "m-1" });
  // `id` is accepted as an assertion and never part of the stored form.
  assert.deepEqual(agentAssertion(meta({ id: "s-1", name: "Rel" })), { name: "Rel" });
  assert.equal(agentAssertion(meta({ id: "s-1" })), undefined);
  assert.throws(() => agentAssertion(meta({ name: "Rel" }), "Other"), {
    code: "invalid_arguments",
  });
  assert.throws(
    () => agentAssertion(withMcpAgent(request({ "x-pages-model": "b" }), { model: "a" })),
    { code: "invalid_arguments" },
  );
});

test("assertions keep the _meta.agent bounds, whichever way they arrive", () => {
  for (const bad of ["x".repeat(81), "bidi‮flip", "a\u0085b"])
    assert.throws(() => agentAssertion(request(), bad), { code: "invalid_arguments" }, bad);
  for (const bad of [{ name: "x".repeat(81) }, { model: "m".repeat(121) }, { name: "a\tb" }])
    assert.throws(() => agentAssertion(meta(bad)), { code: "invalid_arguments" });
  // A model header is printable ASCII, truncated to 120.
  const long = request({ "x-pages-model": "m".repeat(200) });
  assert.equal(agentAssertion(long).model.length, 120);
});

const rpc = (token, name, args, agent, headers = {}) =>
  new Request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-pages-driver": "Kilo",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...(agent && { _meta: { agent } }) },
    }),
  });
const http = (token, operation, args, agent, headers = {}) =>
  new Request(`${origin}/api/tools`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-pages-driver": "Kilo",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      operation,
      arguments: args,
      ...(agent !== undefined && { _meta: { agent } }),
    }),
  });

const threadAuthors = async (f) => {
  const read = await worker.fetch(
    http(f.tokens.owner, "list_page_comments", { page_id: pageId, include_messages: true }),
    f.env,
  );
  assert.equal(read.status, 200);
  return (await read.json()).comments.flatMap((thread) =>
    thread.messages.map((message) => message.author),
  );
};

async function addVia(f, send) {
  const args = {
    page_id: pageId,
    nonce: key(),
    action: "add",
    block_id: f.blockId,
    body: "From a tool",
  };
  const response = await worker.fetch(send(args), f.env);
  return { args, response };
}

test("/api/tools _meta.agent, MCP _meta.agent and the two headers store the same author.agent", async (t) => {
  const f = await agentFixture(t);
  const claim = { name: "release agent", model: "gpt-5" };
  const token = f.tokens.owner;
  const sends = {
    http: (args) => http(token, "manage_page_comment", args, { ...claim, id: "session-9" }),
    headers: (args) =>
      http(token, "manage_page_comment", args, undefined, {
        "x-pages-agent": claim.name,
        "x-pages-model": claim.model,
      }),
    mcp: (args) => rpc(token, "manage_page_comment", args, { ...claim, id: "session-9" }),
  };
  for (const [name, send] of Object.entries(sends)) {
    const before = (await threadAuthors(f)).length;
    const { response } = await addVia(f, send);
    assert.equal(response.status, 200, `${name}: ${await response.clone().text()}`);
    const authors = await threadAuthors(f);
    assert.equal(authors.length, before + 1);
    assert.deepEqual(authors.at(-1).agent, claim, name);
    assert.ok(!JSON.stringify(authors.at(-1)).includes("session-9"), "id is never returned");
  }
  assert.equal(
    f.commentsDoc().schema.features.includes("comment-agent"),
    true,
    "the comments document carries the stamp",
  );
});

test("read_page returns the same author.agent; a comment without one has no agent field", async (t) => {
  const f = await agentFixture(t);
  const claim = { name: "reviewer", model: "claude-x" };
  const named = await addVia(f, (args) => http(f.tokens.owner, "manage_page_comment", args, claim));
  assert.equal(named.response.status, 200);
  const plain = await addVia(f, (args) => http(f.tokens.owner, "manage_page_comment", args));
  assert.equal(plain.response.status, 200);
  const read = await worker.fetch(
    http(f.tokens.owner, "read_page", { page_id: pageId, comments: "all" }),
    f.env,
  );
  assert.equal(read.status, 200);
  const body = await read.json();
  const authors = body.comments.flatMap((thread) =>
    (thread.messages ?? []).map((message) => message.author),
  );
  assert.deepEqual(
    authors.filter((author) => author.agent).map((author) => author.agent),
    [claim],
  );
  const listed = await threadAuthors(f);
  assert.equal(listed.filter((author) => author.agent).length, 1);
  assert.ok(listed.some((author) => !Object.hasOwn(author, "agent")));
});

test("a malformed _meta on /api/tools is refused before anything is written", async (t) => {
  const f = await agentFixture(t);
  const heads = f.commentHeads();
  for (const agent of [{ name: "x".repeat(81) }, { principal: "admin" }, "name", ["a"], null]) {
    const { response } = await addVia(f, (args) =>
      http(f.tokens.owner, "manage_page_comment", args, agent),
    );
    assert.equal(response.status, 400, JSON.stringify(agent));
    assert.equal((await response.json()).code, "invalid_arguments");
  }
  const mismatch = await addVia(f, (args) =>
    http(f.tokens.owner, "manage_page_comment", args, { name: "A" }, { "x-pages-agent": "B" }),
  );
  assert.equal(mismatch.response.status, 400);
  assert.deepEqual(f.commentHeads(), heads);
});

test("an exact retry replays the original author; a changed label under the same key conflicts", async (t) => {
  const f = await agentFixture(t);
  const send = (args, agent) => http(f.tokens.owner, "manage_page_comment", args, agent);
  const args = {
    page_id: pageId,
    nonce: key(),
    action: "add",
    block_id: f.blockId,
    body: "Retried",
  };
  const first = await worker.fetch(send(args, { name: "A", model: "m1" }), f.env);
  assert.equal(first.status, 200);
  const original = await first.json();
  const heads = f.commentHeads();
  const replay = await worker.fetch(send(args, { name: "A", model: "m1" }), f.env);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), original);
  assert.deepEqual(f.commentHeads(), heads, "a replay writes nothing");
  for (const changed of [{ name: "B", model: "m1" }, { name: "A" }, undefined]) {
    const conflict = await worker.fetch(send(args, changed), f.env);
    assert.equal(conflict.status, 409, JSON.stringify(changed));
    assert.deepEqual(f.commentHeads(), heads);
  }
  const authors = await threadAuthors(f);
  assert.deepEqual(authors.at(-1).agent, { name: "A", model: "m1" });
});

test("an edit keeps the author's original agent, whatever the editing request asserts", async (t) => {
  const f = await agentFixture(t);
  const send = (args, agent) => http(f.tokens.owner, "manage_page_comment", args, agent);
  const created = await addVia(f, (args) => send(args, { name: "A", model: "m1" }));
  assert.equal(created.response.status, 200);
  const { thread_id, message_id } = (await created.response.json()).result;
  const edit = await worker.fetch(
    send(
      {
        page_id: pageId,
        nonce: key(),
        action: "edit",
        thread_id,
        message_id,
        body: "Rewritten",
      },
      { name: "Z", model: "other" },
    ),
    f.env,
  );
  assert.equal(edit.status, 200, await edit.clone().text());
  const reply = await worker.fetch(
    send(
      { page_id: pageId, nonce: key(), action: "reply", thread_id, body: "Second" },
      { name: "Z" },
    ),
    f.env,
  );
  assert.equal(reply.status, 200);
  const authors = await threadAuthors(f);
  const agents = authors.filter((author) => author.agent).map((author) => author.agent);
  assert.deepEqual(agents.slice(-2), [{ name: "A", model: "m1" }, { name: "Z" }]);
});
