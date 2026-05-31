import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("cloud editable markdown cells use shared cell and output rendering surfaces", () => {
  const sourcePath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(
    sourceText,
    /import \{ EditableMarkdownCell as SharedEditableMarkdownCell \} from "@\/components\/cell\/EditableMarkdownCell";/,
  );
  assert.match(sourceText, /<SharedEditableMarkdownCell/);
  assert.match(sourceText, /elementId=\{notebookCellAnchorId\(cell\.id\)\}/);
  assert.match(sourceText, /priority=\{priority\}/);
  assert.match(sourceText, /hostContext=\{hostContext\}/);
  assert.match(sourceText, /editorExtensions=\{editorExtensions\}/);
  assert.doesNotMatch(sourceText, /from "@\/components\/cell\/CellContainer"/);
  assert.doesNotMatch(sourceText, /from "@\/components\/cell\/OutputArea"/);
  assert.doesNotMatch(sourceText, /from "@\/components\/editor\/codemirror-editor"/);
});

test("cloud editable code cells use shared cell and output rendering surfaces", () => {
  const sourcePath = new URL("../viewer/editable-code-cell.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(
    sourceText,
    /import \{ EditableCodeCell as SharedEditableCodeCell \} from "@\/components\/cell\/EditableCodeCell";/,
  );
  assert.match(sourceText, /<SharedEditableCodeCell/);
  assert.match(sourceText, /elementId=\{notebookCellAnchorId\(cell\.id\)\}/);
  assert.match(sourceText, /priority=\{priority\}/);
  assert.match(sourceText, /hostContext=\{hostContext\}/);
  assert.match(sourceText, /editorExtensions=\{editorExtensions\}/);
  assert.match(sourceText, /outputs=\{cell\.outputs\}/);
  assert.doesNotMatch(sourceText, /from "@\/components\/cell\/CellContainer"/);
  assert.doesNotMatch(sourceText, /from "@\/components\/cell\/OutputArea"/);
  assert.doesNotMatch(sourceText, /from "@\/components\/editor\/codemirror-editor"/);
});

test("cloud markdown edit toggle avoids blur and stale-source races", () => {
  const sourcePath = new URL(
    "../../../src/components/cell/EditableMarkdownCell.tsx",
    import.meta.url,
  );
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /editorRef\.current\?\.getEditor\(\)\?\.state\.doc\.toString\(\)/);
  assert.match(sourceText, /suppressNextToggleClickRef/);
  assert.match(sourceText, /onMouseDown=\{handleActionMouseDown\}/);
  assert.match(sourceText, /onClick=\{handleActionClick\}/);
});

test("cloud markdown editor remounts with latest source state", () => {
  const sourcePath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /if \(!editing\) return;\s+applyFullSource\(cell\.source\);/);
  assert.match(sourceText, /cell\.source\.trim\(\)\.length === 0 && !editing/);
});

test("cloud editable cells share hosted CRDT and presence bridge plumbing", () => {
  const sourcePath = new URL("../viewer/cloud-cell-editing.ts", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /createCrdtBridge/);
  assert.match(sourceText, /remoteChangesFromTextAttributions/);
  assert.match(sourceText, /remoteCursorsExtension/);
  assert.match(sourceText, /presenceSenderExtension/);
  assert.match(
    sourceText,
    /onSourceChanged: \(source\) => onSourceChangeRef\.current\(cellId, source\)/,
  );
});

