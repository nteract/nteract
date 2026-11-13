import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import worker from "./index.mjs";
import { newCommentsDoc } from "../model/comments-test-support.mjs";
import { blockAddress } from "../model/addresses.mjs";
import { stampFeatures } from "../model/schema-features.mjs";
import { world } from "./projects-fixture.mjs";
import { headsFor } from "./revisions.mjs";
import { PROJECT_CONTENT_OPERATIONS } from "./project-content.mjs";
import { tools } from "../mcp.mjs";

// The Projects fixture stubs native transport. Supply mutable document handles
// for journal tests; record-admission behavior has its own integration suite.
function writableContent(w, project) {
  const page = w.page(project.document_id);
  let doc = A.change(page.handle.doc(), (draft) => stampFeatures(draft, ["comments-doc"]));
  let comments = newCommentsDoc();
  page.handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
    broadcast() {},
  };
  page.commentsHandle = {
    doc: () => comments,
    async update(fn) {
      comments = fn(comments);
    },
    broadcast() {},
  };
  page.backend = undefined;
  page.admission = undefined;
  page.flush = () => page.ctx.storage.sync();
}

const alias = (args, projectId) =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) =>
      key === "page_id" ? ["project_id", projectId] : [key, value],
    ),
  );
const grant = (w, project, role, direct = false, expected_revision = 0) =>
  w.call("owner", direct ? "manage_page_access" : "manage_project_access", {
    ...(direct ? { page_id: project.document_id } : { project_id: project.project_id }),
    action: "set_role",
    principal: w.member,
    role,
    expected_revision,
    nonce: w.key(),
  });

test("content descriptors accept exactly one selector without changing placement tools", () => {
  for (const tool of tools) {
    if (PROJECT_CONTENT_OPERATIONS.has(tool.name)) {
      assert.ok(tool.inputSchema.properties.project_id, tool.name);
      assert.ok(!tool.inputSchema.required.includes("page_id"), tool.name);
      assert.equal(tool.inputSchema.oneOf, undefined);
    } else assert.equal(tool.inputSchema.oneOf, undefined, tool.name);
  }
  assert.ok(
    tools.find((tool) => tool.name === "move_page").inputSchema.required.includes("page_id"),
  );
});

test("every content tool rejects absent or ambiguous selectors before mapping", async (t) => {
  const w = await world(t);
  t.mock.method(w.env.PROJECTS, "getByName", () => assert.fail("must not resolve"));
  for (const operation of PROJECT_CONTENT_OPERATIONS) {
    for (const args of [
      {},
      { page_id: crypto.randomUUID(), project_id: `prj_${crypto.randomUUID()}` },
    ]) {
      const result = await w.call("owner", operation, args);
      assert.equal(result.status, 400, operation);
      assert.equal(result.body.code, "invalid_arguments", operation);
    }
  }
  assert.equal((await w.call("owner", "read_page", { project_id: null })).status, 400);
});

test("authentication and write scopes precede Project lookup", async (t) => {
  const w = await world(t);
  t.mock.method(w.env.PROJECTS, "getByName", () => assert.fail("must not resolve"));
  const args = { project_id: `prj_${crypto.randomUUID()}` };
  const anonymous = await worker.fetch(
    new Request("https://pages.invalid/api/tools", {
      method: "POST",
      body: JSON.stringify({ operation: "read_page", arguments: args }),
    }),
    w.env,
  );
  assert.equal(anonymous.status, 401);
  for (const operation of [
    "edit_page",
    "edit_page",
    "manage_page_comment",
    "report_page_progress",
    "create_page_asset_upload",
  ])
    assert.equal((await w.call("reader", operation, args)).status, 403, operation);
  const file = { download_url: "https://files.oaiusercontent.com/fixture", file_id: "fixture" };
  assert.equal(
    (await w.call("reader", "create_page_asset_upload", { ...args, file })).status,
    403,
    "a file import needs write scope too",
  );
});

