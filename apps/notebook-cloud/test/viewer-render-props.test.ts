import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as ts from "typescript";
import {
  viewerCorpus,
  viewerFileContaining,
  viewerFunctionSource,
  viewerModuleTexts,
} from "./viewer-source-corpus";

test("cloud notebook rendering uses shared cell chrome instead of report-mode cells", () => {
  const offenders: string[] = [];

  for (const { name, text } of viewerModuleTexts) {
    const sourceFile = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sourceFile);
        if (tagName === "ReadOnlyNotebook" || tagName === "ReadOnlyNotebookCell") {
          const attributes = node.attributes.properties;
          const hasReportMode = attributes.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(sourceFile) === "displayMode" &&
              attribute.initializer?.getText(sourceFile) === '"report"',
          );

          if (hasReportMode) {
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            offenders.push(`${name}:${tagName}:${position.line + 1}`);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  assert.deepEqual(
    offenders,
    [],
    "cloud notebook rendering should stay on notebook-mode cells so shared cell lanes and ribbons render",
  );
});

test("cloud viewer keeps theme resolution out of first-class notebook chrome", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /useTheme\(CLOUD_VIEWER_THEME_STORAGE_KEY\)/);
  assert.match(sourceText, /applyDocumentTheme\(resolvedTheme\)/);
  assert.doesNotMatch(
    sourceText,
    /import \{ ThemeToggle \} from "@\/components\/ui\/theme-toggle";/,
  );
  assert.doesNotMatch(sourceText, /<ThemeToggle/);
  assert.doesNotMatch(sourceText, /className="cloud-theme-toggle"/);
});

test("cloud home keeps prototype controls out of the primary auth surface", () => {
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");
  const homeSource = viewerFunctionSource("CloudHomeView");
  const homePanelCss = cssText.slice(
    cssText.indexOf(".cloud-home-panel"),
    cssText.indexOf(".cloud-home-status"),
  );

  assert.match(homeSource, /homeStatusTitle[\s\S]*"Open a notebook"/);
  assert.match(homeSource, /className="cloud-home-layout"/);
  assert.match(homeSource, /aria-label="nteract notebook entry"/);
  assert.match(homeSource, /aria-label="Notebook sign-in"/);
  assert.match(homeSource, /className="cloud-home-copy"/);
  assert.match(homeSource, /<h1>nteract<\/h1>/);
  assert.match(homeSource, /realtime notebooks/);
  assert.match(homeSource, /View notebooks/);
  assert.match(homeSource, /href="\/n"/);
  assert.match(homeSource, /const localDevAuth = authConfig\.localDev/);
  assert.match(
    homeSource,
    /const signInConfigured = Boolean\(localDevAuth \|\| authConfig\.oidc\)/,
  );
  assert.match(homeSource, /window\.location\.assign\(localDevAuth\.authUrl\)/);
  assert.match(homeSource, /const hasLocalDevAuth = authState\.mode === "dev"/);
  assert.doesNotMatch(homeSource, /showPrototypeDevControls/);
  assert.doesNotMatch(homeSource, /className="cloud-home-scope"/);
  assert.doesNotMatch(homeSource, /<select/);
  assert.doesNotMatch(homeSource, /cloud-report-toolbar/);
  assert.doesNotMatch(homeSource, /requesting viewer/);
  assert.match(cssText, /\.cloud-home-layout/);
  assert.doesNotMatch(cssText, /\.cloud-home-scope/);
  assert.doesNotMatch(homePanelCss, /box-shadow/);
  assert.doesNotMatch(homePanelCss, /border-radius/);
});