test("cloud editable cells render presence through shared cell dots", () => {
  const adapterPath = new URL("../viewer/cell-presence.tsx", import.meta.url);
  const adapterSource = readFileSync(adapterPath, "utf8");
  const markdownPath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const markdownSource = readFileSync(markdownPath, "utf8");
  const codePath = new URL("../viewer/editable-code-cell.tsx", import.meta.url);
  const codeSource = readFileSync(codePath, "utf8");

  assert.match(
    adapterSource,
    /import \{ CellPresenceDots, type CellPresencePeer \} from "@\/components\/cell\/CellPresenceDots";/,
  );
  assert.match(adapterSource, /<CellPresenceDots peers=\{peers\} maxVisible=\{4\}/);
  assert.match(markdownSource, /presenceIndicators=\{<CloudCellPresenceIndicators/);
  assert.match(codeSource, /presenceIndicators=\{<CloudCellPresenceIndicators/);
});

test("cloud live notebook passes renderer policy into editable markdown cells", () => {
  const sourcePath = new URL("../viewer/cloud-live-notebook.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookEditableView/);
  assert.match(sourceText, /slot="cloud-live-notebook"/);
  assert.match(sourceText, /scrollable/);
  assert.match(sourceText, /viewModel: NotebookViewModel<ResolvedCell>/);
  assert.match(sourceText, /<NotebookEditableView[\s\S]*viewModel=\{viewModel\}/);
  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*priority=\{priority\}/);
  assert.match(sourceText, /<EditableMarkdownCell[\s\S]*hostContext=\{hostContext\}/);
  assert.doesNotMatch(sourceText, /className="cloud-cell/);
  assert.doesNotMatch(sourceText, /sourceClassName="cloud-source-block"/);
  assert.doesNotMatch(sourceText, /outputClassName="cloud-output-block"/);
});

test("cloud live notebook routes editor code cells through the shared editable code adapter", () => {
  const sourcePath = new URL("../viewer/cloud-live-notebook.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /import \{ EditableCodeCell \} from "\.\/editable-code-cell";/);
  assert.match(sourceText, /renderCodeCell=\{\(cell\) => \(/);
  assert.match(sourceText, /<EditableCodeCell[\s\S]*showSource=\{showCode\}/);
  assert.match(sourceText, /<EditableCodeCell[\s\S]*onSourceChange=\{onCellSourceChange\}/);
  assert.match(sourceText, /<EditableCodeCell[\s\S]*onSyncNeeded=\{onCellSyncNeeded\}/);
});

test("cloud editor capability gates all editable cell source writes", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /const canEditCells = shellCapabilities\.canEditCells;/);
  assert.match(sourceText, /if \(!canEditCells\) return;/);
  assert.match(
    sourceText,
    /currentCell\?\.cellType !== "markdown" && currentCell\?\.cellType !== "code"/,
  );
  assert.match(sourceText, /canEditCells \? \(/);
  assert.doesNotMatch(sourceText, /canEditMarkdown \? \(/);
});

test("cloud read-only notebook renders from the shared notebook view model", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookReadOnlyView/);
  assert.match(sourceText, /<NotebookReadOnlyView[\s\S]*viewModel=\{notebookViewModel\}/);
  assert.match(sourceText, /<NotebookReadOnlyView[\s\S]*scrollable/);
  assert.doesNotMatch(sourceText, /cells=\{readOnlyCells\}/);
  assert.doesNotMatch(sourceText, /cellClassName="cloud-cell"/);
  assert.doesNotMatch(sourceText, /sourceClassName="cloud-source-block"/);
  assert.doesNotMatch(sourceText, /outputClassName="cloud-output-block"/);
});

test("cloud editable adapters leave shared cell chrome styling to shared components", () => {
  const markdownPath = new URL("../viewer/editable-markdown-cell.tsx", import.meta.url);
  const markdownSource = readFileSync(markdownPath, "utf8");
  const codePath = new URL("../viewer/editable-code-cell.tsx", import.meta.url);
  const codeSource = readFileSync(codePath, "utf8");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssSource = readFileSync(cssPath, "utf8");

  assert.doesNotMatch(markdownSource, /cloud-markdown-/);
  assert.doesNotMatch(markdownSource, /cloud-source-block/);
  assert.doesNotMatch(codeSource, /cloud-code-editor/);
  assert.doesNotMatch(codeSource, /cloud-source-block/);
  assert.doesNotMatch(codeSource, /cloud-output-block/);
  assert.doesNotMatch(cssSource, /\.cloud-cell\b/);
  assert.doesNotMatch(cssSource, /\.cloud-source-block\b/);
  assert.doesNotMatch(cssSource, /\.cloud-output-block\b/);
});

test("hosted collab smoke uses shared cell selectors instead of cloud cell classes", () => {
  const smokePath = new URL("../scripts/hosted-collab-smoke.mjs", import.meta.url);
  const smokeSource = readFileSync(smokePath, "utf8");

  assert.match(smokeSource, /\[data-slot="cell-container"\]\[data-cell-type="markdown"\]/);
  assert.match(smokeSource, /button\[aria-label="Edit markdown"\]/);
  assert.doesNotMatch(smokeSource, /cloud-editable-markdown-cell/);
  assert.doesNotMatch(smokeSource, /cloud-markdown-cell-action/);
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

test("cloud viewer shell uses the shared host header frame above the rail body", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /header=\{toolbar\}/);
  assert.match(sourceText, /headerClassName="cloud-report-toolbar"/);
  assert.match(sourceText, /bodyClassName="cloud-notebook-body"/);
  assert.doesNotMatch(sourceText, /toolbar=\{toolbar\}/);
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

test("cloud editable notebook opts into the shared stable cell-list DOM order", () => {
  const sourcePath = new URL("../viewer/cloud-live-notebook.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /<NotebookEditableView[\s\S]*stableDomOrder/);
  assert.doesNotMatch(sourceText, /\.map\(\(cell/);
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
