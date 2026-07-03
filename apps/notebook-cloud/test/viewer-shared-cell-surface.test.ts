import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";
import { viewerCorpus, viewerFileContaining } from "./viewer-source-corpus";

test("cloud notebook body renders through the temporary shared NotebookView surface", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /from "\.\.\/\.\.\/notebook\/src\/notebook-surface"/);
  assert.match(sourceText, /<NotebookView[\s\S]*cellIds=\{notebookCellIds\}/);
  assert.match(sourceText, /<NotebookView[\s\S]*capabilities=\{shellCapabilities\}/);
  assert.match(sourceText, /<NotebookView[\s\S]*canAcceptCellMutations=\{canAcceptCellMutations\}/);
  assert.match(
    sourceText,
    /<NotebookView[\s\S]*onRequestExecuteCell=\{[\s\S]*canRequestCloudCellExecution \? handleCloudRequestExecuteCell : undefined[\s\S]*\}/,
  );
  assert.match(
    sourceText,
    /const canRequestCloudCellExecution =[\s\S]*canStartSelectedWorkstation && shellCapabilities\.canEditCells && canAcceptCellMutations/,
  );
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/components\/NotebookView/);
  assert.doesNotMatch(sourceText, /canAcceptCellMutations=\{false\}/);
  assert.doesNotMatch(sourceText, /readOnly=\{!canEditMarkdown\}/);
  assert.doesNotMatch(sourceText, /import \{ CloudLiveNotebook \}/);
  assert.doesNotMatch(sourceText, /<CloudLiveNotebook/);
  assert.doesNotMatch(sourceText, /NotebookReadOnlyView/);
  assert.doesNotMatch(sourceText, /<NotebookReadOnlyView/);
});

test("cloud notebook dashboard search input has stable form metadata", () => {
  const dashboardSourcePath = new URL(
    "../viewer/cloud-notebook-dashboard-view.tsx",
    import.meta.url,
  );
  const dashboardSourceText = readFileSync(dashboardSourcePath, "utf8");

  assert.match(dashboardSourceText, /id="cloud-dashboard-search-input"/);
  assert.match(dashboardSourceText, /name="notebook-search"/);
  assert.match(dashboardSourceText, /type="search"/);
  assert.match(dashboardSourceText, /aria-label="Search notebooks"/);
});

test("cloud notebook list uses local auth copy in local mode", () => {
  const listSourcePath = new URL("../viewer/notebook-list-view.tsx", import.meta.url);
  const listSourceText = readFileSync(listSourcePath, "utf8");

  assert.match(listSourceText, /const localMode = Boolean\(authConfig\.localDev\)/);
  assert.match(listSourceText, /localMode \? "LOCAL MODE" : "NTERACT"/);
  assert.match(
    listSourceText,
    /localMode \? "Open local notebooks\." : "Bring computation to life\."/,
  );
  assert.match(
    listSourceText,
    /Use local auth to create notebooks and test the live room on this machine\./,
  );
  assert.match(listSourceText, /return authConfig\.localDev \? "Local auth" : "Cloud preview"/);
  assert.match(
    listSourceText,
    /return authState\.user \? `Local: \$\{authState\.user\}` : "Local auth"/,
  );
});

