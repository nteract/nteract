import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("cloud notebook body renders through the desktop NotebookView surface", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /from "\.\.\/\.\.\/notebook\/src\/components\/NotebookView"/);
  assert.match(sourceText, /<NotebookView[\s\S]*cellIds=\{notebookCellIds\}/);
  assert.match(sourceText, /readOnly=\{!canEditMarkdown\}/);
  assert.doesNotMatch(sourceText, /import \{ CloudLiveNotebook \}/);
  assert.doesNotMatch(sourceText, /<CloudLiveNotebook/);
  assert.doesNotMatch(sourceText, /NotebookReadOnlyView/);
  assert.doesNotMatch(sourceText, /<NotebookReadOnlyView/);
});

test("cloud projects live cells into the NotebookView stores", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /projectCloudCellsIntoNotebookViewStores\(cells\)/);
  assert.match(sourceText, /<CrdtBridgeProvider[\s\S]*getHandle=\{getLiveNotebookHandle\}/);
  assert.match(sourceText, /onSourceChanged=\{handleMarkdownSourceChange\}/);
});

test("cloud package rail renders package metadata through the shared shell panel", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookPackageSummaryPanel/);
  assert.match(sourceText, /<NotebookDocumentRail[\s\S]*viewModel=\{notebookViewModel\}/);
  assert.match(sourceText, /packages=\{notebookViewModel\.packages\}/);
  assert.doesNotMatch(sourceText, /Package details are not surfaced/);
});

test("cloud rail binds through the shared document rail adapter", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookDocumentRail/);
  assert.match(sourceText, /<NotebookDocumentRail[\s\S]*viewModel=\{notebookViewModel\}/);
  assert.doesNotMatch(sourceText, /<NotebookRail[\s>]/);
});

test("cloud viewer shell uses the shared notebook rail as an adapter surface", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookDocumentRail/);
  assert.match(sourceText, /createNotebookViewModel\(cells/);
  assert.match(sourceText, /<NotebookDocumentRail[\s\S]*viewModel=\{notebookViewModel\}/);
  assert.match(sourceText, /onNavigateOutlineItem=\{handleNavigateOutlineItem\}/);
  assert.match(sourceText, /navigateNotebookOutlineItem\(item, href/);
  assert.doesNotMatch(sourceText, /findCellElement: \(outlineItem\)/);
});

test("cloud live materialization skips empty room handles before resolving outputs", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /const rawCellCount = liveRuntime\.handle\.cell_count\(\);/);
  assert.match(
    sourceText,
    /if \(rawCellCount === 0 && \(!snapshotResolvedRef\.current \|\| cellsRef\.current\.length > 0\)\) \{\s+return;\s+\}\s+const materialized = await materializeCloudNotebookView/,
  );
});

test("cloud viewer shell keeps render endpoints out of the interactive load path", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.doesNotMatch(sourceText, /renderEndpoint/);
  assert.doesNotMatch(sourceText, /pinnedRenderBasePath/);
  assert.doesNotMatch(sourceText, /api\/n\/[^"`']+\/render/);
});
