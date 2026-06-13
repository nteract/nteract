import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { viewerCorpus, viewerFileContaining } from "./viewer-source-corpus";

test("cloud notebook body renders through the desktop NotebookView surface", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /from "\.\.\/\.\.\/notebook\/src\/notebook-surface"/);
  assert.match(sourceText, /<NotebookView[\s\S]*cellIds=\{notebookCellIds\}/);
  assert.match(sourceText, /<NotebookView[\s\S]*capabilities=\{shellCapabilities\}/);
  assert.match(sourceText, /<NotebookView[\s\S]*canAcceptCellMutations=\{canAcceptCellMutations\}/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/components\/NotebookView/);
  assert.doesNotMatch(sourceText, /canAcceptCellMutations=\{false\}/);
  assert.doesNotMatch(sourceText, /readOnly=\{!canEditMarkdown\}/);
  assert.doesNotMatch(sourceText, /import \{ CloudLiveNotebook \}/);
  assert.doesNotMatch(sourceText, /<CloudLiveNotebook/);
  assert.doesNotMatch(sourceText, /NotebookReadOnlyView/);
  assert.doesNotMatch(sourceText, /<NotebookReadOnlyView/);
});

test("cloud viewer imports desktop notebook code only through public surfaces", () => {
  const viewerDir = new URL("../viewer", import.meta.url);
  const offenders: string[] = [];

  for (const fileName of readdirSync(viewerDir)) {
    if (![".ts", ".tsx"].includes(extname(fileName))) continue;
    const sourcePath = join(viewerDir.pathname, fileName);
    const sourceText = readFileSync(sourcePath, "utf8");
    const imports = sourceText.matchAll(
      /from\s+["']([^"']*\.\.\/\.\.\/notebook\/src\/[^"']+)["']/g,
    );

    for (const match of imports) {
      const importPath = match[1] ?? "";
      if (
        importPath.includes("/wasm/") ||
        importPath.endsWith("/notebook-surface") ||
        // Headless store surface: same public symbols, no component/CSS
        // imports, so node-run tests can exercise the bridge directly.
        importPath.endsWith("/notebook-surface-stores")
      ) {
        continue;
      }
      offenders.push(`${fileName}: ${importPath}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "cloud viewer should use the public notebook surface, not private desktop internals",
  );
});

test("cloud projects live cells into the NotebookView stores", () => {
  const sourceText = viewerCorpus;
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");

  assert.doesNotMatch(
    sessionSourceText,
    /useLayoutEffect\(\(\) => \{[\s\S]*projectCloudCellsIntoNotebookViewStores\(cells\);/,
  );
  assert.match(
    sessionSourceText,
    /const applyResolvedCells = useCallback\(\s*\(resolvedCells: ResolvedCell\[\]\) => \{[\s\S]*projectCloudCellsIntoNotebookViewStores\(resolvedCells\);[\s\S]*setCells\(resolvedCells\);/,
  );
  assert.match(sessionSourceText, /applyResolvedCells\(syncCells\);/);
  assert.match(sessionSourceText, /applyResolvedCells\(progressiveCells\);/);
  assert.match(sessionSourceText, /applyResolvedCells\(resolvedCells\);/);
  assert.match(sourceText, /<CrdtBridgeProvider[\s\S]*getHandle=\{getLiveNotebookHandle\}/);
  assert.match(sourceText, /<CrdtBridgeProvider[\s\S]*canWriteSource=\{canWriteCellSource\}/);
  assert.match(sourceText, /<CrdtBridgeProvider[\s\S]*onSyncNeeded=\{handleSourceSyncNeeded\}/);
  assert.match(sourceText, /const cell = getCellById\(cellId\);/);
  assert.match(sourceText, /cell\.cell_type === "markdown"/);
  assert.match(sourceText, /return shellCapabilities\.canEditMarkdown/);
  assert.match(sourceText, /return shellCapabilities\.canEditCells/);
  assert.match(
    sourceText,
    /if \(!shellCapabilities\.canEditCells && !shellCapabilities\.canEditMarkdown\) return;/,
  );
  assert.doesNotMatch(sourceText, /cellsByIdRef/);
  assert.doesNotMatch(sourceText, /handleMarkdownSyncNeeded/);
  assert.doesNotMatch(sourceText, /onSourceChanged=/);
});

test("cloud live changesets gate stale post-await status writes", () => {
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");

  assert.match(
    sessionSourceText,
    /const materializeLiveCells = async[\s\S]*\+\+materializeSequence/,
  );
  assert.match(
    sessionSourceText,
    /const materializeLiveChangeset = async[\s\S]*const sequence = materializeSequence;[\s\S]*await materializeChangeset[\s\S]*if \(disposed \|\| sequence !== materializeSequence\) return;[\s\S]*applyExecutionViewChangeset/,
  );
});

test("cloud notebook mutations route through the shared notebook controller", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /createNotebookController/);
  assert.match(sourceText, /const cloudNotebookController = useMemo/);
  assert.match(sourceText, /cloudNotebookController\.addCell\(type, afterCellId\)/);
  assert.match(sourceText, /cloudNotebookController\.deleteCell\(cellId\)/);
  assert.match(sourceText, /cloudNotebookController\.moveCell\(cellId, afterCellId\)/);
  assert.match(sourceText, /cloudNotebookController\.setCellSourceHidden\(cellId, hidden\)/);
  assert.match(sourceText, /cloudNotebookController\.setCellOutputsHidden\(cellId, hidden\)/);
  assert.doesNotMatch(sourceText, /liveRuntime\.handle\.add_cell_after/);
  assert.doesNotMatch(sourceText, /liveRuntime\.handle\.delete_cell/);
  assert.doesNotMatch(sourceText, /liveRuntime\.handle\.move_cell/);
});

test("cloud command toolbar inserts below the focused cell before falling back to the tail", () => {
  const sourceText = viewerCorpus;

  assert.match(
    sourceText,
    /const toolbarAddAfterCellId =\s+focusedCellId \?\? notebookCellIds\[notebookCellIds\.length - 1\] \?\? null;/,
  );
  assert.match(
    sourceText,
    /<NotebookDocumentToolbar[\s\S]*commandToolbar=\{\{[\s\S]*addAfterCellId: toolbarAddAfterCellId/,
  );
});

test("cloud routes cell focus through the shared store, not a host React shadow", () => {
  const sourceText = viewerCorpus;

  // Focus is read from the shared cell-ui-state store, and the host holds no
  // React copy. Programmatic focus the controller drives (focus-after-add) is
  // written through the shared setter with a synchronous flush.
  assert.match(sourceText, /const focusedCellId = useFocusedCellId\(\)/);
  assert.match(sourceText, /const focusCellInStore = useCallback/);
  assert.match(sourceText, /setFocusedCellId\(id\);\s*flushCellUIState\(\);/);
  assert.match(sourceText, /onFocusCell: focusCellInStore/);

  // NotebookView owns the interaction-target write for user focus
  // (publishInteractionTarget carries the real cell/editor/output kind), so the
  // host passes it a no-op rather than double-writing a transient { kind: "cell" }.
  assert.match(sourceText, /const handleNotebookViewFocus = useCallback\(\(\) => \{\}, \[\]\)/);
  assert.match(sourceText, /onFocusCell=\{handleNotebookViewFocus\}/);
  assert.doesNotMatch(sourceText, /onFocusCell=\{focusCellInStore\}/);

  // No host React shadow of focus, and no per-host UI-state bridge double-buffer.
  assert.doesNotMatch(sourceText, /\[focusedCellId, setFocusedCellId\] = useState/);
  assert.doesNotMatch(sourceText, /useNotebookCellUIStateBridge/);
  assert.doesNotMatch(
    sourceText,
    /import \{[^}]*setFocusedCellId[^}]*\} from "\.\.\/\.\.\/notebook\/src\/lib\/cell-ui-state"/,
  );
});

test("cloud passes shared NotebookView source and output visibility handlers", () => {
  const sourceText = viewerCorpus;

  assert.match(
    sourceText,
    /<NotebookView[\s\S]*onSetCellSourceHidden=\{handleCloudSetCellSourceHidden\}/,
  );
  assert.match(
    sourceText,
    /<NotebookView[\s\S]*onSetCellOutputsHidden=\{handleCloudSetCellOutputsHidden\}/,
  );
  assert.match(
    sourceText,
    /<NotebookView[\s\S]*deferOutputIsolatedFramesUntilVisible=\{!shellCapabilities\.canEditCells\}/,
  );
  assert.match(
    sourceText,
    /<NotebookView[\s\S]*deferredOutputIsolatedFrameRootMargin=\{CLOUD_VIEWER_OUTPUT_IFRAME_ROOT_MARGIN\}/,
  );
  assert.match(sourceText, /const CLOUD_VIEWER_OUTPUT_IFRAME_ROOT_MARGIN = "400px 0px";/);
});

test("cloud wires shared presence and cleans projected store entries", () => {
  const sourceText = viewerCorpus;
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");
  const bridgeSourcePath = new URL("../viewer/notebook-view-store-bridge.ts", import.meta.url);
  const bridgeSourceText = readFileSync(bridgeSourcePath, "utf8");

  assert.match(sourceText, /PresenceValueProvider/);
  assert.match(sourceText, /from "\.\.\/\.\.\/notebook\/src\/notebook-surface"/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/contexts\/PresenceContext/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/hooks\/useCrdtBridge/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/lib\/cursor-registry/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/lib\/logger/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/lib\/notebook-frame-bus/);
  assert.match(sourceText, /sendCursorPresence\(cellId, line, column\)/);
  assert.match(
    sourceText,
    /sendSelectionPresence\(\s+cellId,\s+anchorLine,\s+anchorCol,\s+headLine,\s+headCol,/,
  );
  assert.match(sourceText, /sendInteractionPresence\(target\)/);
  assert.match(sessionSourceText, /resetCloudViewStoreProjection/);
  assert.match(bridgeSourceText, /@\/components\/notebook\/state\/cell-store/);
  assert.match(bridgeSourceText, /@\/components\/notebook\/state\/execution-store/);
  assert.match(bridgeSourceText, /@\/components\/notebook\/state\/output-store/);
  assert.doesNotMatch(bridgeSourceText, /\.\.\/\.\.\/notebook\/src\/lib\/notebook-cells/);
  assert.doesNotMatch(bridgeSourceText, /\.\.\/\.\.\/notebook\/src\/lib\/notebook-executions/);
  assert.doesNotMatch(bridgeSourceText, /\.\.\/\.\.\/notebook\/src\/lib\/notebook-outputs/);
  assert.match(bridgeSourceText, /deleteOutputs\(difference\(cloudOwnedOutputIds/);
  assert.match(bridgeSourceText, /deleteExecutions\(difference\(cloudOwnedExecutionIds/);
});

test("cloud package rail renders package metadata through the shared shell panel", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /NotebookPackageSummaryPanel/);
  assert.match(sourceText, /<NotebookDocumentRail[\s\S]*viewModel=\{notebookViewModel\}/);
  assert.match(sourceText, /packages=\{notebookViewModel\.packages\}/);
  assert.doesNotMatch(sourceText, /Package details are not surfaced/);
});

test("cloud package rail stays package-only and leaves sync/env state to app chrome", () => {
  const sourceText = viewerCorpus;

  assert.match(
    sourceText,
    /<NotebookPackageSummaryPanel[\s\S]*readOnly=\{!shellCapabilities\.canManagePackages\}/,
  );
  assert.doesNotMatch(sourceText, /NotebookEnvironmentSummary/);
  assert.doesNotMatch(sourceText, /createNotebookEnvironmentSurface/);
  assert.doesNotMatch(sourceText, /syncLabel: connectionScope/);
  assert.doesNotMatch(sourceText, /Live sync connected/);
});

test("cloud workstation registry state lives in the workstation manager hook", () => {
  const sourceText = viewerFileContaining("export function NotebookViewer");
  const hookSourcePath = new URL("../viewer/use-cloud-workstations.ts", import.meta.url);
  const hookSourceText = readFileSync(hookSourcePath, "utf8");

  assert.match(sourceText, /useCloudWorkstationManager/);
  assert.match(sourceText, /cloudBrowserCanUseAuthenticatedApi/);
  assert.match(
    sourceText,
    /canLoadCloudWorkstations:\s*canUseAuthenticatedCloudApi,\s*capabilities: shellCapabilities/,
  );
  assert.match(sourceText, /selection=\{workstationSelection\}/);
  assert.match(sourceText, /busyWorkstationId=\{busyWorkstationId\}/);
  assert.match(sourceText, /onAttachWorkstation=\{onAttachWorkstation\}/);
  assert.match(sourceText, /onSetDefaultWorkstation=\{onSetDefaultWorkstation\}/);
  assert.doesNotMatch(sourceText, /fetchCloudWorkstations/);
  assert.doesNotMatch(sourceText, /setCloudDefaultWorkstation/);
  assert.doesNotMatch(sourceText, /requestCloudWorkstationAttachment/);
  assert.doesNotMatch(sourceText, /projectNotebookWorkstationSelection/);
  assert.doesNotMatch(sourceText, /cloudWorkstationRefreshIntervalMs/);
  assert.match(hookSourceText, /fetchCloudWorkstations/);
  assert.match(hookSourceText, /setCloudDefaultWorkstation/);
  assert.match(hookSourceText, /requestCloudWorkstationAttachment/);
  assert.match(hookSourceText, /projectNotebookWorkstationSelection/);
  assert.match(hookSourceText, /projectNotebookWorkstationLaunchReadiness/);
  assert.match(hookSourceText, /cloudWorkstationRefreshIntervalMs/);
});

test("cloud identity chrome renders through the shared actor projection surface", () => {
  const sourcePath = new URL("../viewer/shell-capabilities.ts", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /notebookActorProjectionFromAccess/);
  assert.match(sourceText, /notebookActorProjectionFromRuntime/);
  assert.match(sourceText, /const accessActor = notebookActorProjectionWithPrincipalImage/);
  assert.match(sourceText, /actor: accessActor/);
  assert.match(sourceText, /actor: runtimeActor/);
});

test("cloud presence chrome renders as an isolated host avatar stack", () => {
  const sourceText = viewerCorpus;
  const presenceSourcePath = new URL("../viewer/cloud-presence-status.tsx", import.meta.url);
  const presenceSourceText = readFileSync(presenceSourcePath, "utf8");
  const hostedSmokePath = new URL("../scripts/hosted-render-smoke.mjs", import.meta.url);
  const hostedSmokeText = readFileSync(hostedSmokePath, "utf8");
  const collabSmokePath = new URL("../scripts/hosted-collab-smoke.mjs", import.meta.url);
  const collabSmokeText = readFileSync(collabSmokePath, "utf8");

  assert.match(presenceSourceText, /CloudViewerPresenceStore/);
  assert.match(
    presenceSourceText,
    /useSyncExternalStore\(store\.subscribe, store\.getSnapshot, store\.getSnapshot\)/,
  );
  assert.match(presenceSourceText, /<AvatarGroup className="cloud-presence-avatar-group"/);
  assert.match(presenceSourceText, /data-slot="cloud-presence-stack"/);
  assert.match(hostedSmokeText, /\[data-slot='cloud-presence-stack'\]/);
  assert.match(collabSmokeText, /\[data-slot='cloud-presence-stack'\]/);
  assert.doesNotMatch(sourceText, /NotebookPresenceStatus/);
  assert.doesNotMatch(presenceSourceText, /NotebookPresenceStatus/);
  assert.doesNotMatch(sourceText, /compactCloudPresenceLabel/);
  assert.doesNotMatch(presenceSourceText, /compactCloudPresenceLabel/);
  assert.doesNotMatch(hostedSmokeText, /notebook-presence-status/);
  assert.doesNotMatch(collabSmokeText, /notebook-presence-status/);
});

test("cloud edit mode chrome renders through the shared shell component", () => {
  const sourceText = viewerFileContaining("export function NotebookViewer");
  const authControlsSourcePath = new URL("../viewer/cloud-auth-controls.tsx", import.meta.url);
  const authControlsSourceText = readFileSync(authControlsSourcePath, "utf8");
  const shellHookSourcePath = new URL("../viewer/use-cloud-shell-capabilities.ts", import.meta.url);
  const shellHookSourceText = readFileSync(shellHookSourcePath, "utf8");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");

  assert.match(sourceText, /useCloudShellCapabilities/);
  assert.match(authControlsSourceText, /NotebookEditModeButton/);
  assert.match(
    authControlsSourceText,
    /<NotebookEditModeButton[\s\S]*mode=\{accessPending \? "view" : interaction\.selectedMode\}/,
  );
  assert.match(
    authControlsSourceText,
    /<NotebookEditModeButton[\s\S]*state=\{accessPending \? "viewing" : interaction\.state\}/,
  );
  assert.match(authControlsSourceText, /<NotebookEditModeButton[\s\S]*variant="segmented"/);
  assert.match(authControlsSourceText, /onModeChange=\{\(mode\) => \{/);
  assert.match(sourceText, /accessLevel=\{shellCapabilities\.access\.level\}/);
  assert.doesNotMatch(sourceText, /projectCloudNotebookEditAccess/);
  assert.doesNotMatch(sourceText, /cloudNotebookShellCapabilities/);
  assert.match(shellHookSourceText, /projectCloudNotebookEditAccess/);
  assert.match(shellHookSourceText, /cloudNotebookShellCapabilities/);
  assert.match(shellHookSourceText, /selectedMode/);
  assert.match(shellHookSourceText, /editAccessRequestPending/);
  assert.match(sourceText, /onModeChange=\{setSelectedInteractionMode\}/);
  assert.match(sourceText, /onRequestEditAccess=\{requestCloudEditAccess\}/);
  assert.match(shellHookSourceText, /const editAccessPending = roomEditAccess\.editAccessPending/);
  assert.doesNotMatch(sourceText, /appliedGrantedEditScopeRef/);
  assert.doesNotMatch(sourceText, /requestedEditAccess/);
  assert.doesNotMatch(
    sourceText,
    /setSelectedInteractionMode\("edit"\);[\s\S]*\[canAcceptCellMutations, connectionPeerId, connectionScope/,
  );
  assert.match(sourceText, /accessPending=\{editAccessPending\}/);
  assert.match(authControlsSourceText, /state=\{accessPending \? "viewing" : interaction\.state\}/);
  assert.match(authControlsSourceText, /disabled=\{accessPending\}/);
  assert.match(
    authControlsSourceText,
    /const canSwitchToEdit = accessLevel === "editor" \|\| accessLevel === "owner"/,
  );
  assert.match(authControlsSourceText, /editLabel=\{editLabel\}/);
  assert.match(authControlsSourceText, /editTitle=\{editTitle\}/);
  assert.match(
    sourceText,
    /const showCloudCommandToolbar = shouldShowNotebookDocumentCommandToolbar\(shellCapabilities, \{[\s\S]*reserve: editAccessPending,[\s\S]*\}\)/,
  );
  assert.match(sourceText, /reserveCommandToolbar=\{editAccessPending\}/);
  assert.match(sourceText, /addCellControlsDisabled: editAccessPending/);
  assert.match(sourceText, /runtimeStatus: cloudRuntimeStatus/);
  assert.match(sourceText, /onStartRuntime: handleCloudStartRuntime/);
  assert.match(sourceText, /onInterruptRuntime: handleCloudInterruptRuntime/);
  assert.match(sourceText, /onRestartRuntime: handleCloudRestartRuntime/);
  assert.match(sourceText, /onRunAllCells: handleCloudRunAllCells/);
  assert.match(sourceText, /onRestartAndRunAll: handleCloudRestartAndRunAll/);
  assert.doesNotMatch(sourceText, /CloudNotebookEditModePlaceholder/);
  assert.doesNotMatch(sourceText, /CloudNotebookCommandToolbarPlaceholder/);
  assert.doesNotMatch(cssText, /cloud-edit-mode-placeholder/);
  assert.doesNotMatch(cssText, /cloud-command-toolbar-placeholder/);
  assert.match(authControlsSourceText, /if \(mode === "edit" && !canSwitchToEdit\) \{/);
  assert.match(sourceText, /storeCloudRequestedScope\(window\.localStorage, "editor"\)/);
  assert.doesNotMatch(sourceText, /mode === "edit" \? "editor" : NOTEBOOK_CLOUD_DEFAULT_SCOPE/);
  assert.doesNotMatch(sourceText, /className="cloud-scope-toggle-button"/);
  assert.doesNotMatch(cssText, /cloud-scope-toggle-button/);
});

test("cloud rail binds through the shared document rail adapter", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /NotebookDocumentRail/);
  assert.match(sourceText, /<NotebookDocumentRail[\s\S]*viewModel=\{notebookViewModel\}/);
  assert.doesNotMatch(sourceText, /<NotebookRail[\s>]/);
});

test("cloud host notices sit in the shared shell above the rail and notebook stage", () => {
  const sourceText = viewerCorpus;
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");
  const shellPath = new URL(
    "../../../src/components/notebook/NotebookDocumentShell.tsx",
    import.meta.url,
  );
  const shellText = readFileSync(shellPath, "utf8");

  assert.match(sourceText, /const hasNotices =/);
  assert.match(sourceText, /const noticeStatus: ViewerStatus =/);
  assert.match(
    sourceText,
    /notebookViewIsLoading && \(status\.kind === "ready" \|\| status\.kind === "empty"\)[\s\S]*Preparing notebook view/,
  );
  assert.match(sourceText, /const notices = hasNotices \? \(/);
  assert.match(sourceText, /notices=\{notices\}/);
  assert.match(sourceText, /noticesClassName="cloud-notebook-notices"/);
  assert.match(sourceText, /cloud-notebook-shell--command-toolbar/);
  assert.match(cssText, /\.cloud-notebook-shell \{[\s\S]*position: relative;/);
  assert.match(cssText, /\.cloud-notebook-shell \{[\s\S]*--cloud-notice-top: 3\.75rem;/);
  assert.match(
    cssText,
    /\.cloud-notebook-shell--command-toolbar \{[\s\S]*--cloud-notice-top: calc\(3\.75rem \+ 2\.5rem\);/,
  );
  assert.match(cssText, /\.cloud-notebook-notices \{[\s\S]*position: absolute;/);
  assert.match(cssText, /\.cloud-notebook-notices \{[\s\S]*top: var\(--cloud-notice-top\);/);
  assert.match(
    cssText,
    /@media \(max-width: 900px\) \{[\s\S]*\.cloud-notebook-shell \{[\s\S]*--cloud-notice-top: 3\.75rem;[\s\S]*\.cloud-notebook-shell--command-toolbar \{[\s\S]*--cloud-notice-top: calc\(3\.75rem \+ 2\.5rem\);/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 900px\) \{[\s\S]*\.cloud-room-toolbar \{[\s\S]*flex-wrap: nowrap;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 900px\) \{[\s\S]*\.cloud-room-toolbar \[data-slot="notebook-document-header-controls"\] \{[\s\S]*justify-content: flex-end;/,
  );
  assert.match(
    shellText,
    /data-slot="notebook-document-notices"[\s\S]*data-slot="notebook-document-body"[\s\S]*\{rail\}[\s\S]*data-slot="notebook-document-stage"/,
  );
});

test("cloud viewer shell uses the shared notebook rail as an adapter surface", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /NotebookDocumentRail/);
  assert.match(sourceText, /useNotebookViewModel\(/);
  assert.doesNotMatch(sourceText, /createNotebookViewModel\(\s+cells/);
  assert.doesNotMatch(sourceText, /useSourceVersion\(\)/);
  assert.match(sourceText, /<NotebookDocumentRail[\s\S]*viewModel=\{notebookViewModel\}/);
  assert.match(sourceText, /onNavigateOutlineItem=\{handleNavigateOutlineItem\}/);
  assert.match(
    sourceText,
    /navigateNotebookOutlineItem\(item, href, \{ headingHashTarget: "cell" \}\)/,
  );
  assert.doesNotMatch(sourceText, /findCellElement: \(outlineItem\)/);
});

test("cloud outline keeps iframe heading hashes at parent cell anchors", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /const handledHeadingHashRef = useRef<string \| null>\(null\)/);
  assert.match(sourceText, /const headingAnchorId = decodeHashAnchorId\(hash\)/);
  assert.match(
    sourceText,
    /candidate\.headingAnchorId !== null && candidate\.headingAnchorId === headingAnchorId/,
  );
  assert.match(
    sourceText,
    /navigateNotebookOutlineItem\(item, hash, \{\s+behavior: "auto",\s+headingHashTarget: "cell",\s+\}\)/,
  );
});

test("cloud live materialization skips empty room handles before resolving outputs", () => {
  const sourceText = viewerCorpus;
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");

  assert.match(sourceText, /const CLOUD_EMPTY_ROOM_GRACE_MS = 900;/);
  assert.match(sourceText, /const \[emptyRoomGraceElapsed, setEmptyRoomGraceElapsed\]/);
  assert.match(
    sourceText,
    /status\.kind === "empty" && notebookCellIds\.length === 0 && !emptyRoomGraceElapsed/,
  );
  assert.match(sessionSourceText, /const rawCellCount = liveRuntime\.handle\.cell_count\(\);/);
  // The zero-cell guard routes through the displacement policy: a painted
  // notebook blocks the empty apply only until the handle has caught up to
  // the room (see instant-paint.test.ts for the policy matrix).
  assert.match(
    sessionSourceText,
    /if \(rawCellCount === 0 && !mayShowEmptyLiveNotebook\(liveRuntime\)\) \{\s+return;\s+\}/,
  );
});

test("cloud live cell changes use serialized incremental materialization", () => {
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");

  assert.match(
    sessionSourceText,
    /import \{ subscribeSerializedCloudCellChanges \} from "\.\/serialized-cell-changes";/,
  );
  assert.match(sessionSourceText, /subscribeSerializedCloudCellChanges\(\{/);
  assert.match(sessionSourceText, /cellChanges\$: liveRuntime\.engine\.cellChanges\$/);
  assert.match(sessionSourceText, /materializeChangeset\(changeset, \{/);
  assert.match(sessionSourceText, /blobResolver,/);
  assert.doesNotMatch(
    sessionSourceText,
    /cellChanges\$\s*\.subscribe\(\(\) => materializeLiveCellsSafely/,
  );
});

test("cloud viewer shell keeps render endpoints out of the interactive load path", () => {
  const sourceText = viewerCorpus;

  assert.doesNotMatch(sourceText, /renderEndpoint/);
  assert.doesNotMatch(sourceText, /pinnedRenderBasePath/);
  assert.doesNotMatch(sourceText, /api\/n\/[^"`']+\/render/);
});

test("hosted smoke waits for shared NotebookView cell markers", () => {
  const sourcePath = new URL("../scripts/hosted-render-smoke.mjs", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /\[data-slot='cell-container'\], \[data-cell-id\]/);
  assert.doesNotMatch(sourceText, /read-only-report-cell/);
});

test("hosted live room smoke can exercise the shared history shortcut", () => {
  const sourcePath = new URL("../scripts/hosted-live-room-smoke.mjs", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NOTEBOOK_CLOUD_LIVE_ROOM_CHECK_HISTORY/);
  assert.match(sourceText, /NOTEBOOK_CLOUD_LIVE_ROOM_CHECK_COMPLETION/);
  assert.match(sourceText, /NOTEBOOK_CLOUD_LIVE_ROOM_AUTH/);
  assert.match(sourceText, /authMode === "anonymous"/);
  assert.match(sourceText, /assertAuthMode/);
  assert.match(sourceText, /page\.keyboard\.press\("Control\+R"\)/);
  assert.match(sourceText, /page\.keyboard\.press\("Control\+Space"\)/);
  assert.match(sourceText, /Search history\.\.\./);
  assert.match(sourceText, /notebookHostErrorVisible/);
  assert.match(sourceText, /socketCloseWarnings/);
  assert.match(sourceText, /isRecoverableSocketCloseConsoleMessage/);
});

test("cloud app-session bridge refreshes cookie-backed state after OIDC exchange", () => {
  const sourceText = viewerCorpus;
  const routeSourcePath = new URL("../viewer/notebook-list-view.tsx", import.meta.url);
  const routeSourceText = readFileSync(routeSourcePath, "utf8");
  const authSourcePath = new URL("../viewer/use-cloud-auth.ts", import.meta.url);
  const authSourceText = readFileSync(authSourcePath, "utf8");

  assert.match(
    sourceText,
    /useCloudAppSessionBridge\(\s*authState,\s*appSessionStatus\.session,\s*appSessionStatus\.status === "loading",\s*appSessionStatus\.refreshAppSessionStatus,\s*\)/,
  );
  assert.match(
    authSourceText,
    /establishCloudAppSession\(authState\)[\s\S]*\.then\(\(\) => \{[\s\S]*onEstablished\?\.\(\)/,
  );
  assert.match(
    routeSourceText,
    /\[authState, bootstrap, canFetchNotebookList, refreshIndex, waitingForAppSession\]/,
  );
});

test("cloud notebook list refresh re-establishes app sessions before listing notebooks", () => {
  const routeSourcePath = new URL("../viewer/notebook-list-view.tsx", import.meta.url);
  const routeSourceText = readFileSync(routeSourcePath, "utf8");

  assert.match(routeSourceText, /import \{ clearCloudAppSession, establishCloudAppSession \}/);
  assert.match(
    routeSourceText,
    /const refreshList = \(\) => \{[\s\S]*authState\.mode === "oidc" && authState\.token[\s\S]*establishCloudAppSession\(authState\)[\s\S]*appSessionStatus\.refreshAppSessionStatus\(\)[\s\S]*setRefreshIndex/,
    "manual notebook-list refresh should re-run the trusted session exchange so pending invites can resolve",
  );
});

test("cloud notebook list waits for app-session cookies before catalog fetches", () => {
  const sourcePath = new URL("../viewer/notebook-list-view.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(
    sourceText,
    /const canFetchNotebookList = authState\.mode === "dev" \|\| hasAppSession;/,
  );
  assert.match(
    sourceText,
    /if \(!canFetchNotebookList\) \{[\s\S]*if \(waitingForAppSession\) \{[\s\S]*\{ kind: "loading" \}[\s\S]*return;/,
  );
  assert.match(
    sourceText,
    /fetchCloudNotebookList\(authState, controller\.signal\)/,
    "catalog fetch should still use the existing auth helper once the cookie-backed state is ready",
  );
});

test("cloud app-session live sync requests the resolved notebook-list scope", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /async function resolveCloudAppSessionSyncScope/);
  assert.match(sourceText, /new URL\("api\/n\?limit=100"/);
  assert.match(sourceText, /isCloudNotebookListItem\(candidate\)/);
  assert.match(sourceText, /candidate\.notebook_id === notebookId/);
  assert.match(sourceText, /return notebook\.scope/);
  assert.match(sourceText, /return selectedMode === "edit" \? "owner" : "viewer"/);
  assert.match(
    sourceText,
    /const requestedScope = await resolveCloudAppSessionSyncScope\([\s\S]*config\.notebookId,[\s\S]*selectedInteractionMode,[\s\S]*\)/,
  );
  assert.doesNotMatch(
    sourceText,
    /cloudSyncAuthFromAppSessionCookie\(\{[\s\S]*requestedScope: "owner"/,
  );
  assert.doesNotMatch(sourceText, /setSelectedInteractionMode\(selectedInteractionModeForAccess\)/);
});

test("cloud sync keeps routine frame logs out of the browser console", () => {
  const sourcePath = new URL("../viewer/live-sync.ts", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /const consoleSyncLogger = \{[\s\S]*debug: \(\) => \{\}/);
  assert.match(sourceText, /const consoleSyncLogger = \{[\s\S]*info: \(\) => \{\}/);
  assert.match(sourceText, /warn: \(message: string, \.\.\.args: unknown\[\]\) => console\.warn/);
});

test("cloud installs a host logger sink for shared notebook components", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /setLoggerHost/);
  assert.match(sourceText, /debug: \(\) => \{\}/);
  assert.match(sourceText, /info: \(\) => \{\}/);
  assert.match(sourceText, /warn: \(message: string, \.\.\.args: unknown\[\]\) => console\.warn/);
});
