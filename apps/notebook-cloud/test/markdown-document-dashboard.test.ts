import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudMarkdownDocumentOpenUrl,
  cloudMarkdownDocumentOpenUrlWithMode,
  cloudMarkdownDocumentUrlOnCurrentOrigin,
  type CloudMarkdownDocumentListItem,
} from "../viewer/markdown-document-dashboard";

describe("cloud Markdown document dashboard projection", () => {
  it("opens hosted Markdown document paths on the current browser origin", () => {
    assert.equal(
      cloudMarkdownDocumentUrlOnCurrentOrigin(
        "https://preview.runt.run/m/doc-123/Research%20Plan",
        { browserOrigin: "http://127.0.0.1:45540" },
      ),
      "/m/doc-123/Research%20Plan",
    );
  });

  it("keeps unrelated external URLs external", () => {
    assert.equal(
      cloudMarkdownDocumentUrlOnCurrentOrigin("https://example.com/docs/research", {
        browserOrigin: "http://127.0.0.1:45540",
      }),
      "https://example.com/docs/research",
    );
  });

  it("normalizes listed Markdown documents with the same route rule", () => {
    const document = markdownDocument({
      viewerUrl: "https://preview.runt.run/m/doc-456/Shared%20Notes#heading",
    });

    assert.equal(
      cloudMarkdownDocumentOpenUrl(document, { browserOrigin: "http://localhost:45540" }),
      "/m/doc-456/Shared%20Notes?mode=edit#heading",
    );
  });

  it("opens editable Markdown documents ready for source editing", () => {
    const owner = markdownDocument({
      scope: "owner",
      viewerUrl: "https://preview.runt.run/m/owner-doc/Owner%20Notes?mode=view#section-a",
    });
    const editor = markdownDocument({
      scope: "editor",
      viewerUrl: "https://preview.runt.run/m/editor-doc/Editor%20Notes",
    });
    const viewer = markdownDocument({
      scope: "viewer",
      viewerUrl: "https://preview.runt.run/m/viewer-doc/Viewer%20Notes?mode=edit",
    });

    assert.equal(
      cloudMarkdownDocumentOpenUrl(owner, { browserOrigin: "http://localhost:45540" }),
      "/m/owner-doc/Owner%20Notes?mode=edit#section-a",
    );
    assert.equal(
      cloudMarkdownDocumentOpenUrl(editor, { browserOrigin: "http://localhost:45540" }),
      "/m/editor-doc/Editor%20Notes?mode=edit",
    );
    assert.equal(
      cloudMarkdownDocumentOpenUrl(viewer, { browserOrigin: "http://localhost:45540" }),
      "/m/viewer-doc/Viewer%20Notes?mode=view",
    );
  });

  it("can force newly-created Markdown documents into edit mode", () => {
    assert.equal(
      cloudMarkdownDocumentOpenUrlWithMode("https://preview.runt.run/m/new-doc/New%20Doc", "edit", {
        browserOrigin: "http://localhost:45540",
      }),
      "/m/new-doc/New%20Doc?mode=edit",
    );
  });
});

function markdownDocument({
  scope = "owner",
  viewerUrl,
}: {
  scope?: CloudMarkdownDocumentListItem["scope"];
  viewerUrl: string;
}): CloudMarkdownDocumentListItem {
  return {
    body_doc_id: "doc-456",
    created_at: "2026-06-15T00:00:00.000Z",
    document_id: "doc-456",
    endpoints: { catalog: "/api/m/doc-456" },
    latest_revision_id: null,
    owner_principal: "user:dev:alice",
    scope,
    title: "Shared Notes",
    updated_at: "2026-06-15T00:00:00.000Z",
    viewer_url: viewerUrl,
  };
}
