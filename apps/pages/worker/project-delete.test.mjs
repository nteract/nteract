// delete_project through the gateway, over real Catalog, Project and Page
// hosts (projects-fixture.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { newCommentsDoc } from "../model/comments-test-support.mjs";
import { stampFeatures } from "../model/schema-features.mjs";
import { commentsDocumentId } from "./comments-store.mjs";
import { imageAssetKey } from "./image-assets.mjs";
import { world } from "./projects-fixture.mjs";

/** Private asset storage that lists and deletes like R2. */
class Bucket {
  objects = new Map();
  async put(key, bytes) {
    this.objects.set(key, { key, size: bytes.length });
    return this.objects.get(key);
  }
  async head(key) {
    return this.objects.get(key) ?? null;
  }
  async get(key) {
    return this.objects.get(key) ?? null;
  }
  async delete(keys) {
    for (const key of [keys].flat()) this.objects.delete(key);
  }
  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.values()].filter((object) => object.key.startsWith(prefix));
    return { objects, truncated: false };
  }
}

const missingProject = () => `prj_${crypto.randomUUID()}`;

/** The Projects fixture stubs native transport; give the content host
 * mutable handles so tool edits land (as project-content.test.mjs does). */
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

/** A Project with an editor and a pending invitation, and an uploaded asset
 * on its content. */
async function sharedProject(t) {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  w.env.PAGES_ASSETS = new Bucket();
  const project = await w.createProject("Retiring", "Old plans.");
  const share = (args) =>
    w.call("owner", "manage_project_access", {
      project_id: project.project_id,
      idempotency_key: w.key(),
      ...args,
    });
  assert.equal(
    (await share({ action: "set_role", principal: w.member, role: "editor", expected_revision: 0 }))
      .status,
    200,
  );
  const invited = await share({
    action: "invite",
    email: "someone@example.invalid",
    role: "viewer",
    expected_revision: 1,
  });
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  await w.env.PAGES_ASSETS.put(
    imageAssetKey(project.document_id, "a".repeat(64)),
    new Uint8Array(3),
  );
  return { w, project };
}

const preview = async (w, projectId, who = "owner") =>
  w.call(who, "delete_project", { project_id: projectId, action: "preview" });

async function confirm(w, projectId, token, key = w.key(), who = "owner") {
  return w.call(who, "delete_project", {
    project_id: projectId,
    action: "confirm",
    preview_token: token,
    idempotency_key: key,
  });
}