test("Project content reads as the Project for a reader, by project_id or document_id", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Catalog title", "Private description");
  for (const address of [{ project_id: project.project_id }, { page_id: project.document_id }]) {
    const result = await w.call("owner", "read_page", address);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.kind, "project");
    assert.equal(result.body.page_id, project.document_id);
    assert.equal(result.body.project_id, project.project_id);
    assert.deepEqual(result.body.breadcrumbs, [
      { kind: "project", project_id: project.project_id, title: "Catalog title" },
    ]);
    for (const key of ["_owner", "home", "description", "members", "org"])
      assert.equal(Object.hasOwn(result.body, key), false, key);
  }
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).body.document_id,
    project.document_id,
  );
  const mcp = await w.mcp("owner", "read_page", { project_id: project.project_id });
  assert.equal(mcp.isError, false, JSON.stringify(mcp.body));
  assert.equal(mcp.body.url, `https://pages.invalid/project/${project.project_id}`);
  assert.equal(mcp.body.project_id, project.project_id);
});

for (const direct of [false, true])
  for (const role of ["viewer", "commenter", "editor"])
    test(`${direct ? "direct" : "Project"} ${role} keeps content permissions across aliases and revocation`, async (t) => {
      const w = await world(t);
      const project = await w.createProject();
      writableContent(w, project);
      assert.equal((await grant(w, project, role, direct)).status, 200);
      // A direct grant reads by document ID only, as a plain Page; the
      // project_id selector never widens it to the Project.
      if (direct) {
        const selected = await w.call("member", "read_page", { project_id: project.project_id });
        assert.equal(selected.status, 404, JSON.stringify(selected.body));
        assert.equal(selected.body.code, "project_not_found");
      }
      const address = direct
        ? { page_id: project.document_id }
        : { project_id: project.project_id };
      const read = await w.call("member", "read_page", address);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.kind, direct ? "page" : "project");
      assert.equal(read.body.project_id, direct ? undefined : project.project_id);
      const edited = await w.call("member", "edit_page", {
        ...address,
        revision: read.body.revision,
        nonce: w.key(),
        operations: [{ op: "set_title", title: "Edited" }],
      });
      assert.equal(edited.status, role === "editor" ? 200 : 403, JSON.stringify(edited.body));
      const doc = w.page(project.document_id).handle.doc();
      const comment = await w.call("member", "manage_page_comment", {
        ...address,
        action: "add",
        node_id: blockAddress(doc, Object.keys(doc.blocks)[0]),
        body: "Content comment",
        nonce: w.key(),
      });
      assert.equal(comment.status, role === "viewer" ? 403 : 200, JSON.stringify(comment.body));
      if (direct) {
        assert.equal(
          (await w.call("member", "get_project", { project_id: project.project_id })).status,
          404,
        );
        assert.equal(
          (await w.call("member", "list_pages", { project_id: project.project_id })).status,
          404,
        );
      }
      assert.equal((await grant(w, project, null, direct, 1)).status, 200);
      assert.equal(
        (await w.call("member", "read_page", { project_id: project.project_id })).status,
        404,
        "no longer a Project reader",
      );
      assert.equal(
        (await w.call("member", "read_page", { page_id: project.document_id })).status,
        403,
      );
    });

test("Project lookup neither claims invitations nor creates discovery hints", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  assert.equal((await grant(w, project, "viewer", true)).status, 200);
  assert.equal(
    (
      await w.call("owner", "manage_project_access", {
        project_id: project.project_id,
        action: "invite",
        email: "fixture@example.invalid",
        role: "editor",
        expected_revision: 0,
        nonce: w.key(),
      })
    ).status,
    200,
  );
  const storage = w.projects.get(project.project_id).ctx.storage;
  const before = await storage.get("space/record");
  const discovery = await w.catalogStorage(w.member).list({ prefix: "project-discovery/" });
  // A direct grant plus an unclaimed invitation is not Project read access,
  // and the selector check never claims the invitation.
  const selected = await w.call("member", "read_page", { project_id: project.project_id });
  assert.equal(selected.status, 404, JSON.stringify(selected.body));
  assert.deepEqual(await storage.get("space/record"), before);
  assert.deepEqual(
    await w.catalogStorage(w.member).list({ prefix: "project-discovery/" }),
    discovery,
  );
  // An invitation alone is not a content grant.
  assert.equal((await grant(w, project, null, true, 1)).status, 200);
  assert.equal(
    (await w.call("member", "read_page", { project_id: project.project_id })).status,
    404,
  );
  assert.deepEqual(await storage.get("space/record"), before);
});

