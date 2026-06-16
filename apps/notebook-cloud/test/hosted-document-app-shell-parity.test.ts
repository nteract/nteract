import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const notebookListSource = readViewerModule("notebook-list-view.tsx");
const markdownListSource = readViewerModule("markdown-document-list-view.tsx");
const markdownDocumentRouteSource = readViewerModule("markdown-document-route.tsx");
const workerSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

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

  it("keeps Markdown sharing copy active instead of publish-version oriented", () => {
    assert.match(markdownListSource, /Draft, review, and share Markdown without compute\./);
    assert.doesNotMatch(markdownListSource, /publish Markdown/i);
    assert.doesNotMatch(markdownListSource, /public version/i);
  });

  it("routes Markdown edit requests through the shared cloud edit chrome", () => {
    assert.match(markdownDocumentRouteSource, /CloudNotebookEditModeButton/);
    assert.match(markdownDocumentRouteSource, /shouldLoadOwnCloudAccessRequest/);
    assert.match(markdownDocumentRouteSource, /shouldUseCloudCatalogBootstrap/);
    assert.match(markdownDocumentRouteSource, /projectCloudAccessRequestNotice/);
    assert.match(markdownDocumentRouteSource, /onRequestEditAccess=\{requestMarkdownEditAccess\}/);
    assert.doesNotMatch(markdownDocumentRouteSource, /<MarkdownDocumentModeToggle/);
  });

  it("keeps dashboard profile sync off the first HTML response path", () => {
    assert.match(workerSource, /function scheduleStoredAppSessionProfileSync/);
    assert.match(workerSource, /ctx\.waitUntil\(syncStoredAppSessionProfile\(env, session\)\)/);
    assert.match(
      workerSource,
      /async function notebookListBootstrap\([\s\S]*scheduleStoredAppSessionProfileSync\(env, ctx, session\);[\s\S]*listNotebooksForPrincipal/,
    );
    assert.match(
      workerSource,
      /async function markdownDocumentListBootstrap\([\s\S]*scheduleStoredAppSessionProfileSync\(env, ctx, session\);[\s\S]*listMarkdownDocumentsForPrincipal/,
    );
  });
});

function readViewerModule(name: string): string {
  return readFileSync(new URL(`../viewer/${name}`, import.meta.url), "utf8");
}