test("the owner deletes an empty Project, and every read answers as for one that never existed", async (t) => {
  const { w, project } = await sharedProject(t);
  const { project_id: projectId, document_id: documentId } = project;
  const content = w.page(documentId);
  // The fixture's host never loads its comments document; a booted host
  // knows it from its record.
  content.commentsUuid ??= content.metadata.comments_doc;
  const deletedDocuments = [];
  content.repo.delete = async (id) => void deletedDocuments.push(id);
  assert.deepEqual(
    (await w.call("member", "list_projects")).body.projects.map((entry) => entry.project_id),
    [projectId],
  );

  const previewed = await preview(w, projectId);
  assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
  assert.equal(previewed.body.project_id, projectId);
  assert.equal(previewed.body.title, "Retiring");
  assert.deepEqual(
    previewed.body.collaborators.map(({ principal, role }) => [principal, role]),
    [[w.member, "editor"]],
  );
  assert.equal(previewed.body.pending_invitations, 1);
  assert.equal(previewed.body.comment_count, 0);
  assert.deepEqual(previewed.body.heads, w.heads(documentId));
  assert.match(previewed.body.preview_token, /^pp1\./);

  const key = w.key();
  const deleted = await confirm(w, projectId, previewed.body.preview_token, key);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { project_id: projectId, deleted: true });
  // An exact retry replays the receipt once the Project is gone.
  assert.deepEqual(await confirm(w, projectId, previewed.body.preview_token, key), deleted);

  // Every read of the Project answers exactly as for one that never existed.
  const missing = missingProject();
  for (const who of ["owner", "member"])
    for (const [operation, args] of [
      ["get_project", (id) => ({ project_id: id })],
      ["read_page", (id) => ({ project_id: id, include_content: false })],
      ["list_pages", (id) => ({ project_id: id })],
      ["get_project_access", (id) => ({ project_id: id })],
      ["delete_project", (id) => ({ project_id: id, action: "preview" })],
    ]) {
      const gone = await w.call(who, operation, args(projectId));
      const never = await w.call(who, operation, args(missing));
      assert.equal(gone.status, 404, `${who} ${operation}: ${JSON.stringify(gone.body)}`);
      assert.deepEqual(gone, never, `${who} ${operation}`);
    }
  for (const who of ["owner", "member"])
    assert.deepEqual((await w.call(who, "list_projects")).body.projects, [], who);

  // The Space object, the owner's entries and the member's hint are gone.
  assert.equal(w.projects.get(projectId).ctx.storage.values.size, 0);
  const owned = w.catalogStorage();
  assert.equal(await owned.get(`space/${projectId}`), undefined);
  assert.equal(await owned.get(`page/${documentId}`), undefined);
  assert.equal(await owned.get(`host/deleted/${documentId}`), true);
  assert.equal(await w.catalogStorage(w.member).get(`project-discovery/${projectId}`), undefined);
  // D1 holds neither its invitation nor its listing row.
  const rows = async (sql) => (await w.db.prepare(sql).bind(projectId).all()).results;
  assert.deepEqual(await rows("SELECT * FROM pages_project_invitations WHERE project_id = ?"), []);
  assert.deepEqual(await rows("SELECT * FROM pages_catalog_spaces WHERE space_id = ?"), []);

  // The content and comments documents, and the content's upload, are gone.
  assert.equal(content.metadata.deleted, true);
  assert.ok(content.metadata.purged);
  assert.deepEqual(deletedDocuments, [
    content.metadata.documentId,
    commentsDocumentId(content.metadata.comments_doc),
  ]);
  assert.deepEqual([...w.env.PAGES_ASSETS.objects.keys()], []);
  // By its own ID the content document reads as a purged Page does.
  const memberRead = await w.call("member", "read_page", { page_id: documentId });
  const neverPage = await w.call("member", "read_page", { page_id: crypto.randomUUID() });
  assert.equal(memberRead.status, 404);
  assert.equal(memberRead.body.error, neverPage.body.error);
  await w.settle();
});

test("only the owner may delete a Project; a member and a stranger are refused", async (t) => {
  const { w, project } = await sharedProject(t);
  const token = (await preview(w, project.project_id)).body.preview_token;
  for (const action of ["preview", "confirm"]) {
    const member = await w.call("member", "delete_project", {
      project_id: project.project_id,
      action,
      ...(action === "confirm" && { preview_token: token, idempotency_key: w.key() }),
    });
    assert.equal(member.status, 403, JSON.stringify(member.body));
    assert.deepEqual(member.body, {
      error: "Only the Project owner can delete it",
      code: "access_denied",
    });
    const stranger = await w.call("stranger", "delete_project", {
      project_id: project.project_id,
      action,
      ...(action === "confirm" && { preview_token: token, idempotency_key: w.key() }),
    });
    assert.equal(stranger.status, 404);
    assert.deepEqual(stranger.body, { error: "Project not found", code: "project_not_found" });
  }
  // A read-only key is refused before anything runs.
  assert.equal((await preview(w, project.project_id, "reader")).status, 403);
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).status,
    200,
  );
});

test("a Project with a live Page or only a trashed Page is refused with project_not_empty", async (t) => {
  const w = await world(t);
  const live = await w.createProject("Live");
  const top = (await w.createPage({ title: "Top", project_id: live.project_id })).body;
  await w.createPage({ title: "Nested", parent_id: top.page_id });
  const trashed = await w.createProject("Trashed");
  const only = (await w.createPage({ title: "Only", project_id: trashed.project_id })).body;
  const list = await w.call("owner", "list_pages", {});
  const trash = await w.call("owner", "delete_page", {
    page_id: only.page_id,
    retry_token: list.body.retry_token,
    idempotency_key: list.body.retry_key_prefix + crypto.randomUUID(),
  });
  assert.equal(trash.status, 200, JSON.stringify(trash.body));
  for (const project of [live, trashed]) {
    const previewed = await preview(w, project.project_id);
    assert.equal(previewed.status, 409);
    assert.equal(previewed.body.code, "project_not_empty");
    assert.match(previewed.body.error, /Move them out of the Project/);
  }
  // A confirm with a token from before the Page arrived is refused too, and
  // nothing changes: the Page and the Project stay.
  const later = await w.createProject("Later");
  const token = (await preview(w, later.project_id)).body.preview_token;
  const page = (await w.createPage({ title: "Arrived", project_id: later.project_id })).body;
  const key = w.key();
  const refused = await confirm(w, later.project_id, token, key);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "project_not_empty");
  assert.equal(await w.catalogStorage().get(key), undefined, "the key is free again");
  assert.equal(
    (await w.call("owner", "get_project", { project_id: later.project_id })).status,
    200,
  );
  assert.equal((await w.call("owner", "read_page", { page_id: page.page_id })).status, 200);
});

