// Protocol integration against a running local celld, including real OIDC sessions.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import * as A from "@automerge/automerge/slim";
const origin = process.env.PAGES_ORIGIN || "http://localhost:9890";
assert.equal(
  new URL(origin).hostname,
  "localhost",
  "This generated-fixture probe uses local OIDC only",
);
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
async function login(user) {
  const cookies = new Map();
  let url = `${origin}/api/auth/login`;
  for (let i = 0; i < 12; i++) {
    if (new URL(url).pathname === "/dev/oidc/authorize" && user) {
      const next = new URL(url);
      next.searchParams.set("login_hint", user);
      url = next.href;
    }
    const response = await fetch(url, {
      redirect: "manual",
      headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0],
        at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    if (!response.headers.has("location")) {
      assert.equal(response.status, 200);
      break;
    }
    url = new URL(response.headers.get("location"), url).href;
    assert.equal(new URL(url).origin, origin);
  }
  return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function tool(cookie, operation, args) {
  const response = await fetch(`${origin}/api/tools`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, arguments: args }),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const peers = [];
function peer(cookie, id, doc) {
  const p = {
    doc,
    state: A.initSyncState(),
    heads: null,
    error: null,
    closed: false,
    ready: false,
  };
  p.socket = new WebSocket(`${origin.replace("http", "ws")}/api/sync?page=${id}`, {
    headers: { Origin: origin, Cookie: cookie },
  });
  p.send = () => {
    const [s, m] = A.generateSyncMessage(p.doc, p.state);
    p.state = s;
    if (m) p.socket.send(m);
  };
  p.socket.on("message", (raw, binary) => {
    try {
      if (binary) {
        [p.doc, p.state] = A.receiveSyncMessage(p.doc, p.state, new Uint8Array(raw));
        p.send();
        return;
      }
      const m = JSON.parse(raw.toString());
      if (m.type === "hello") {
        p.doc ??= A.init({ actor: m.actor_prefix + crypto.randomUUID().replaceAll("-", "") });
        p.ready = true;
        p.send();
      } else if (m.type === "durable") p.heads = m.heads;
      else if (m.type === "rejected") p.error = Error(JSON.stringify(m));
    } catch (e) {
      p.error = e;
    }
  });
  p.socket.on("error", (error) => {
    p.error = error;
  });
  p.socket.on("close", () => {
    p.closed = true;
  });
  p.saved = () => {
    if (p.error) throw p.error;
    return (
      !!p.doc &&
      !!p.heads &&
      A.hasHeads(p.doc, p.heads) &&
      A.getChangesSince(p.doc, p.heads).length === 0
    );
  };
  peers.push(p);
  return p;
}
try {
  const cookie = await login(),
    secondCookie = await login();
  const created = await tool(cookie, "create_page", {
    idempotency_key: crypto.randomUUID(),
    title: "CRDT protocol fixture",
    markdown: "Hello 🌍 middle",
  });
  const id = created.page_id,
    block = created.content.blocks[0].id;
  const a = peer(cookie, id),
    b = peer(secondCookie, id);
  await until(() => a.saved() && b.saved(), "initial sync");
  a.doc = A.change(a.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 0, 0, "left "));
  b.doc = A.change(b.doc, (d) =>
    A.splice(d, ["blocks", block, "markdown"], d.blocks[block].markdown.length, 0, " right"),
  );
  a.send();
  b.send();
  await until(
    () =>
      a.saved() &&
      b.saved() &&
      a.doc.blocks[block].markdown === "left Hello 🌍 middle right" &&
      b.doc.blocks[block].markdown === a.doc.blocks[block].markdown,
    "concurrent convergence",
  );
  assert.deepEqual(A.getHeads(a.doc), A.getHeads(b.doc));
  const beforeComment = await tool(cookie, "read_page", { page_id: id });
  const comment = await tool(cookie, "manage_page_comment", {
    page_id: id,
    action: "add",
    block_id: block,
    selected_text: "Hello 🌍",
    body: "API discussion",
    base_sequence: beforeComment.content.through_sequence,
    idempotency_key: crypto.randomUUID(),
  });
  await until(
    () =>
      a.doc.comments?.[comment.thread_id] &&
      b.doc.comments?.[comment.thread_id] &&
      a.saved() &&
      b.saved(),
    "HTTP comment reaches both replicas",
  );
  const replyId = crypto.randomUUID();
  a.doc = A.change(a.doc, (d) => {
    d.comments[comment.thread_id].messages[replyId] = {
      body: "Replica reply",
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
    };
  });
  a.send();
  await until(
    () => b.doc.comments?.[comment.thread_id].messages[replyId] && a.saved() && b.saved(),
    "raw CRDT reply convergence",
  );
  const discussion = await tool(cookie, "list_page_comments", { page_id: id });
  assert.equal(discussion.threads[0].messages.length, 2);
  assert.equal(discussion.threads[0].selectionContext.text, "Hello 🌍");
  await tool(cookie, "manage_page_comment", {
    page_id: id,
    action: "resolve",
    thread_id: comment.thread_id,
    base_sequence: discussion.sequence,
    idempotency_key: crypto.randomUUID(),
  });
  await until(
    () => b.doc.comments[comment.thread_id].status.value === "resolved" && b.saved(),
    "resolved comments push live",
  );
  a.socket.close();
  await until(() => a.closed, "disconnect");
  a.doc = A.change(a.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 0, 0, "offline "));
  const current = await tool(secondCookie, "read_page", { page_id: id });
  await tool(secondCookie, "edit_page", {
    page_id: id,
    base_sequence: current.content.through_sequence,
    idempotency_key: crypto.randomUUID(),
    operations: [
      { op: "set_title", title: "Tool push", expected_title_hash: current.content.title_hash },
    ],
  });
  await until(() => b.doc.title === "Tool push" && b.saved(), "HTTP pushes through WebSocket");
  const restored = peer(cookie, id, A.load(A.save(a.doc), { actor: A.getActorId(a.doc) }));
  await until(
    () =>
      restored.saved() &&
      b.saved() &&
      b.doc.blocks[block].markdown.startsWith("offline ") &&
      restored.doc.title === "Tool push",
    "reconnect merge",
  );
  assert.deepEqual(A.getHeads(restored.doc), A.getHeads(b.doc));
  // Logout invalidates an already-open socket before it can receive another edit.
  const logout = await fetch(`${origin}/api/auth/session`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(logout.status, 200);
  b.doc = A.change(b.doc, (d) => A.splice(d, ["blocks", block, "markdown"], 0, 0, "valid "));
  b.send();
  await until(() => restored.closed && b.saved(), "session revocation");
  console.log(
    "PASS: real celld OIDC + binary CRDT convergence, Unicode, HTTP push, reconnect, comments, and socket revocation",
  );
} finally {
  for (const p of peers) {
    p.socket.terminate();
    if (p.doc) A.free(p.doc);
  }
}