test("cloud callback keeps sign-in handoff in the entry surface language", () => {
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");
  const callbackSource = viewerFunctionSource("OidcCallbackView");

  assert.match(callbackSource, /className="cloud-home"/);
  assert.match(callbackSource, /className="cloud-home-layout"/);
  assert.match(callbackSource, /aria-label="nteract sign-in callback"/);
  assert.match(callbackSource, /className="cloud-home-panel"/);
  assert.match(callbackSource, /returning to the notebook/);
  assert.match(callbackSource, /Back to nteract/);
  assert.match(callbackSource, /data-mode=\{status\.kind\}/);
  assert.match(cssText, /\.cloud-home-status-spinner/);
  assert.doesNotMatch(callbackSource, /cloud-report-toolbar/);
  assert.doesNotMatch(callbackSource, /className="flex min-h-screen/);
});

test("cloud notebook startup loading uses route-shaped shell chrome", () => {
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");
  const loadingSource = viewerFunctionSource("ViewerStartupLoading");

  assert.match(loadingSource, /className="cloud-startup-shell"/);
  assert.match(loadingSource, /className="cloud-startup-toolbar"/);
  assert.match(loadingSource, /className="cloud-startup-workspace"/);
  assert.match(loadingSource, /className="cloud-startup-rail"/);
  assert.match(loadingSource, /className="cloud-startup-stage"/);
  assert.match(viewerCorpus, /cloudNotebookRouteTitleFromPathname\(window\.location\.pathname\)/);
  assert.match(loadingSource, /Opening notebook/);
  assert.doesNotMatch(loadingSource, /className="flex min-h-screen/);
  assert.doesNotMatch(loadingSource, /Loading notebook\./);
  assert.match(cssText, /\.cloud-startup-shell/);
  assert.match(cssText, /\.cloud-startup-toolbar/);
  assert.match(cssText, /\.cloud-startup-line/);
});

test("cloud viewer keeps pending access-request polling quiet", () => {
  const sourceText = viewerFileContaining("CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS");

  assert.match(sourceText, /const CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS = 30_000;/);
  assert.match(sourceText, /function shouldPollPendingCloudAccessRequest\(\): boolean/);
  assert.match(sourceText, /document\.visibilityState !== "hidden"/);
  assert.match(sourceText, /let pollInFlight = false;/);
  assert.match(sourceText, /if \(!shouldPollPendingCloudAccessRequest\(\) \|\| pollInFlight\)/);
  assert.match(
    sourceText,
    /document\.addEventListener\("visibilitychange", handleVisibilityChange\)/,
  );
});

test("cloud viewer routes notebook header controls through the shared shell chrome", () => {
  const sourceText = viewerCorpus;
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");
  const presenceSourcePath = new URL("../viewer/cloud-presence-status.tsx", import.meta.url);
  const presenceSourceText = readFileSync(presenceSourcePath, "utf8");
  const sharingSourcePath = new URL("../viewer/sharing-controls.tsx", import.meta.url);
  const sharingSourceText = readFileSync(sharingSourcePath, "utf8");
  const titleSourcePath = new URL("../viewer/cloud-notebook-title.tsx", import.meta.url);
  const titleSourceText = readFileSync(titleSourcePath, "utf8");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");

  assert.match(sourceText, /NotebookDocumentToolbar,/);
  assert.match(sourceText, /shouldShowNotebookDocumentCommandToolbar,/);
  assert.match(
    sourceText,
    /const showCloudCommandToolbar = shouldShowNotebookDocumentCommandToolbar\(shellCapabilities, \{[\s\S]*reserve: editAccessPending,[\s\S]*\}\)/,
  );
  assert.match(
    sourceText,
    /<NotebookDocumentToolbar[\s\S]*frameClassName="z-20"[\s\S]*headerClassName="cloud-room-toolbar"[\s\S]*commandToolbar=\{\{[\s\S]*addAfterCellId: toolbarAddAfterCellId/,
  );
  assert.match(sourceText, /<NotebookDocumentToolbar[\s\S]*capabilities=\{shellCapabilities\}/);
  assert.match(
    sourceText,
    /presence=\{[\s\S]*<CloudNotebookTitle[\s\S]*title=\{notebookTitle\}[\s\S]*canRename=\{catalogAccessResolved && catalogGrantsDocumentEdit\}[\s\S]*onRename=\{saveCloudNotebookTitle\}/,
  );
  assert.match(
    sourceText,
    /import \{ CloudNotebookTitle, cloudNotebookRouteTitle \} from "\.\/cloud-notebook-title";/,
  );
  assert.match(sourceText, /cloudNotebookTitleDisplay,/);
  assert.match(sourceText, /cloudNotebookUrlAfterRename,/);
  assert.match(titleSourceText, /className="cloud-notebook-home-link"/);
  assert.match(titleSourceText, /<House aria-hidden="true" \/>/);
  assert.match(titleSourceText, /<PencilLine aria-hidden="true" \/>/);
  assert.doesNotMatch(titleSourceText, /cloud-notebook-logo/);
  assert.doesNotMatch(sourceText, /function shouldShowCloudNotebookCommandToolbar/);
  assert.doesNotMatch(sourceText, /toolbarClassName="cloud-report-toolbar"/);
  assert.match(sourceText, /sharingControls=\{[\s\S]*<CloudSharingControls/);
  assert.match(sourceText, /from "\.\/sharing-controls"/);
  assert.match(sourceText, /publicLink=\{publicNotebookLink\}/);
  assert.doesNotMatch(sourceText, /function CloudSharingControls/);
  assert.doesNotMatch(
    sourceText,
    /buildCloudShareAccessRows\(\{ acl, invites, accessRequests \}\)/,
  );
  assert.match(sourceText, /editControls=\{[\s\S]*<CloudNotebookEditModeButton/);
  assert.match(
    sourceText,
    /authControls=\{[\s\S]*shouldShowCloudHeaderSignIn\(authState, \{[\s\S]*hasAppSession,[\s\S]*\}\) \? \(/,
  );
  assert.match(sourceText, /authControls=\{[\s\S]*<CloudNotebookSignInButton/);
  assert.match(sourceText, /const beginNotebookAuth = useCallback/);
  assert.match(sourceText, /window\.location\.assign\(localDevAuth\.authUrl\)/);
  assert.match(
    sourceText,
    /onSignInAgain=\{authConfig\.localDev \|\| authConfig\.oidc \? beginNotebookAuth : undefined\}/,
  );
  assert.match(sourceText, /const hasAppSession = Boolean\(appSessionStatus\.session\)/);
  assert.match(sourceText, /projectCloudAccessRequestTransition\(\{/);
  // The connection/identity slot is filled by the shared quiet component:
  // avatar + connectivity dot, driven by the stable status bridge. It must
  // never regress into a text pill or a second status label surface. The
  // match is scoped to the module that owns the slot (not the whole
  // corpus) so an identityControls regression cannot false-pass against a
  // mount elsewhere.
  const slotOwnerSource = viewerFileContaining("identityControls=");
  assert.match(
    slotOwnerSource,
    /identityControls=\{[\s\S]{0,400}?<NotebookConnectionIdentity[\s\S]{0,200}?capabilities=\{shellCapabilities\}[\s\S]{0,200}?connectionStatus\$=\{connectionStatus\$\}/,
  );
  assert.doesNotMatch(sourceText, /identityControls=\{null\}/);
  // Session-side bridge wiring order (comment-enforced invariants, pinned):
  // attach follows each replacement transport; teardown paths report the
  // retry BEFORE the dispose emits its terminal "offline"; the effect
  // cleanup does the same so the auth-refresh re-run gap reads as a
  // transition, not stale "online".
  assert.match(
    sessionSourceText,
    /onTransportCreated: \(transport\) => \{[\s\S]{0,400}?connectionStatusBridge\.attach\(transport\);/,
  );
  assert.match(
    sessionSourceText,
    /const scheduleReconnect = \(reason: Error\) => \{[\s\S]{0,600}?connectionStatusBridge\.noteTeardownRetry\(\);[\s\S]{0,800}?disposeCurrentRuntime\(\);/,
  );
  assert.match(
    sessionSourceText,
    /connectionStatusBridge\.noteTeardownRetry\(\);[\s\S]{0,400}?pendingSeedDiscardRef\.current = discardPersistedSeedAfterTeardown\(/,
  );
  assert.match(
    sessionSourceText,
    /connectionStatusBridge\.noteTeardownRetry\(\);[\s\S]{0,600}?const teardownFlush = disposeCurrentRuntime\(\);/,
  );
  assert.match(sourceText, /useState\(initialCloudRailCollapsed\)/);
  assert.match(sourceText, /function initialCloudRailCollapsed/);
  assert.match(sourceText, /function initialCloudRailCollapsed\(\): boolean \{[\s\S]*return true;/);
  assert.doesNotMatch(sourceText, /packagesSummary=/);
  assert.doesNotMatch(sourceText, /workstationsSummary=/);
  assert.match(
    sourceText,
    /const shouldShowCloudWorkstationsPanel =[\s\S]*shellCapabilities\.access\.level === "owner"[\s\S]*shellCapabilities\.auth\.canUseAuthenticatedIdentity/,
  );
  assert.match(
    sourceText,
    /if \(!shouldShowCloudWorkstationsPanel && activeRailPanel === "workstations"\) \{[\s\S]*setActiveRailPanel\("outline"\)/,
  );
  assert.match(
    sourceText,
    /workstationsPanel=\{[\s\S]*shouldShowCloudWorkstationsPanel \? \([\s\S]*<NotebookWorkstationsPanel/,
  );
  assert.match(
    sourceText,
    /const shouldShowPackageEnvironmentSummary =[\s\S]*shellCapabilities\.canExecute \|\| shellCapabilities\.canManagePackages/,
  );
  assert.match(sourceText, /shouldShowPackageEnvironmentSummary \? \([\s\S]*<EnvironmentSummary/);
  assert.match(sourceText, /autoFocusFirstCell=\{false\}/);
  assert.match(
    sessionSourceText,
    /const presenceStoreRef = useRef<CloudViewerPresenceStore \| null>\(null\)/,
  );
  assert.match(
    presenceSourceText,
    /useSyncExternalStore\(store\.subscribe, store\.getSnapshot, store\.getSnapshot\)/,
  );
  assert.match(
    sourceText,
    /utilityControls=\{[\s\S]*<CloudPresenceStatus[\s\S]*store=\{presenceStore\}/,
  );
  assert.match(presenceSourceText, /cloudViewerPresenceDisplay,/);
  assert.match(presenceSourceText, /<AvatarGroup className="cloud-presence-avatar-group"/);
  assert.match(presenceSourceText, /data-slot="cloud-presence-stack"/);
  assert.doesNotMatch(sourceText, /useState\(initialCloudViewerPresence\)/);
  assert.doesNotMatch(sourceText, /setPresence\(/);
  assert.doesNotMatch(sourceText, /label=\{compactCloudPresenceLabel\(presenceDisplay\.label\)\}/);
  assert.match(sharingSourceText, /export function CloudSharingControls/);
  assert.match(sharingSourceText, /Invite people, review requests, and manage link access\./);
  assert.match(
    sharingSourceText,
    /const accessProjection = useMemo\(\s*\(\) => buildCloudShareAccessProjection\(\{ acl, invites, accessRequests \}\)/,
  );
  assert.match(sharingSourceText, /<div className="cloud-share-current-heading">/);
  assert.match(sharingSourceText, /aria-label="Compute access"/);
  assert.match(sharingSourceText, /accessProjection\.runtimeAccessRows\.map/);
  assert.match(sharingSourceText, /<div className="cloud-share-row-actions">/);
  assert.match(
    sharingSourceText,
    /<span className="cloud-share-state" data-tone=\{row\.stateTone \?\? undefined\}>/,
  );
  assert.match(sharingSourceText, /Can view this notebook without signing in/);
  assert.match(sharingSourceText, /Link access is off\. Only listed people can open this notebook/);
  assert.match(sharingSourceText, /const copyLinkLabel =[\s\S]*"Copy link"/);
  assert.match(sharingSourceText, /const compactCopyLinkLabel =[\s\S]*"Copy"/);
  assert.match(
    sharingSourceText,
    /buildCloudShareAccessProjection\(\{ acl, invites, accessRequests \}\)/,
  );
  assert.match(
    sharingSourceText,
    /accessProjection\.notebookAccessRows\.map\(\(row\) =>[\s\S]*<CloudShareRowIcon row=\{row\} \/>[\s\S]*<strong>\{row\.label\}<\/strong>[\s\S]*<span>\{row\.detail\}<\/span>/,
  );
  assert.match(sharingSourceText, /aria-label=\{`Remove \$\{row\.label\}`\}/);
  const sharePanelCss = cssText.match(/\.cloud-share-panel \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  assert.ok(sharePanelCss);
  assert.match(sharePanelCss, /position: fixed;/);
  assert.match(sharePanelCss, /right: max\(0\.75rem, env\(safe-area-inset-right\)\);/);
  assert.match(sharePanelCss, /width: min\(30rem, calc\(100vw - 1\.5rem\)\);/);
  assert.doesNotMatch(sharePanelCss, /position: absolute;/);
  assert.match(
    presenceSourceText,
    /function CloudPresenceStatus[\s\S]*const presence = useSyncExternalStore\(store\.subscribe, store\.getSnapshot, store\.getSnapshot\);[\s\S]*const presenceDisplay = cloudViewerPresenceDisplay\(presence\);/,
  );
  assert.match(cssText, /\.cloud-presence-stack \{[\s\S]*min-width: 1\.75rem;[\s\S]*height: 2rem;/);
  assert.match(cssText, /\.cloud-presence-avatar-group \{[\s\S]*align-items: center;/);
  assert.match(cssText, /\.cloud-presence-avatar\[data-kind="anonymous"\]/);
  assert.doesNotMatch(cssText, /\.cloud-connection-status/);
  assert.match(
    cssText,
    /cloud-room-toolbar \[data-slot="notebook-document-header-controls"\] \{[\s\S]*flex: 0 0 auto;[\s\S]*min-width: max-content;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 900px\) \{[\s\S]*cloud-room-toolbar[\s\S]*flex-wrap: nowrap;[\s\S]*cloud-room-toolbar \[data-slot="notebook-document-header-controls"\] \{[\s\S]*min-width: 0;[\s\S]*justify-content: flex-end;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 640px\) \{[\s\S]*cloud-share-current li[\s\S]*grid-template-columns: auto minmax\(0, 1fr\);[\s\S]*cloud-share-row-actions[\s\S]*grid-column: 2;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 640px\) \{[\s\S]*cloud-share-copy-label-full[\s\S]*display: none;[\s\S]*cloud-share-copy-label-compact[\s\S]*display: inline;/,
  );
  assert.match(cssText, /0 10px 24px color-mix\(in srgb, #000 9%, transparent\)/);
  assert.doesNotMatch(cssText, /0 12px 36px/);
  assert.doesNotMatch(sourceText, /runtimeStatus=\{cloudNotebookRuntimeStatus/);
  assert.doesNotMatch(sourceText, /label: "live"/);
  assert.doesNotMatch(sourceText, /label: "Room"/);
  assert.doesNotMatch(sourceText, /<CloudPresenceStatus[^>]*connectionScope=\{connectionScope\}/);
  assert.doesNotMatch(sourceText, /<CloudPresenceStatus[^>]*interaction=\{/);
  assert.doesNotMatch(sourceText, /className="cloud-code-toggle"/);
  assert.doesNotMatch(sourceText, /shellCapabilities\.canManageSharing \? \(/);
  assert.doesNotMatch(sourceText, /shellCapabilities\.canToggleCode \? \(/);
});

test("cloud viewer presents live-room failures as one host notice", () => {
  const sourceText = viewerCorpus;
  const presenceSourcePath = new URL("../viewer/cloud-presence-status.tsx", import.meta.url);
  const presenceSourceText = readFileSync(presenceSourcePath, "utf8");
  const noticesPath = new URL("../viewer/notices.tsx", import.meta.url);
  const noticesText = readFileSync(noticesPath, "utf8");

  assert.match(sourceText, /const notebookHasReadableSnapshot =/);
  assert.match(
    sourceText,
    /notebookCellIds\.length > 0 \|\|[\s\S]*!\s*connectionError && snapshotResolvedRef\.current && status\.kind === "ready"/,
  );
  assert.match(sourceText, /const signedOutNotebookSignInRequired =/);
  assert.match(
    sourceText,
    /Boolean\(authConfig\.localDev \|\| authConfig\.oidc\)[\s\S]*authState\.mode === "anonymous"[\s\S]*!isPublicViewer[\s\S]*!notebookHasReadableSnapshot[\s\S]*isTransportReconnectError\(connectionError\)/,
  );
  assert.match(sourceText, /signInRequired: signedOutNotebookSignInRequired/);
  assert.match(sourceText, /signInRequired=\{signedOutNotebookSignInRequired\}/);
  assert.match(noticesText, /const connectionNotice = connectionError/);
  assert.match(noticesText, /cloudConnectionNoticeDisplay\(connectionError, hasReadableSnapshot\)/);
  assert.match(noticesText, /const shouldShowStatusNotice =/);
  assert.match(noticesText, /!signInRequired &&/);
  assert.match(noticesText, /isStatusDerivedFromConnectionError\(status, connectionError\)/);
  assert.match(noticesText, /function isStatusDerivedFromConnectionError/);
  assert.match(noticesText, /function cloudConnectionNoticeDisplay/);
  assert.match(noticesText, /hasReadableSnapshot: boolean/);
  assert.match(noticesText, /Sign in required\./);
  assert.match(noticesText, /Notebook access needed\./);
  assert.match(noticesText, /Live room unavailable\./);
  assert.match(noticesText, /The notebook will load once the account or connection is refreshed\./);
  assert.match(noticesText, /tone=\{connectionNotice\.tone\}/);
  assert.match(noticesText, /Live room reconnecting\./);
  assert.match(noticesText, /tone: "warning"/);
  assert.match(presenceSourceText, /function cloudConnectionStatusErrorTitle/);
  assert.match(presenceSourceText, /aria-label=\{title\}/);
  assert.match(
    presenceSourceText,
    /Room unavailable: \$\{cloudConnectionStatusErrorTitle\(connectionError\)\}/,
  );
  assert.doesNotMatch(sourceText, /title="Live room connection failed\."/);
  assert.doesNotMatch(sourceText, /Reconnecting to the notebook room: \$\{error\}/);
  assert.doesNotMatch(sourceText, />\s*\{connectionError\}\s*<\/NotebookNotice>/);
});

test("cloud viewer defers supplemental CSS loading until the notebook surface mounts", () => {
  const sourceText = viewerCorpus;
  const sourceFile = ts.createSourceFile(
    "viewer-corpus.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const topLevelSupplementalLoads = sourceFile.statements.filter(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      statement.expression.getText(sourceFile) === "loadSupplementalViewerCss()",
  );

  assert.equal(topLevelSupplementalLoads.length, 0);
  assert.match(
    sourceText,
    /function CloudNotebookProviders[\s\S]*useEffect\(\(\) => \{\s*loadSupplementalViewerCss\(\);\s*\}, \[\]\);/,
  );
});

test("cloud notebook shell keeps the rail and toolbar outside the cell scroller", () => {
  const sourcePath = new URL("../viewer/index.css", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(
    sourceText,
    /html,\s*\nbody,\s*\n#root\s*\{[\s\S]*height: 100%;[\s\S]*overflow: hidden;/,
  );
  assert.match(
    sourceText,
    /\.cloud-notebook-shell\s*\{[\s\S]*height: 100%;[\s\S]*overflow: hidden;/,
  );
  assert.match(sourceText, /\.cloud-notebook-rail\s*\{[\s\S]*height: 100%;/);
  assert.doesNotMatch(sourceText, /\.cloud-report-toolbar/);
  assert.match(sourceText, /@import "\.\.\/\.\.\/notebook\/src\/index\.css";/);
  assert.doesNotMatch(
    sourceText.match(/\.cloud-notebook-shell\s*\{[^}]*\}/)?.[0] ?? "",
    /flex-direction: column;/,
  );
});

test("cloud rail takes over constrained widths instead of pushing the stage offscreen", () => {
  const sourcePath = new URL("../viewer/index.css", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /@media \(max-width: 599\.98px\)/);
  assert.match(sourceText, /\.cloud-notebook-rail\[data-collapsed="false"\]\s*\{/);
  assert.match(
    sourceText,
    /\.cloud-notebook-rail\[data-collapsed="false"\] \[data-slot="notebook-rail-panel"\]\s*\{/,
  );
  assert.match(
    sourceText,
    /\.cloud-notebook-rail\[data-collapsed="false"\] \+ \[data-slot="notebook-document-stage"\]\s*\{/,
  );
});

test("cloud viewer uses shared outline interaction hooks", () => {
  const sourceText = viewerCorpus;

  assert.match(sourceText, /useActiveOutlineItemId,/);
  assert.match(sourceText, /useOutlineSelection,/);
  assert.match(sourceText, /useOutlineStatusLabel,/);
  assert.match(sourceText, /useActiveOutlineItemId\(/);
  assert.match(sourceText, /useOutlineSelection\(/);
  assert.match(sourceText, /const getOutlineStatusLabel = useOutlineStatusLabel\(\);/);
  assert.match(sourceText, /outlineCellIds=\{notebookCellIds\}/);
  assert.doesNotMatch(
    sourceText,
    /const \[selectedOutlineItemId, setSelectedOutlineItemId\] = useState/,
  );
  assert.doesNotMatch(
    sourceText,
    /const handleSelectOutlineItem = useCallback\(\(item[\s\S]*setSelectedOutlineItemId\(item\.id\)/,
  );
});