test("cloud viewer imports desktop notebook code only through public surfaces", () => {
  const viewerDir = new URL("../viewer", import.meta.url);
  const offenders: string[] = [];
  const allowedSharedNotebookInternals = new Set([
    "../../notebook/src/components/InlineCommentComposer",
    "../../notebook/src/lib/comment-highlights",
    "../../notebook/src/lib/comment-source-anchor",
    "../../notebook/src/lib/frame-pipeline",
  ]);

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
        allowedSharedNotebookInternals.has(importPath)
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
    /useLayoutEffect\(\(\) => \{[\s\S]*projectNotebookCellsIntoViewStores\(cells\);/,
  );
  assert.match(
    sessionSourceText,
    /const applyResolvedCells = useCallback\(\s*\(resolvedCells: ResolvedCell\[\]\) => \{[\s\S]*projectNotebookCellsIntoViewStores\(resolvedCells\);[\s\S]*setCells\(resolvedCells\);/,
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

test("cloud runtime store projection comes from the shared store module", () => {
  const projectionLifecycleSourcePath = new URL(
    "../../../src/components/notebook/state/projection-lifecycle.ts",
    import.meta.url,
  );
  const projectionLifecycleSourceText = readFileSync(projectionLifecycleSourcePath, "utf8");
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");

  assert.match(projectionLifecycleSourceText, /from ["']\.\/runtime-store-projection["']/);
  assert.match(
    sessionSourceText,
    /from ["']@\/components\/notebook\/state\/runtime-store-projection["']/,
  );
  assert.doesNotMatch(projectionLifecycleSourceText, /notebook-surface-stores/);
  assert.doesNotMatch(sessionSourceText, /notebook-surface-stores/);
  assert.doesNotMatch(sessionSourceText, /notebook-view-store-bridge/);

  const notebookSurfaceImports = [
    ...sessionSourceText.matchAll(
      /import\s+{([^}]*)}\s+from\s+["']\.\.\/\.\.\/notebook\/src\/notebook-surface["']/g,
    ),
    ...viewerCorpus.matchAll(
      /import\s+{([^}]*)}\s+from\s+["']\.\.\/\.\.\/notebook\/src\/notebook-surface["']/g,
    ),
  ];
  for (const importMatch of notebookSurfaceImports) {
    const importList = importMatch[1] ?? "";
    assert.doesNotMatch(
      importList,
      /\b(applyExecutionViewChangeset|applyOutputChangeset|resetRuntimeStoresProjection|getCellById|getCellIdsSnapshot|CellChangeset|JupyterOutput|createNotebookCellId|createNotebookController|PresenceValueProvider|PresenceContextValue|CrdtBridgeProvider|startCursorDispatch|emitBroadcast|emitPresence|resetPoolState|setPoolState)\b/,
    );
  }
});

test("cloud notebook mutations route through the shared notebook controller", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /createNotebookController/);
  assert.match(sourceText, /from "@\/components\/notebook"/);
  assert.doesNotMatch(
    sourceText,
    /import\s+{[^}]*createNotebookController[^}]*}\s+from\s+["']\.\.\/\.\.\/notebook\/src\/notebook-surface["']/,
  );
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
  const sourceText = viewerFileContaining("export function NotebookViewer");
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");
  const projectionLifecycleSourcePath = new URL(
    "../../../src/components/notebook/state/projection-lifecycle.ts",
    import.meta.url,
  );
  const projectionLifecycleSourceText = readFileSync(projectionLifecycleSourcePath, "utf8");

  assert.match(sourceText, /PresenceValueProvider/);
  assert.match(sourceText, /from "@\/components\/notebook"/);
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
  assert.match(sessionSourceText, /cleanupNotebookProjectionForRemovedCells/);
  assert.match(projectionLifecycleSourceText, /from "\.\/view-store-projection"/);
  assert.match(projectionLifecycleSourceText, /createNotebookViewStoreProjector\(\)/);
  assert.doesNotMatch(projectionLifecycleSourceText, /syntheticExecutionId/);
  assert.doesNotMatch(projectionLifecycleSourceText, /syntheticOutputId/);
  assert.doesNotMatch(
    projectionLifecycleSourceText,
    /\.\.\/\.\.\/notebook\/src\/lib\/notebook-cells/,
  );
  assert.doesNotMatch(
    projectionLifecycleSourceText,
    /\.\.\/\.\.\/notebook\/src\/lib\/notebook-executions/,
  );
  assert.doesNotMatch(
    projectionLifecycleSourceText,
    /\.\.\/\.\.\/notebook\/src\/lib\/notebook-outputs/,
  );
  assert.doesNotMatch(projectionLifecycleSourceText, /deleteOutputs\(difference/);
  assert.doesNotMatch(projectionLifecycleSourceText, /deleteExecutions\(difference/);
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
  assert.match(sourceText, /canStartSelectedWorkstation/);
  assert.match(sourceText, /onAttachWorkstation=\{onAttachWorkstation\}/);
  assert.match(sourceText, /onSetDefaultWorkstation=\{onSetDefaultWorkstation\}/);
  assert.doesNotMatch(sourceText, /fetchCloudWorkstations/);
  assert.doesNotMatch(sourceText, /setCloudDefaultWorkstation/);
  assert.doesNotMatch(sourceText, /requestCloudWorkstationAttachment/);
  assert.doesNotMatch(sourceText, /projectNotebookWorkstationSelection/);
  assert.doesNotMatch(sourceText, /projectNotebookWorkstationSurface/);
  assert.doesNotMatch(sourceText, /cloudWorkstationRefreshIntervalMs/);
  assert.match(hookSourceText, /fetchCloudWorkstations/);
  assert.match(hookSourceText, /setCloudDefaultWorkstation/);
  assert.match(hookSourceText, /requestCloudWorkstationAttachment/);
  assert.match(hookSourceText, /projectNotebookWorkstationSurface/);
  assert.doesNotMatch(hookSourceText, /projectNotebookWorkstationSelection/);
  assert.doesNotMatch(hookSourceText, /projectNotebookWorkstationLaunchReadiness/);
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
  const editModeButtonSourcePath = new URL("../viewer/cloud-edit-mode-button.tsx", import.meta.url);
  const editModeButtonSourceText = readFileSync(editModeButtonSourcePath, "utf8");
  const authControlsSourcePath = new URL("../viewer/cloud-auth-controls.tsx", import.meta.url);
  const authControlsSourceText = readFileSync(authControlsSourcePath, "utf8");
  const shellHookSourcePath = new URL("../viewer/use-cloud-shell-capabilities.ts", import.meta.url);
  const shellHookSourceText = readFileSync(shellHookSourcePath, "utf8");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");

  assert.match(sourceText, /useCloudShellCapabilities/);
  assert.match(editModeButtonSourceText, /NotebookEditModeButton/);
  assert.match(
    editModeButtonSourceText,
    /<NotebookEditModeButton[\s\S]*mode=\{accessPending \? "view" : interaction\.selectedMode\}/,
  );
  assert.match(
    editModeButtonSourceText,
    /<NotebookEditModeButton[\s\S]*state=\{accessPending \? "viewing" : interaction\.state\}/,
  );
  assert.match(editModeButtonSourceText, /<NotebookEditModeButton[\s\S]*variant="segmented"/);
  assert.match(authControlsSourceText, /authConfig\.localDev\?\.label\?\.trim\(\)/);
  assert.match(authControlsSourceText, /return "Use local auth"/);
  assert.match(authControlsSourceText, /window\.location\.assign\(localDevAuth\.authUrl\)/);
  assert.match(
    authControlsSourceText,
    /const providerLabel = authConfig\.oidc\?\.providerLabel\?\.trim\(\)/,
  );
  assert.match(
    editModeButtonSourceText,
    /<NotebookEditModeButton[\s\S]*requestedEditLabel=\{reconnecting \? "Offline" : "Request sent"\}/,
  );
  assert.match(
    editModeButtonSourceText,
    /<NotebookEditModeButton[\s\S]*requestedEditTitle=\{[\s\S]*reconnecting \? "Offline while the room reconnects" : "Edit access requested"/,
  );
  assert.match(editModeButtonSourceText, /onModeChange=\{\(mode\) => \{/);
  assert.match(sourceText, /accessLevel=\{shellCapabilities\.access\.level\}/);
  assert.doesNotMatch(sourceText, /projectCloudNotebookEditAccess/);
  assert.doesNotMatch(sourceText, /cloudNotebookShellCapabilities/);
  assert.match(shellHookSourceText, /projectCloudNotebookEditAccess/);
  assert.match(shellHookSourceText, /projectCloudNotebookDocumentEditReadiness/);
  assert.match(shellHookSourceText, /cloudNotebookShellCapabilities/);
  assert.match(shellHookSourceText, /selectedMode/);
  assert.match(shellHookSourceText, /editAccessRequestPending/);
  assert.match(sourceText, /onModeChange=\{setSelectedInteractionMode\}/);
  assert.match(sourceText, /onRequestEditAccess=\{requestCloudEditAccess\}/);
  assert.match(sourceText, /reconnecting=\{sustainedReconnecting\}/);
  assert.match(
    shellHookSourceText,
    /const editAccessPending =[\s\S]*roomEditAccess\.editAccessPending \|\| editReadiness\.selectedEditModeWaitingForRoom/,
  );
  assert.doesNotMatch(sourceText, /appliedGrantedEditScopeRef/);
  assert.doesNotMatch(sourceText, /requestedEditAccess/);
  assert.doesNotMatch(
    sourceText,
    /setSelectedInteractionMode\("edit"\);[\s\S]*\[canAcceptCellMutations, connectionPeerId, connectionScope/,
  );
  assert.match(sourceText, /accessPending=\{editAccessPending\}/);
  assert.match(
    editModeButtonSourceText,
    /state=\{accessPending \? "viewing" : interaction\.state\}/,
  );
  assert.match(editModeButtonSourceText, /disabled=\{accessPending\}/);
  assert.match(
    editModeButtonSourceText,
    /const canSwitchToEdit = accessLevel === "editor" \|\| accessLevel === "owner"/,
  );
  assert.match(editModeButtonSourceText, /editLabel=\{editLabel\}/);
  assert.match(editModeButtonSourceText, /editTitle=\{editTitle\}/);
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
  assert.match(editModeButtonSourceText, /if \(mode === "edit" && !canSwitchToEdit\) \{/);
  assert.match(sourceText, /projectCloudAccessRequestTransition\(\{/);
  assert.match(
    sourceText,
    /if \(transition\.requestedScope\) \{[\s\S]*storeCloudRequestedScope\(window\.localStorage, transition\.requestedScope\);/,
  );
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

test("cloud mobile shell gives the collapsed rail a toolbar entrypoint", () => {
  const sourceText = viewerFileContaining("export function NotebookViewer");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");

  assert.match(sourceText, /PanelLeftOpen/);
  assert.match(sourceText, /const handleOpenMobileRail = useCallback\(\(\) => \{/);
  assert.match(sourceText, /setNotebookRailCollapsed\(false\);/);
  assert.match(
    sourceText,
    /leadingControls: \(\s*<button[\s\S]*className="cloud-mobile-rail-toggle hidden h-8 w-8[\s\S]*aria-label="Open notebook panels"[\s\S]*onClick=\{handleOpenMobileRail\}/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 599\.98px\) \{[\s\S]*\.cloud-mobile-rail-toggle\s*\{[\s\S]*display: inline-flex;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 599\.98px\) \{[\s\S]*\.cloud-notebook-rail\[data-collapsed="true"\]\s*\{[\s\S]*display: none;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 599\.98px\) \{[\s\S]*\.cloud-notebook-shell \[data-slot="notebook-command-toolbar"\] button\s*\{[\s\S]*min-width: 2rem;[\s\S]*min-height: 2rem;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 599\.98px\) \{[\s\S]*\.cloud-notebook-rail\[data-collapsed="false"\]\s*\{[\s\S]*width: 100%;/,
  );
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
    /const notebookBodyAccessBlocked = cloudConnectionDiagnosticBlocksNotebookBody\(connectionError\)/,
  );
  assert.match(sourceText, /const notebookHeaderChrome = projectCloudNotebookHeaderChrome\(\{/);
  assert.match(sourceText, /projectCloudNotebookViewSurface\(\{/);
  assert.match(sourceText, /bodyAccessBlocked: notebookBodyAccessBlocked/);
  assert.match(
    sourceText,
    /hasAccessDiagnostic: isCloudConnectionAccessDiagnostic\(connectionError\)/,
  );
  assert.match(sourceText, /Preparing notebook view/);
  assert.match(sourceText, /const notices = hasNotices \? \(/);
  assert.match(sourceText, /notices=\{notices\}/);
  assert.match(sourceText, /noticesClassName="cloud-notebook-notices"/);
  assert.match(sourceText, /cloud-notebook-shell--command-toolbar/);
  assert.match(cssText, /\.cloud-notebook-shell \{[\s\S]*position: relative;/);
  assert.match(cssText, /\.cloud-notebook-shell \{[\s\S]*--cloud-notice-height: 3rem;/);
  assert.match(
    cssText,
    /\.cloud-notebook-shell--command-toolbar \{[\s\S]*--cloud-notice-height: 3rem;/,
  );
  const noticesCss = cssText.match(/\.cloud-notebook-notices \{(?<body>[\s\S]*?)\n\}/)?.groups
    ?.body;
  assert.ok(noticesCss);
  assert.match(noticesCss, /flex: 0 0 var\(--cloud-notice-height\);/);
  assert.match(noticesCss, /height: var\(--cloud-notice-height\);/);
  assert.match(noticesCss, /overflow-y: auto;/);
  assert.match(noticesCss, /animation: cloud-notice-enter/);
  assert.doesNotMatch(noticesCss, /position: absolute;/);
  assert.match(
    cssText,
    /\.cloud-notebook-notices \[data-slot="notebook-notice"\] \{[\s\S]*min-height: var\(--cloud-notice-height\);/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 900px\) \{[\s\S]*\.cloud-notebook-shell \{[\s\S]*--cloud-notice-height: 3rem;[\s\S]*\.cloud-notebook-shell--command-toolbar \{[\s\S]*--cloud-notice-height: 3rem;/,
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
    /navigateNotebookOutlineItem\(item, href, \{[\s\S]*documentAnchors,[\s\S]*headingHashTarget: "cell",[\s\S]*\}\)/,
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
    /navigateNotebookOutlineItem\(item, hash, \{\s+behavior: "auto",\s+documentAnchors,\s+headingHashTarget: "cell",\s+\}\)/,
  );
});

test("cloud live materialization skips empty room handles before resolving outputs", () => {
  const sourceText = viewerCorpus;
  const loadingProjectionSourcePath = new URL(
    "../viewer/notebook-view-loading.ts",
    import.meta.url,
  );
  const loadingProjectionSourceText = readFileSync(loadingProjectionSourcePath, "utf8");
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");

  assert.match(sourceText, /const CLOUD_EMPTY_ROOM_GRACE_MS = 900;/);
  assert.match(sourceText, /const \[emptyRoomGraceElapsed, setEmptyRoomGraceElapsed\]/);
  assert.match(
    loadingProjectionSourceText,
    /status\.kind === "empty" && cellCount === 0 && !emptyRoomGraceElapsed/,
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
    /\[\s*appSessionStatus\.session,[\s\S]*authState,[\s\S]*bootstrap,[\s\S]*canFetchNotebookList,[\s\S]*refreshIndex,[\s\S]*waitingForAppSession,[\s\S]*\]/,
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
    /const \{[\s\S]*canFetchCatalog: canFetchNotebookList,[\s\S]*hasAppSession,[\s\S]*signedIn,[\s\S]*waitingForAppSession,[\s\S]*\} = hostedAuth;/,
  );
  assert.match(
    sourceText,
    /useHostedCatalogAuth\(\{[\s\S]*authState,[\s\S]*appSession: appSessionStatus\.session,[\s\S]*appSessionLoading: appSessionStatus\.status === "loading"/,
  );
  assert.match(
    sourceText,
    /if \(!canFetchNotebookList\) \{[\s\S]*if \(waitingForAppSession\) \{[\s\S]*\{ kind: "loading" \}[\s\S]*return;/,
  );
  assert.match(
    sourceText,
    /fetchCloudNotebookList\(\s*authState,\s*AbortSignal\.any\(\[controller\.signal, AbortSignal\.timeout\(/,
    "catalog fetch should still use the existing auth helper once the cookie-backed state is ready",
  );
});

test("cloud notebook list trusts server bootstrap on initial app-session paint", () => {
  const sourcePath = new URL("../viewer/notebook-list-view.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(
    sourceText,
    /const seededNotebooks = cloudNotebookListSeedFromBootstrapOrCache\([\s\S]*authState,[\s\S]*appSessionStatus\.session,[\s\S]*bootstrap,[\s\S]*\);/,
  );
  assert.match(
    sourceText,
    /if \(refreshIndex === 0 && bootstrap\) \{[\s\S]*writeCachedCloudNotebookListToWindow\([\s\S]*authState,[\s\S]*appSessionStatus\.session,[\s\S]*bootstrap\.notebooks,[\s\S]*\);[\s\S]*setListState\(\{ kind: "ready", notebooks: bootstrap\.notebooks \}\);[\s\S]*return;/,
    "fresh notebook-home bootstrap should satisfy the initial render without an immediate duplicate /api/n fetch",
  );
  assert.match(
    sourceText,
    /return bootstrap\?\.notebooks \?\? readCachedCloudNotebookListFromWindow\(authState, appSession\);/,
    "server bootstrap should beat stale sessionStorage cache when both are present",
  );
});

test("cloud app-session live sync uses streamed catalog access facts without awaiting list fetch", () => {
  const sourceText = viewerFileContaining("function resolveCloudAppSessionSyncScope");

  assert.match(sourceText, /function resolveCloudAppSessionSyncScope/);
  assert.match(sourceText, /createCloudNotebookCatalogAccessLoader\(\{/);
  assert.match(sourceText, /loadCatalogAccess: async \(\) => \{/);
  assert.match(sourceText, /config\.catalogEndpoint/);
  assert.match(sourceText, /catalogAccessFactsRef\.current/);
  assert.match(sourceText, /cloudNotebookSyncScopeForCatalogAccess\(\{/);
  assert.match(
    sourceText,
    /const requestedScope = resolveCloudAppSessionSyncScope\([\s\S]*catalogAccessFactsRef\.current,[\s\S]*selectedInteractionModeRef\.current,[\s\S]*\)/,
  );
  assert.doesNotMatch(sourceText, /new URL\("api\/n\?limit=100"/);
  assert.doesNotMatch(sourceText, /\.\.\.\(await loadCatalogAccess\(\)\)/);
  assert.doesNotMatch(sourceText, /await resolveCloudAppSessionSyncScope/);
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

test("cloud command client keeps routine command logs out of the browser console", () => {
  const sourceText = viewerFileContaining("const createCloudNotebookClient = useCallback");

  assert.match(sourceText, /const cloudNotebookClientLogger: SyncEngineLogger = \{/);
  assert.match(
    sourceText,
    /const cloudNotebookClientLogger: SyncEngineLogger = \{[\s\S]*debug: \(\) => \{\}/,
  );
  assert.match(
    sourceText,
    /const cloudNotebookClientLogger: SyncEngineLogger = \{[\s\S]*info: \(\) => \{\}/,
  );
  assert.match(
    sourceText,
    /logger: cloudNotebookClientLogger,[\s\S]*getRequiredHeads: \(\) => liveRuntime\.handle\.get_heads_hex\(\)/,
  );
  assert.doesNotMatch(sourceText, /logger: console/);
});

test("cloud installs a host logger sink for shared notebook components", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /from ["']@\/lib\/logger["']/);
  assert.match(sourceText, /from ["']@\/lib\/open-url["']/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/lib\/logger/);
  assert.doesNotMatch(sourceText, /\.\.\/\.\.\/notebook\/src\/lib\/open-url/);
  assert.match(sourceText, /setLoggerHost/);
  assert.match(sourceText, /debug: \(\) => \{\}/);
  assert.match(sourceText, /info: \(\) => \{\}/);
  assert.match(sourceText, /warn: \(message: string, \.\.\.args: unknown\[\]\) => console\.warn/);
});