test("confirm refuses a stale, edited, foreign or forged preview and changes nothing", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Guarded");
  const other = await w.createProject("Other");
  const projectId = project.project_id;
  writableContent(w, project);
  const intact = async () => {
    assert.equal((await w.call("owner", "get_project", { project_id: projectId })).status, 200);
    assert.deepEqual(
      (await w.call("owner", "list_projects")).body.projects
        .map((entry) => entry.project_id)
        .sort(),
      [projectId, other.project_id].sort(),
    );
  };
  const refusedWith = async (token, pattern) => {
    const refused = await confirm(w, projectId, token);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "purge_preview_invalid");
    assert.match(refused.body.error, pattern);
    await intact();
  };

  // The Project's record changed after the preview.
  const stale = (await preview(w, projectId)).body.preview_token;
  const updated = await w.call("owner", "update_project", {
    project_id: projectId,
    title: "Guarded v2",
    expected_revision: 0,
    idempotency_key: w.key(),
  });
  assert.equal(updated.status, 200);
  await refusedWith(stale, /changed after its preview/);

  // Its content changed after the preview.
  const before = (await preview(w, projectId)).body.preview_token;
  const read = (await w.call("owner", "read_page", { project_id: projectId })).body;
  const edited = await w.call("owner", "edit_page", {
    project_id: projectId,
    base_heads: read.heads,
    retry_token: read.retry_token,
    idempotency_key: read.retry_key_prefix + crypto.randomUUID(),
    operations: [{ op: "insert_markdown", markdown: "A late note." }],
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  await refusedWith(before, /changed after its preview/);

  // Another Project's preview, and a token that was never issued.
  await refusedWith(
    (await preview(w, other.project_id)).body.preview_token,
    /Invalid preview_token/,
  );
  await refusedWith("pp1.forged.token", /Invalid preview_token/);

  const required = await w.call("owner", "delete_project", {
    project_id: projectId,
    action: "confirm",
    idempotency_key: w.key(),
  });
  assert.equal(required.status, 400);
  assert.equal(required.body.code, "purge_preview_required");

  // A fresh preview still deletes it.
  const fresh = (await preview(w, projectId)).body.preview_token;
  assert.equal((await confirm(w, projectId, fresh)).status, 200);
});

test("a content write that lands after the Space closes reopens it and refuses the deletion", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Racing");
  writableContent(w, project);
  const token = (await preview(w, project.project_id)).body.preview_token;
  const projects = w.env.PROJECTS;
  let raced = false;
  w.env.PROJECTS = {
    getByName(id) {
      const host = projects.getByName(id);
      return {
        async fetch(request, init) {
          const step =
            new URL(request.url).pathname === "/internal/space/delete" &&
            (await request.clone().json()).step;
          const response = await host.fetch(request, init);
          if (step === "close" && !raced) {
            raced = true;
            // The owner still owns the content document and writes to it.
            const read = (await w.call("owner", "read_page", { page_id: project.document_id }))
              .body;
            const edit = await w.call("owner", "edit_page", {
              page_id: project.document_id,
              base_heads: read.heads,
              retry_token: read.retry_token,
              idempotency_key: read.retry_key_prefix + crypto.randomUUID(),
              operations: [{ op: "insert_markdown", markdown: "Written mid-deletion." }],
            });
            assert.equal(edit.status, 200, JSON.stringify(edit.body));
          }
          return response;
        },
      };
    },
  };
  const key = w.key();
  const refused = await confirm(w, project.project_id, token, key);
  assert.ok(raced);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "purge_preview_invalid");
  assert.match(refused.body.error, /content changed after its preview/);
  // The Space reopened, the Catalog shows it again, and the key is free.
  assert.equal(await w.catalogStorage().get(key), undefined);
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).status,
    200,
  );
  assert.equal((await w.call("owner", "list_projects")).body.projects.length, 1);
  const reread = await w.call("owner", "read_page", { project_id: project.project_id });
  assert.equal(reread.status, 200);
  assert.match(JSON.stringify(reread.body), /Written mid-deletion/);
});