test("alias edits replay the physical journal and keep the stale-revision fence", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  writableContent(w, project);
  const read = (await w.call("owner", "read_page", { project_id: project.project_id })).body;
  const args = {
    page_id: project.document_id,
    revision: read.revision,
    nonce: crypto.randomUUID(),
    operations: [{ op: "set_title", title: "Once" }],
  };
  const first = await w.call("owner", "edit_page", alias(args, project.project_id));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await w.call("owner", "edit_page", args);
  // The Project address adds kind and project_id; the receipt is the same.
  assert.equal(first.body.kind, "project");
  const { project_id: _id, kind: _kind, ...receipt } = first.body;
  assert.deepEqual(second.body, receipt);
  assert.deepEqual(
    w.heads(project.document_id),
    await headsFor(w.page(project.document_id).ctx.storage, "page", first.body.revision),
  );
  const stale = await w.call("owner", "edit_page", {
    ...alias(args, project.project_id),
    nonce: crypto.randomUUID(),
  });
  assert.equal(stale.body.code, "stale_revision");
  // A comments revision names the other document: refused before any work.
  const wrongDocument = await w.call("owner", "edit_page", {
    ...alias(args, project.project_id),
    revision: "c1",
    nonce: crypto.randomUUID(),
  });
  assert.equal(wrongDocument.body.code, "invalid_revision", JSON.stringify(wrongDocument.body));
});

for (const damage of [
  "missing-project",
  "missing-catalog",
  "pending-project",
  "pending-page",
  "wrong-document",
  "wrong-owner",
])
  test(`incomplete mapping fails closed: ${damage}`, async (t) => {
    const w = await world(t);
    const project = await w.createProject();
    const space = w.projects.get(project.project_id).ctx.storage;
    const catalog = w.catalogStorage();
    if (damage === "missing-project") await space.delete("space/record");
    if (damage === "missing-catalog") await catalog.delete(`space/${project.project_id}`);
    if (damage === "pending-project") {
      const key = `space/${project.project_id}`;
      await catalog.put(key, { ...(await catalog.get(key)), pending: true });
    }
    if (damage === "pending-page") {
      const key = `page/${project.document_id}`;
      await catalog.put(key, { ...(await catalog.get(key)), pending: true });
    }
    if (damage === "wrong-document") {
      const key = `space/${project.project_id}`;
      await catalog.put(key, { ...(await catalog.get(key)), document_id: crypto.randomUUID() });
    }
    if (damage === "wrong-owner") w.page(project.document_id).metadata.owner = w.member;
    const result = await w.call("owner", "read_page", { project_id: project.project_id });
    assert.equal(result.status, 404, JSON.stringify(result.body));
    assert.equal(result.body.code, "project_not_found");
    assert.equal(result.body.page_id, undefined);
  });

