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
      nonce: w.key(),
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
    nonce: key,
  });
}

test("the owner deletes an empty Project, and every read answers as for one that never existed", async (t) => {
  const { w, project } = await sharedProject(t);
  const { project_id: projectId, document_id: documentId } = project;
  writableContent(w, project);
  const content = w.page(documentId);
  // The fixture's host never boots, so it doesn't learn its comments
  // document from its record as a booted host does.
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
  // The preview names no content heads: its token binds the content it saw.
  assert.equal(previewed.body.heads, undefined);
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
  // D1 holds neither its invitation nor its listing row. The Space removed
  // the invitation rows; the listing row went when the owner's list_projects
  // above rewrote pages_catalog_spaces from the Catalog's entries, as the
  // deletion marked them dirty.
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
      ...(action === "confirm" && { preview_token: token, nonce: w.key() }),
    });
    assert.equal(member.status, 403, JSON.stringify(member.body));
    assert.deepEqual(member.body, {
      error: "Only the Project owner can delete it",
      code: "access_denied",
    });
    const stranger = await w.call("stranger", "delete_project", {
      project_id: project.project_id,
      action,
      ...(action === "confirm" && { preview_token: token, nonce: w.key() }),
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
  const trash = await w.call("owner", "delete_page", {
    page_id: only.page_id,
    nonce: crypto.randomUUID(),
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
  assert.equal(await w.receipt(key), undefined, "the key is free again");
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
    nonce: w.key(),
  });
  assert.equal(updated.status, 200);
  await refusedWith(stale, /changed after its preview/);

  // Its content changed after the preview.
  const before = (await preview(w, projectId)).body.preview_token;
  const read = (await w.call("owner", "read_page", { project_id: projectId })).body;
  const edited = await w.call("owner", "edit_page", {
    project_id: projectId,
    revision: read.revision,
    nonce: crypto.randomUUID(),
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
    nonce: w.key(),
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
              revision: read.revision,
              nonce: crypto.randomUUID(),
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
  assert.match(refused.body.error, /content or its comments changed after its preview/);
  // The Space reopened, the Catalog shows it again, and the key is free.
  assert.equal(await w.receipt(key), undefined);
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
  const intent = await w.receipt(key);
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
  assert.equal(conflict.body.code, "nonce_conflict");
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
  assert.equal((await w.receipt(key)).phase, "reserved");
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
  assert.equal((await w.receipt(key)).phase, "catalog_forgotten");
  const done = await confirm(w, projectId, token, key);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { project_id: projectId, deleted: true });
});

/** The owner comments on the Project's content by its document ID, which
 * still works while the Space is closed. */
async function comment(w, project, body) {
  const added = await w.call("owner", "manage_page_comment", {
    page_id: project.document_id,
    action: "add",
    block_id: Object.keys(w.page(project.document_id).handle.doc().blocks)[0],
    body,
    nonce: w.key(),
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
}

test("a comment added after the preview refuses the confirm and changes nothing", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Discussed");
  writableContent(w, project);
  const before = (await preview(w, project.project_id)).body;
  assert.equal(before.comment_count, 0);
  await comment(w, project, "Wait, keep this");
  const key = w.key();
  const refused = await confirm(w, project.project_id, before.preview_token, key);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "purge_preview_invalid");
  assert.equal(await w.receipt(key), undefined);
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).status,
    200,
  );
  const after = (await preview(w, project.project_id)).body;
  assert.equal(after.comment_count, 1);
  assert.equal((await confirm(w, project.project_id, after.preview_token)).status, 200);
});

test("a comment added after the Space closes reopens it and refuses the deletion", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Late comment");
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
            await comment(w, project, "Landed mid-deletion");
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
  assert.match(refused.body.error, /content or its comments changed/);
  assert.equal(await w.receipt(key), undefined);
  assert.equal(
    w.page(project.document_id).metadata.deleted,
    false,
    "the content stays out of Trash",
  );
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).status,
    200,
  );
  const comments = await w.call("owner", "list_page_comments", { project_id: project.project_id });
  assert.match(JSON.stringify(comments.body), /Landed mid-deletion/);
});

/** A deletion whose content Trash applied and whose answer was lost: the
 * content is in Trash and the intent waits at space_closed. */
async function interruptedAfterTrash(t, title) {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject(title);
  const token = (await preview(w, project.project_id)).body.preview_token;
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
  assert.equal((await confirm(w, project.project_id, token, key)).status, 503);
  assert.equal(w.page(project.document_id).metadata.deleted, true, "the content is in Trash");
  const guarded = () => ({ nonce: crypto.randomUUID() });
  return { w, project, token, key, guarded };
}

test("restore_page can't take a Project's content back out of an interrupted deletion", async (t) => {
  const { w, project, token, key, guarded } = await interruptedAfterTrash(t, "No restore");
  const restored = await w.call("owner", "restore_page", {
    page_id: project.document_id,
    ...guarded(),
  });
  assert.equal(restored.status, 409, JSON.stringify(restored.body));
  assert.equal(restored.body.code, "project_content_protected");
  assert.equal(w.page(project.document_id).metadata.deleted, true, "still in Trash");
  const done = await confirm(w, project.project_id, token, key);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { project_id: project.project_id, deleted: true });
});

test("purge_page can't delete a Project's content outside its deletion", async (t) => {
  const { w, project, token, key, guarded } = await interruptedAfterTrash(t, "No purge");
  const previewed = await w.call("owner", "purge_page", {
    page_id: project.document_id,
    action: "preview",
  });
  assert.equal(previewed.status, 409, JSON.stringify(previewed.body));
  assert.equal(previewed.body.code, "project_content_protected");
  const purged = await w.call("owner", "purge_page", {
    page_id: project.document_id,
    action: "confirm",
    preview_token: "pp1.any.token",
    ...guarded(),
  });
  assert.equal(purged.status, 409, JSON.stringify(purged.body));
  assert.equal(purged.body.code, "project_content_protected");
  assert.equal(w.page(project.document_id).metadata.purged, undefined, "not purged");
  const done = await confirm(w, project.project_id, token, key);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(w.page(project.document_id).metadata.purged);
});