test("a deletion interrupted after the Space closes resumes on retry and replays after that", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Interrupted");
  const projectId = project.project_id;
  const token = (await preview(w, projectId)).body.preview_token;
  // The content's Trash applies, then its answer is lost.
  const pages = w.env.PAGES;
  let lose = true;
  w.env.PAGES = {
    getByName(id) {
      const host = pages.getByName(id);
      return {
        async fetch(request, init) {
          const response = await host.fetch(request, init);
          if (lose && new URL(request.url).pathname === "/internal/trash") {
            lose = false;
            return Response.json({ error: "Lost response" }, { status: 500 });
          }
          return response;
        },
      };
    },
  };
  const key = w.key();
  const interrupted = await confirm(w, projectId, token, key);
  assert.equal(interrupted.status, 503, JSON.stringify(interrupted.body));
  // Nothing reports success, and the Project already reads as missing.
  const intent = await w.catalogStorage().get(`host/operation/${key}`);
  assert.equal(intent.pending, true);
  assert.equal(intent.phase, "space_closed");
  assert.equal(w.page(project.document_id).metadata.deleted, true, "the content is in Trash");
  assert.equal((await w.call("owner", "get_project", { project_id: projectId })).status, 404);
  assert.deepEqual((await w.call("owner", "list_projects")).body.projects, []);
  // A different key cannot start a second deletion.
  assert.equal((await preview(w, projectId)).status, 404);

  const resumed = await confirm(w, projectId, token, key);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.deepEqual(resumed.body, { project_id: projectId, deleted: true });
  assert.equal(w.page(project.document_id).metadata.purged !== undefined, true);
  assert.equal(w.projects.get(projectId).ctx.storage.values.size, 0);
  assert.deepEqual(await confirm(w, projectId, token, key), resumed);
  // The same key with another payload is a conflict, not a new deletion.
  const conflict = await confirm(w, projectId, `${token}x`, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
});

test("a deletion interrupted before its receipt resumes from the Space removal", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Almost");
  const projectId = project.project_id;
  const token = (await preview(w, projectId)).body.preview_token;
  w.faults.set(projectId, "before");
  // The fault answers the first Space request: the close. Nothing changed.
  const key = w.key();
  assert.equal((await confirm(w, projectId, token, key)).status, 503);
  assert.equal((await w.catalogStorage().get(`host/operation/${key}`)).phase, "reserved");
  assert.equal((await w.call("owner", "get_project", { project_id: projectId })).status, 200);
  // The retry closes the Space; then the removal's answer is lost.
  const projects = w.env.PROJECTS;
  let lose = true;
  w.env.PROJECTS = {
    getByName(id) {
      const host = projects.getByName(id);
      return {
        async fetch(request, init) {
          const step =
            new URL(request.url).pathname === "/internal/space/delete" &&
            (await request.clone().json()).step;
          const response = await host.fetch(request, init);
          if (step !== "delete" || !lose) return response;
          lose = false;
          return Response.json({ error: "Lost response" }, { status: 500 });
        },
      };
    },
  };
  assert.equal((await confirm(w, projectId, token, key)).status, 503);
  assert.equal((await w.catalogStorage().get(`host/operation/${key}`)).phase, "catalog_forgotten");
  const done = await confirm(w, projectId, token, key);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { project_id: projectId, deleted: true });
});

test("delete_project over MCP previews, confirms and maps project_id", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Over MCP");
  const previewed = await w.mcp("owner", "delete_project", {
    project_id: project.project_id,
    action: "preview",
  });
  assert.equal(previewed.isError, false, JSON.stringify(previewed.body));
  assert.equal(previewed.body.project_id, project.project_id);
  assert.equal(previewed.body.space_id, undefined);
  const deleted = await w.mcp("owner", "delete_project", {
    project_id: project.project_id,
    action: "confirm",
    preview_token: previewed.body.preview_token,
    idempotency_key: w.key(),
  });
  assert.equal(deleted.isError, false, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { project_id: project.project_id, deleted: true });
});
