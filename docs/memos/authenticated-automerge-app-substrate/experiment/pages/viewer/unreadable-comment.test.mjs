// A comment message in an earlier build's stored form (a `body` beside its
// spans, as a stale replica's merge can leave it) renders as a placeholder.
// The rest of the thread, the other threads and the Page keep rendering.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import * as A from "@automerge/automerge";
import "fake-indexeddb/auto";
import { createPageData, initializePage } from "../model/page.mjs";
import { newCommentsDoc } from "../model/comments-test-support.mjs";
import { PageSession } from "./session.mjs";
import { UNREADABLE_COMMENT } from "./comment-thread-display.mjs";

const owner = {
  role: "owner",
  generation: 0,
  revision: 0,
  canRead: true,
  canWrite: true,
  canComment: true,
  canManageAccess: true,
  canDelete: true,
};

/** An open session over a Page whose comments moved to their own document. */
function session(t) {
  const value = new PageSession("page_fixture", { buildFeatures: ["comments-doc"] });
  let page = A.change(A.from(createPageData({ pageId: "page_fixture", title: "Plan" })), (d) =>
    initializePage(d, "We ship on Friday."),
  );
  let comments = newCommentsDoc();
  value.credentialCanWrite = true;
  value.access = owner;
  value.identity = { principal: "user:kyle", displayName: "Kyle", driver: "Browser" };
  value.handle = { doc: () => page, change: () => Promise.resolve() };
  value.commentsHandle = {
    doc: () => comments,
    change(fn) {
      comments = A.change(comments, fn);
      return Promise.resolve();
    },
  };
  value.queueSaved = () => {};
  value.observeSchema();
  value.updateCapabilities();
  t.after(() => clearTimeout(value.savedTimer));
  return {
    session: value,
    /** Write to the comments document as a peer would, unchecked. */
    peer(fn) {
      comments = A.change(comments, fn);
    },
  };
}

test("one unreadable message leaves the Page, its thread and other threads readable, and warns once", (t) => {
  const { session: s, peer } = session(t);
  const block = Object.keys(s.doc.blocks)[0];
  s.comment({ action: "add", block_id: block, body: "First thread" });
  const [first] = Object.keys(s.commentThreads);
  s.comment({ action: "reply", thread_id: first, body: "A readable reply" });
  s.comment({ action: "add", block_id: block, body: "Second thread" });
  const original = Object.values(s.commentThreads[first].messages).find(
    (message) => String(message.richText) === "First thread",
  );
  const badId = Object.keys(s.commentThreads[first].messages).find(
    (id) => s.commentThreads[first].messages[id] === original,
  );
  peer((d) => {
    d.threads[first].messages[badId].body = "stale copy";
  });

  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
  const page = s.snapshot();
  assert.equal(page.title, "Plan");
  assert.equal(page.blocks.length, 1);
  assert.equal(page.comments.length, 2);
  const thread = page.comments.find((entry) => entry.id === first);
  const bad = thread.messages.find((message) => message.id === badId);
  const reply = thread.messages.find((message) => message.id !== badId);
  assert.equal(bad.content_error, "stored_form_unsupported");
  assert.equal(bad.body, "");
  assert.equal(bad.author.principal, "user:kyle", "the author line stays");
  assert.ok(bad.createdAt);
  assert.equal(reply.body, "A readable reply");
  const other = page.comments.find((entry) => entry.id !== first);
  assert.equal(other.messages[0].body, "Second thread");
  assert.doesNotMatch(JSON.stringify(page), /stale copy/);

  s.snapshot();
  assert.equal(warnings.length, 1, "reported once per message");
  assert.match(warnings[0], new RegExp(`${first}/${badId}`));

  // Writes over it are still refused; the session keeps going.
  assert.throws(
    () => s.comment({ action: "edit", thread_id: first, message_id: badId, body: "New" }),
    { code: "stored_form_unsupported" },
  );
  assert.equal(s.snapshot().comments.length, 2);
});

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./CommentThreadParts.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-component",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
      },
    },
  ],
});
const { Message } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);

test("an unreadable message renders its author and a muted placeholder", () => {
  const message = {
    id: "m1",
    body: "",
    body_format: "plain",
    content_error: "stored_form_unsupported",
    author: { principal: "user:kyle", displayName: "Kyle Kelley", driver: "Browser" },
    createdAt: "2026-11-05T18:49:00.000Z",
  };
  // The stored source still holds a `body`; it is never read for display.
  const source = { format: "automerge-rich-text-v1", richText: "x", body: "stale copy" };
  const html = renderToStaticMarkup(
    createElement(Message, { message, source, now: Date.parse("2026-11-06T00:00:00Z") }),
  );
  const fragment = JSDOM.fragment(html);
  assert.equal(fragment.querySelector(".message-author strong").textContent, "Kyle Kelley");
  assert.equal(
    fragment.querySelector(".comment-unreadable p.muted").textContent,
    UNREADABLE_COMMENT,
  );
  assert.equal(
    UNREADABLE_COMMENT,
    "This comment was saved by an earlier version of Pages and can't be shown.",
  );
  assert.doesNotMatch(html, /stale copy/);
});