test("creation and move placement keep their existing project_id meaning", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const parent = await w.createPage({ project_id: project.project_id });
  const child = await w.createPage({
    project_id: project.project_id,
    parent_id: parent.body.page_id,
  });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  const moved = await w.call("owner", "move_page", {
    page_id: child.body.page_id,
    project_id: project.project_id,
    nonce: crypto.randomUUID(),
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
});

test("patch, comment and presence tools resolve the same content and receipt scope", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  writableContent(w, project);
  const before = (await w.call("owner", "read_page", { page_id: project.document_id })).body;
  const doc = w.page(project.document_id).handle.doc();
  const block = blockAddress(doc, Object.keys(doc.blocks)[0]);
  const insert = await w.call("owner", "edit_page", {
    project_id: project.project_id,
    revision: before.revision,
    nonce: w.key(),
    operations: [{ op: "insert_markdown", markdown: "Original passage." }],
  });
  assert.equal(insert.status, 200, JSON.stringify(insert.body));
  const after = (await w.call("owner", "read_page", { project_id: project.project_id })).body;
  const inserted = after.blocks.find((block) => block.markdown.includes("Original passage."));
  const patch = {
    page_id: project.document_id,
    revision: after.revision,
    nonce: w.key(),
    operations: [
      {
        op: "replace_match",
        node_id: inserted.node_id,
        match_text: "Original",
        replacement: "Updated",
      },
    ],
  };
  const patched = await w.call("owner", "edit_page", patch);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const replay = await w.call("owner", "edit_page", alias(patch, project.project_id));
  assert.deepEqual(replay.body, {
    ...patched.body,
    kind: "project",
    project_id: project.project_id,
  });
  const changes = await w.call("owner", "read_page_changes", {
    project_id: project.project_id,
    since_revision: before.revision,
  });
  assert.equal(changes.status, 200, JSON.stringify(changes.body));
  assert.equal(changes.body.project_id, project.project_id);
  const comment = {
    page_id: project.document_id,
    action: "add",
    node_id: block,
    body: "One comment",
    nonce: w.key(),
  };
  const commented = await w.call("owner", "manage_page_comment", comment);
  assert.equal(commented.status, 200, JSON.stringify(commented.body));
  assert.deepEqual(
    (await w.call("owner", "manage_page_comment", alias(comment, project.project_id))).body,
    { ...commented.body, kind: "project", project_id: project.project_id },
  );
  assert.equal(
    (await w.call("owner", "list_page_comments", { project_id: project.project_id })).status,
    200,
  );
  assert.equal(
    (await w.call("owner", "read_page_presence", { project_id: project.project_id })).status,
    200,
  );
  const progress = await w.call("owner", "report_page_progress", {
    project_id: project.project_id,
    message: "Checking content",
  });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.equal(
    (
      await w.call("owner", "report_page_progress", {
        project_id: project.project_id,
        progress_id: progress.body.progress_id,
        lease_token: progress.body.lease_token,
        clear: true,
      })
    ).status,
    200,
  );
});

