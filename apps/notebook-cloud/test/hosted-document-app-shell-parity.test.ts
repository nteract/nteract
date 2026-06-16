import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const notebookListSource = readViewerModule("notebook-list-view.tsx");
const markdownListSource = readViewerModule("markdown-document-list-view.tsx");

describe("hosted document app-shell parity", () => {
  it("uses the shared auth projection for notebook and Markdown catalog authority", () => {
    for (const sourceText of [notebookListSource, markdownListSource]) {
      assert.match(sourceText, /import \{ projectHostedDocumentAuthState \}/);
      assert.match(sourceText, /const hostedAuth = projectHostedDocumentAuthState\(authState, \{/);
      assert.match(sourceText, /canFetchCatalog: canFetch/);
      assert.match(sourceText, /\bsignedIn,/);
      assert.match(sourceText, /\bwaitingForAppSession,/);
    }
  });

  it("keeps dashboard shell, create, and state primitives shared", () => {
    for (const sourceText of [notebookListSource, markdownListSource]) {
      assert.match(sourceText, /className="cloud-notebook-list-page/);
      assert.match(sourceText, /className="cloud-notebook-list-header"/);
      assert.match(sourceText, /className="cloud-notebook-list-actions"/);
      assert.match(sourceText, /className="cloud-new-notebook-form"/);
      assert.match(sourceText, /className="cloud-notebook-list-content/);
      assert.match(sourceText, /className="cloud-notebook-list-state" data-kind="loading"/);
      assert.match(sourceText, /className="cloud-notebook-list-state" data-kind="error"/);
      assert.match(sourceText, /className="cloud-notebook-list-state" data-kind="empty"/);
    }
  });

  it("uses the shared signed-out panel with route-specific copy", () => {
    assert.match(notebookListSource, /<CloudHostedDocumentSignedOutPanel/);
    assert.match(markdownListSource, /<CloudHostedDocumentSignedOutPanel/);
    assert.match(notebookListSource, /cloudTitle="Bring computation to life\."/);
    assert.match(markdownListSource, /cloudTitle="Write live Markdown\."/);
    assert.match(notebookListSource, /localTitle="Open local notebooks\."/);
    assert.match(markdownListSource, /localTitle="Open local Markdown\."/);
  });

  it("does not force notebook-specific dashboard features onto Markdown documents", () => {
    assert.match(notebookListSource, /<CloudNotebookDashboard/);
    assert.doesNotMatch(markdownListSource, /<CloudNotebookDashboard/);
    assert.doesNotMatch(markdownListSource, /Search notebooks/);
    assert.doesNotMatch(markdownListSource, /recent work/i);
  });
});

function readViewerModule(name: string): string {
  return readFileSync(new URL(`../viewer/${name}`, import.meta.url), "utf8");
}