/** The content host as a host booted on a record whose documents this build
 * doesn't write: it holds the record and opens neither document. A null
 * `documentFormats` is a record with no stamp. Returns the documents the
 * host opens from then on. */
async function unopenedContent(w, project, documentFormats) {
  const host = w.page(project.document_id);
  const { documentFormats: _stamp, ...unstamped } = host.metadata;
  host.metadata = documentFormats === null ? unstamped : { ...unstamped, documentFormats };
  await host.ctx.storage.put("host/document", host.metadata);
  host.handle = undefined;
  host.commentsHandle = undefined;
  host.commentsUuid ??= host.metadata.comments_doc;
  const opened = [];
  host.repo.import = async (_bytes, { docId } = {}) => {
    opened.push(docId);
    throw new Error("A refused record's document was opened");
  };
  return { host, opened };
}

// A record in a format this build doesn't write: a newer one, the format
// before this build's, or one written before records carried a stamp. The
// last two are how page10's Projects from before format 3 are cleared.
const UNOPENED_FORMATS = {
  "a newer format": { "pages.page": 99, "pages.comments": 1 },
  "pages.page 2": { "pages.page": 2, "pages.comments": 1 },
  "no stamp": null,
};

for (const [name, documentFormats] of Object.entries(UNOPENED_FORMATS))
  test(`the owner deletes a Project whose content record has ${name}, from its record`, async (t) => {
    await deleteUnopened(t, documentFormats);
  });

async function deleteUnopened(t, documentFormats) {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Old format");
  const { host, opened } = await unopenedContent(w, project, documentFormats);
  const read = await w.call("owner", "read_page", { project_id: project.project_id });
  assert.equal(read.status, 409);
  assert.equal(read.body.code, "document_format_unsupported");

  const previewed = await preview(w, project.project_id);
  assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
  // Nothing read the content, so the preview reports no discussion.
  assert.equal(previewed.body.heads, undefined);
  assert.equal(previewed.body.comment_count, null);
  assert.equal(previewed.body.comment_threads, null);
  assert.match(previewed.body.preview_token, /^pp1\./);

  const key = w.key();
  const deleted = await confirm(w, project.project_id, previewed.body.preview_token, key);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { project_id: project.project_id, deleted: true });
  assert.ok(host.metadata.purged);
  assert.deepEqual(opened, [], "no path opened the content");
  assert.equal(host.handle, undefined);
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).status,
    404,
  );
  assert.deepEqual(
    await confirm(w, project.project_id, previewed.body.preview_token, key),
    deleted,
  );
}

test("a content record that opens after the preview refuses the deletion and reopens", async (t) => {
  const w = await world(t);
  t.mock.method(console, "info", () => {});
  const project = await w.createProject("Opened later");
  const formats = { ...w.page(project.document_id).metadata.documentFormats };
  const handle = w.page(project.document_id).handle;
  const { host } = await unopenedContent(w, project, { "pages.page": 99, "pages.comments": 1 });
  const token = (await preview(w, project.project_id)).body.preview_token;
  // A build that writes the record's format opens it between the close and
  // the trash: the token bound a record nothing could change, and the trash
  // refuses because the host now opens the documents.
  const projects = w.env.PROJECTS;
  let opened = false;
  w.env.PROJECTS = {
    getByName(id) {
      const target = projects.getByName(id);
      return {
        async fetch(request, init) {
          const step =
            new URL(request.url).pathname === "/internal/space/delete" &&
            (await request.clone().json()).step;
          const response = await target.fetch(request, init);
          if (step === "close" && !opened) {
            opened = true;
            host.metadata = { ...host.metadata, documentFormats: formats };
            host.handle = handle;
          }
          return response;
        },
      };
    },
  };
  const key = w.key();
  const refused = await confirm(w, project.project_id, token, key);
  assert.ok(opened);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "purge_preview_invalid");
  assert.equal(host.metadata.deleted, false, "the content stays out of Trash");
  assert.equal(await w.receipt(key), undefined);
  assert.equal(
    (await w.call("owner", "get_project", { project_id: project.project_id })).status,
    200,
  );
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
    nonce: w.key(),
  });
  assert.equal(deleted.isError, false, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { project_id: project.project_id, deleted: true });
});

test("delete_project keeps its receipt under the caller's account", async (t) => {
  const w = await world(t);
  const project = await w.createProject("Keyed");
  const previewed = await preview(w, project.project_id);
  const nonce = crypto.randomUUID();
  const args = {
    project_id: project.project_id,
    action: "confirm",
    preview_token: previewed.body.preview_token,
    nonce,
  };
  const deleted = await w.call("owner", "delete_project", args);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  // The receipt sits under the account's key, not under the bare nonce,
  // and an exact retry replays it.
  const owned = w.catalogStorage();
  assert.equal(await owned.get(`host/operation/${nonce}`), undefined);
  assert.equal((await w.receipt(nonce)).pending, false);
  assert.deepEqual(await w.call("owner", "delete_project", args), deleted);
  // A nonce outside the pattern is refused before any work.
  const malformed = await w.call("owner", "delete_project", {
    ...args,
    nonce: `v1_${"a".repeat(64)}_${nonce}`,
  });
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  assert.equal(malformed.body.code, "invalid_nonce");
});