test("content mapping endpoints reject caller credentials and public HTTP routes", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const paths = [
    [
      w.projects.get(project.project_id),
      "/internal/space/content",
      { space_id: project.project_id },
    ],
    [
      w.catalog(),
      "/internal/location",
      { project_content: project.project_id, page_id: project.document_id },
    ],
    [
      w.page(project.document_id),
      "/internal/content-target",
      { page_id: project.document_id, owner: w.owner },
    ],
  ];
  for (const [host, path, body] of paths) {
    const request = new Request(`https://pages.invalid${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
      body: JSON.stringify(body),
    });
    assert.equal((await host.fetch(request.clone())).status, 404, path);
    assert.equal((await worker.fetch(request, w.env)).status, 404, path);
  }
});

test("revocation during alias resolution is enforced by final Page admission", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  assert.equal((await grant(w, project, "editor")).status, 200);
  const host = w.projects.get(project.project_id);
  const fetch = host.fetch.bind(host);
  t.mock.method(host, "fetch", async (request) => {
    const response = await fetch(request);
    if (new URL(request.url).pathname === "/internal/space/content") {
      assert.equal((await grant(w, project, null, false, 1)).status, 200);
    }
    return response;
  });
  const result = await w.call("member", "edit_page", {
    project_id: project.project_id,
    revision: await w.revision(project.document_id),
    nonce: w.key(),
    operations: [{ op: "set_title", title: "Denied" }],
  });
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(w.page(project.document_id).handle.doc().title, "Launch");
});

test("Project file imports preserve Page asset identity and recheck edit access", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  const objects = new Map();
  w.env.PAGES_ASSETS = {
    async head(key) {
      return objects.get(key) ?? null;
    },
    async put(key, bytes, options) {
      assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
      const object = { key, size: bytes.length, ...options };
      objects.set(key, object);
      return object;
    },
  };
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  let downloads = 0;
  let revokeOnDownload = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).startsWith("https://files.oaiusercontent.com/")) {
      downloads++;
      assert.equal(options.headers.authorization, undefined);
      if (revokeOnDownload) assert.equal((await grant(w, project, null, false, 2)).status, 200);
      return new Response(png, { headers: { "content-type": "image/png" } });
    }
    return w.auth.fetch(url, options);
  });
  const file = { download_url: "https://files.oaiusercontent.com/fixture", file_id: "fixture" };
  const first = await w.call("owner", "create_page_asset_upload", {
    project_id: project.project_id,
    file,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.page_id, project.document_id);
  assert.equal(first.body.kind, "project");
  assert.equal(first.body.project_id, project.project_id);
  assert.equal(
    first.body.asset_url,
    `/api/pages/${project.document_id}/assets/${first.body.asset_id}`,
  );
  const replay = await w.call("owner", "create_page_asset_upload", {
    page_id: project.document_id,
    file,
  });
  assert.equal(replay.status, 200);
  const { kind: _kind, project_id: _project, ...asset } = first.body;
  assert.deepEqual(replay.body, asset);
  assert.equal(objects.size, 1);
  assert.equal((await grant(w, project, "commenter")).status, 200);
  assert.equal(
    (await w.call("member", "create_page_asset_upload", { project_id: project.project_id, file }))
      .status,
    403,
  );
  assert.equal(downloads, 2, "commenter cannot start a download");
  assert.equal((await grant(w, project, "editor", false, 1)).status, 200);
  revokeOnDownload = true;
  assert.equal(
    (await w.call("member", "create_page_asset_upload", { project_id: project.project_id, file }))
      .status,
    403,
  );
  assert.equal(downloads, 3);
  assert.equal(objects.size, 1);
});

test("membership removal never removes an independent direct content grant", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  writableContent(w, project);
  assert.equal((await grant(w, project, "editor")).status, 200);
  assert.equal((await grant(w, project, "viewer", true)).status, 200);
  assert.equal(
    (await w.call("member", "read_page", { project_id: project.project_id })).status,
    200,
  );
  assert.equal((await grant(w, project, null, false, 1)).status, 200);
  // No longer a Project reader: the selector is closed, the direct grant isn't.
  assert.equal(
    (await w.call("member", "read_page", { project_id: project.project_id })).status,
    404,
  );
  const result = await w.call("member", "read_page", { page_id: project.document_id });
  assert.equal(result.status, 200);
  assert.equal(result.body.kind, "page");
  assert.equal(
    (
      await w.call("member", "edit_page", {
        page_id: project.document_id,
        revision: result.body.revision,
        nonce: w.key(),
        operations: [{ op: "set_title", title: "Denied" }],
      })
    ).status,
    403,
  );
  assert.equal(w.page(project.document_id).projectAccess.revision, 2);
});

test("reply_page_comment takes the content selector too", () => {
  assert.ok(PROJECT_CONTENT_OPERATIONS.has("reply_page_comment"));
});

test("reading content by project_id never claims a member's pending invitation", async (t) => {
  const w = await world(t);
  const project = await w.createProject();
  assert.equal((await grant(w, project, "viewer")).status, 200);
  const invited = await w.call("owner", "manage_project_access", {
    project_id: project.project_id,
    action: "invite",
    email: "fixture@example.invalid",
    role: "editor",
    expected_revision: 1,
    nonce: w.key(),
  });
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  const storage = w.projects.get(project.project_id).ctx.storage;
  const before = await storage.get("space/record");
  for (const address of [{ project_id: project.project_id }, { page_id: project.document_id }]) {
    const read = await w.call("member", "read_page", address);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.kind, "project");
  }
  assert.deepEqual(await storage.get("space/record"), before, "no claim, no ACL change");
});
