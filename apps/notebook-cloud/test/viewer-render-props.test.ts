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
  assert.match(homeSource, /className="cloud-home-kicker"/);
  assert.match(homeSource, /const localMode = Boolean\(localDevAuth\)/);
  assert.match(homeSource, /localMode \? "LOCAL MODE" : "NTERACT"/);
  assert.match(homeSource, /localMode \? "Open local notebooks\." : "Bring computation to life\."/);
  assert.match(
    homeSource,
    /Use local auth to create notebooks and test the live room on this machine\./,
  );
  assert.match(
    homeSource,
    /Sign in to create live notebooks, share work with colleagues, and attach compute\./,
  );
  assert.match(homeSource, /View notebooks/);
  assert.match(homeSource, /href="\/n"/);
  assert.match(homeSource, /Visit nteract\.io/);
  assert.match(homeSource, /href="https:\/\/nteract\.io\/"/);
  assert.match(homeSource, /const localDevAuth = authConfig\.localDev/);
  assert.match(
    homeSource,
    /const signInConfigured = Boolean\(localDevAuth \|\| authConfig\.oidc\)/,
  );
  assert.match(homeSource, /window\.location\.assign\(authConfig\.localDev!\.authUrl\)/);
  assert.match(homeSource, /const hasLocalDevAuth = authState\.mode === "dev"/);
  assert.doesNotMatch(homeSource, /showPrototypeDevControls/);
  assert.doesNotMatch(homeSource, /className="cloud-home-scope"/);
  assert.doesNotMatch(homeSource, /<select/);
  assert.doesNotMatch(homeSource, /cloud-report-toolbar/);
  assert.doesNotMatch(homeSource, /requesting viewer/);
  assert.match(cssText, /\.cloud-home-layout/);
  assert.match(cssText, /\.cloud-home-kicker/);
  assert.doesNotMatch(cssText, /\.cloud-home-scope/);
  assert.doesNotMatch(homePanelCss, /box-shadow/);
  assert.doesNotMatch(homePanelCss, /border-radius/);
});

test("cloud callback keeps sign-in handoff in the entry surface language", () => {
  const callbackSource = readFileSync(
    new URL("../viewer/oidc-callback-standalone.ts", import.meta.url),
    "utf8",
  );

  assert.match(callbackSource, /cloud-oidc-shell/);
  assert.match(callbackSource, /cloud-oidc-layout/);
  assert.match(callbackSource, /setAttribute\("aria-label", "nteract sign-in callback"\)/);
  assert.match(callbackSource, /cloud-oidc-panel/);
  assert.match(callbackSource, /Returning you to your notebook/);
  assert.match(callbackSource, /Try again/);
  assert.match(callbackSource, /Back to nteract/);
  assert.match(callbackSource, /status\.kind/);
  assert.match(callbackSource, /cloud-oidc-spin/);
  assert.doesNotMatch(callbackSource, /cloud-report-toolbar/);
  assert.doesNotMatch(callbackSource, /flex min-h-screen/);
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
  assert.match(
    loadingSource,
    /<header className="cloud-startup-toolbar">[\s\S]*<\/header>\s*<div className="cloud-startup-workspace">/,
  );
  assert.match(
    loadingSource,
    /className="cloud-startup-main">\s*<div className="cloud-startup-command-row" aria-hidden="true">/,
  );
  assert.doesNotMatch(loadingSource, /cloud-startup-rail-home|<House/);
  assert.match(cssText, /\.cloud-startup-command-row \{[^}]*min-height: 2\.5rem;/);
  assert.match(cssText, /\.cloud-startup-rail \{[^}]*padding: 3\.25rem 0\.5rem 0\.75rem;/);
  assert.match(viewerCorpus, /cloudNotebookRouteTitleFromPathname\(window\.location\.pathname\)/);
  assert.match(loadingSource, /Opening notebook/);
  assert.doesNotMatch(loadingSource, /className="flex min-h-screen/);
  assert.doesNotMatch(loadingSource, /Loading notebook\./);
  assert.match(cssText, /\.cloud-startup-shell/);
  assert.match(cssText, /\.cloud-startup-toolbar/);
  assert.match(cssText, /\.cloud-startup-line/);
  assert.match(
    cssText,
    /@media \(max-width: 599\.98px\) \{[\s\S]*\.cloud-startup-rail,[\s\S]*\.cloud-notebook-rail\[data-collapsed="true"\]\s*\{[\s\S]*display: none;/,
  );
});

test("cloud app header owns one accessible home brand above the notebook rail", () => {
  const notebookSource = viewerFunctionSource("NotebookViewer");
  const toolbarSource = notebookSource.slice(
    notebookSource.indexOf("const toolbar ="),
    notebookSource.indexOf("const stageToolbar ="),
  );
  const loadingSource = viewerFunctionSource("ViewerStartupLoading");
  const cssText = readFileSync(new URL("../viewer/index.css", import.meta.url), "utf8");

  for (const source of [toolbarSource, loadingSource]) {
    assert.equal(source.match(/<NotebookBrandMark\b/g)?.length, 1);
    assert.match(
      source,
      /<a className="cloud-app-home" href="\/n" aria-label="Notebook home" title="Notebook home">\s*<NotebookBrandMark className="size-8" \/>\s*<\/a>/,
    );
  }
  assert.equal(notebookSource.match(/<NotebookBrandMark\b/g)?.length, 1);
  assert.match(toolbarSource, /presence=\{\s*<>\s*<a[\s\S]*<\/a>\s*<CloudNotebookTitle/);
  assert.doesNotMatch(notebookSource, /NotebookRailHomeButton|leadingSlot=/);
  assert.doesNotMatch(toolbarSource, /<NotebookCommandToolbar/);
  assert.match(notebookSource, /toolbarPlacement="shell"/);
  assert.match(notebookSource, /stageToolbarPlacement="stage-content"/);
  assert.match(
    cssText,
    /\.cloud-app-home \{[^}]*width: 3\.5rem;[^}]*height: 2\.75rem;[^}]*flex: 0 0 3\.5rem;[^}]*justify-content: center;/,
  );
  assert.match(cssText, /\.cloud-app-home:focus-visible \{[^}]*outline: 2px solid var\(--ring\);/);
  for (const headerClass of ["cloud-room-toolbar", "cloud-startup-toolbar"]) {
    assert.match(
      cssText,
      new RegExp(`\\.${headerClass} \\{[^}]*padding-inline: 0 clamp\\(0\\.5rem, 2vw, 1rem\\);`),
    );
  }
  assert.doesNotMatch(cssText, /\.cloud-app-home[^}]*display: none/);
});

test("cloud viewer keeps pending access-request polling quiet", () => {
  // The poll moved into the access-request store: a 30s fixed-rate createPoll
  // whose single exhaustMap and document-visibility gate replace the viewer's
  // hand-rolled setInterval + pollInFlight boolean + visibilitychange listener.
  const storeText = readFileSync(
    new URL("../viewer/cloud-access-request-store.ts", import.meta.url),
    "utf8",
  );
  assert.match(storeText, /const CLOUD_ACCESS_REQUEST_POLL_INTERVAL_MS = 30_000;/);
  assert.match(storeText, /strategy: "fixed-rate"/);
  assert.match(storeText, /effectiveAccessRequest\?\.status === "pending"/);
  assert.match(storeText, /active\$: visible\$/);
  assert.match(storeText, /documentVisible\$/);

  // The viewer entry delegates to the store and no longer hand-rolls the poll.
  assert.match(viewerCorpus, /useCloudAccessRequestController\(/);
  assert.doesNotMatch(viewerCorpus, /shouldPollPendingCloudAccessRequest/);
  assert.doesNotMatch(viewerCorpus, /let pollInFlight = false;/);
});

test("cloud viewer routes notebook header controls through the shared shell chrome", () => {
  const sourceText = viewerCorpus;
  const sessionSourcePath = new URL("../viewer/cloud-viewer-session.ts", import.meta.url);
  const sessionSourceText = readFileSync(sessionSourcePath, "utf8");
  const presenceSourcePath = new URL("../viewer/cloud-presence-status.tsx", import.meta.url);
  const presenceSourceText = readFileSync(presenceSourcePath, "utf8");
  const sharingSourcePath = new URL("../viewer/sharing-controls.tsx", import.meta.url);
  const sharingSourceText = readFileSync(sharingSourcePath, "utf8");
  const sharingPanelSourcePath = new URL("../viewer/sharing-panel.tsx", import.meta.url);
  const sharingPanelSourceText = readFileSync(sharingPanelSourcePath, "utf8");
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
    /<NotebookDocumentToolbar[\s\S]*frameClassName="z-20"[\s\S]*headerClassName="cloud-room-toolbar"/,
  );
  assert.match(
    sourceText,
    /const stageToolbar = showCloudCommandToolbar \? \([\s\S]*<NotebookToolbarFrame className="cloud-notebook-stage-toolbar">[\s\S]*<NotebookCommandToolbar[\s\S]*addAfterCellId=\{toolbarAddAfterCellId\}/,
  );
  assert.match(sourceText, /stageToolbarPlacement="stage-content"/);
  assert.match(sourceText, /<NotebookDocumentToolbar[\s\S]*capabilities=\{shellCapabilities\}/);
  assert.match(
    sourceText,
    /presence=\{[\s\S]*<CloudNotebookTitle[\s\S]*title=\{notebookStageGated \? gatedNotebookTitle : notebookTitle\}[\s\S]*canRename=\{catalogAccessResolved && catalogGrantsDocumentEdit\}[\s\S]*onRename=\{saveCloudNotebookTitle\}/,
  );
  assert.match(sourceText, /presence=\{[\s\S]*<NotebookBrandMark[\s\S]*<CloudNotebookTitle/);
  assert.match(
    sourceText,
    /import \{ CloudNotebookTitle, cloudNotebookRouteTitle \} from "\.\/cloud-notebook-title";/,
  );
  assert.match(sourceText, /cloudNotebookTitleDisplay,/);
  assert.match(sourceText, /cloudNotebookUrlAfterRename,/);
  assert.match(titleSourceText, /import \{ DocumentTitle \}/);
  assert.match(titleSourceText, /<DocumentTitle/);
  assert.match(titleSourceText, /classNames=\{cloudNotebookTitleClassNames\}/);
  assert.match(titleSourceText, /renameButtonTitle="Rename notebook"/);
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
  assert.match(sourceText, /editControls=\{[\s\S]*notebookHeaderChrome\.showEditModeControl \? \(/);
  assert.match(
    sourceText,
    /authControls=\{[\s\S]*shouldShowCloudHeaderSignIn\(authState, \{[\s\S]*hasAppSession,[\s\S]*\}\) \? \(/,
  );
  assert.match(sourceText, /authControls=\{[\s\S]*<CloudNotebookSignInButton/);
  assert.match(sourceText, /const beginNotebookAuth = useCallback/);
  assert.match(sourceText, /window\.location\.assign\(authConfig\.localDev\.authUrl\)/);
  assert.match(
    sourceText,
    /onSignInAgain=\{authConfig\.localDev \|\| authConfig\.oidc \? beginNotebookAuth : undefined\}/,
  );
  assert.match(sourceText, /const hasAppSession = Boolean\(appSessionStatus\.session\)/);
  // Edit-access requests delegate to the access-request store; the loaded-request
  // transition itself lives in the store, not the viewer entry.
  assert.match(
    sourceText,
    /const requestCloudEditAccess = useCallback\(\(\) => \{[\s\S]*accessRequest\.requestEditAccess\(\);/,
  );
  assert.match(sourceText, /projection\.kind === "dismissed"/);
  // A dismissed request is informational, not an error, so its notice keeps the
  // Info glyph rather than falling through to the AlertCircle default. Notice
  // icons take their size from NotebookNotice, so the branch only picks a glyph.
  const dismissedNotice =
    /projection\.kind === "dismissed"\)? \{\s*return \([\s\S]*?<\/NotebookNotice>/.exec(sourceText);
  assert.ok(dismissedNotice, "expected a dismissed-request notice branch");
  assert.match(dismissedNotice[0], /icon=\{<Info \/>\}/);
  assert.doesNotMatch(dismissedNotice[0], /AlertCircle/);
  // The rail's trailing connection/identity slot is filled by the shared quiet component:
  // avatar + connectivity dot, driven by the stable status bridge. It must
  // never regress into a text pill or a second status label surface. The
  // match is scoped to the module that owns the slot (not the whole corpus).
  const slotOwnerSource = viewerFileContaining("const identityControls =");
  assert.match(
    slotOwnerSource,
    /const identityControls =[\s\S]{0,400}?<NotebookConnectionIdentity[\s\S]{0,200}?capabilities=\{shellCapabilities\}[\s\S]{0,200}?connectionStatus\$=\{connectionStatus\$\}[\s\S]{0,800}?trailingSlot=\{identityControls\}/,
  );
  assert.doesNotMatch(sourceText, /trailingSlot=\{null\}/);
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
  assert.match(sourceText, /useNotebookRailUiState/);
  assert.match(
    sourceText,
    /const \{ activePanelId: activeRailPanel, collapsed: railCollapsed \} = useNotebookRailUiState\(\)/,
  );
  assert.doesNotMatch(sourceText, /useState\(initialCloudRailCollapsed\)/);
  assert.doesNotMatch(sourceText, /function initialCloudRailCollapsed/);
  assert.doesNotMatch(sourceText, /packagesSummary=/);
  assert.doesNotMatch(sourceText, /workstationsSummary=/);
  assert.match(
    sourceText,
    /const shouldShowCloudWorkstationsPanel =[\s\S]*shellCapabilities\.access\.level === "owner"[\s\S]*shellCapabilities\.auth\.canUseAuthenticatedIdentity/,
  );
  assert.match(
    sourceText,
    /if \(!shouldShowCloudWorkstationsPanel && activeRailPanel === "workstations"\) \{[\s\S]*setActiveNotebookRailPanel\("outline"\)/,
  );
  assert.match(
    sourceText,
    /const renderedActiveRailPanel =[\s\S]*!shouldShowCloudWorkstationsPanel && activeRailPanel === "workstations"[\s\S]*\? "outline"[\s\S]*: activeRailPanel/,
  );
  assert.match(sourceText, /activePanelId=\{renderedActiveRailPanel\}/);
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
  assert.match(sourceText, /CloudAccessFactsStore/);
  assert.match(sourceText, /function useCloudAccessFactsProjection/);
  assert.match(
    sourceText,
    /const cloudAccessSourceFacts = useMemo<CloudAccessSourceFacts>\(\s*\(\) => \(\{[\s\S]*canUseAuthenticatedCloudApi,[\s\S]*catalog: catalogAccessFacts,[\s\S]*connection: \{[\s\S]*statusKind: status\.kind,/,
  );
  assert.match(
    sourceText,
    /const cloudAccessFacts = useCloudAccessFactsProjection\(cloudAccessSourceFacts\)/,
  );
  assert.doesNotMatch(sourceText, /projectCloudAccessFacts\(/);
  assert.match(sharingSourceText, /export function CloudSharingControls/);
  assert.match(sharingSourceText, /CloudSharingFactsStore/);
  assert.match(
    sharingSourceText,
    /const sharingSourceFacts = useMemo<CloudSharingSourceFacts>\(\s*\(\) => \(\{[\s\S]*accessRequests,[\s\S]*acl,[\s\S]*copyState,[\s\S]*inviteEmail,[\s\S]*invites,[\s\S]*loadState,/,
  );
  assert.match(
    sharingSourceText,
    /const sharingFacts = useCloudSharingFactsProjection\(sharingSourceFacts\)/,
  );
  assert.match(sharingSourceText, /const accessProjection = sharingFacts\.access/);
  assert.doesNotMatch(sharingSourceText, /projectCloudSharingFacts\(/);
  assert.doesNotMatch(
    sharingSourceText,
    /buildCloudShareAccessProjection\(\{ acl, invites, accessRequests \}\)/,
  );
  const cloudFactsReactSourcePath = new URL("../viewer/cloud-facts-react.ts", import.meta.url);
  const cloudFactsReactSource = readFileSync(cloudFactsReactSourcePath, "utf8");
  const silentSetIndex = cloudFactsReactSource.indexOf("store.set(source, { notify: false });");
  const snapshotSubscribeIndex = cloudFactsReactSource.indexOf(
    "const projection = useSyncExternalStore",
  );
  const flushIndex = cloudFactsReactSource.indexOf("store.flush();");
  assert.ok(silentSetIndex >= 0);
  assert.ok(snapshotSubscribeIndex >= 0);
  assert.ok(flushIndex >= 0);
  assert.ok(silentSetIndex < snapshotSubscribeIndex);
  assert.ok(snapshotSubscribeIndex < flushIndex);
  assert.doesNotMatch(cloudFactsReactSource, /useLayoutEffect\(\(\) => \{\s*store\.set\(source\)/);
  // The popover body is CloudSharingPanel, a presentational component
  // extracted so the Elements fixture can render it directly instead of
  // hand-copying JSX that could drift from the real markup.
  assert.match(
    sharingSourceText,
    /import \{[\s\S]*CloudSharingPanel,[\s\S]*\} from "\.\/sharing-panel";/,
  );
  assert.match(sharingSourceText, /<CloudSharingPanel/);
  assert.doesNotMatch(sharingSourceText, /function CloudSharingPanel/);
  assert.match(sharingPanelSourceText, /export function CloudSharingPanel/);
  assert.match(sharingPanelSourceText, /Invite people, review requests, and manage link access\./);
  assert.match(sharingPanelSourceText, /aria-label="Edit access requests"/);
  assert.match(sharingPanelSourceText, /<h3 className="text-sm font-semibold">Edit requests<\/h3>/);
  assert.match(sharingPanelSourceText, /accessProjection\.accessRequestRows\.map/);
  assert.match(sharingPanelSourceText, /accessProjection\.accessRequestSummary/);
  assert.match(sharingPanelSourceText, /aria-label="Compute access"/);
  assert.match(sharingPanelSourceText, /accessProjection\.runtimeAccessRows\.map/);
  assert.match(sharingPanelSourceText, /function CloudShareStateLabel/);
  assert.match(sharingPanelSourceText, /<CloudShareStateLabel tone=\{row\.stateTone\}>/);
  assert.match(sharingPanelSourceText, /Can view this notebook without signing in/);
  assert.match(
    sharingPanelSourceText,
    /Link access is off\. Only listed people can open this notebook/,
  );
  assert.match(sharingPanelSourceText, /aria-label=\{copyLinkLabel\}/);
  assert.match(sharingPanelSourceText, /compactCopyLinkLabel/);
  // Every section renders rows through one CloudShareRow so trailing controls
  // share a single reserved action column instead of each row positioning its
  // own, which is what made buttons, badges, and text land on different insets.
  assert.match(
    sharingPanelSourceText,
    /function CloudShareRow\(\{ row, children \}: \{ row: CloudShareAccessRow; children\?: ReactNode \}\)/,
  );
  assert.match(
    sharingPanelSourceText,
    /<CloudShareRowIcon row=\{row\} \/>[\s\S]*<strong className="block truncate text-sm font-medium">\{row\.label\}<\/strong>/,
  );
  for (const rows of ["notebookAccessRows", "accessRequestRows", "runtimeAccessRows"]) {
    assert.match(
      sharingPanelSourceText,
      new RegExp(
        `accessProjection\\.${rows}\\.map\\(\\(row\\) => \\(\\s*<CloudShareRow key=\\{row\\.id\\} row=\\{row\\}`,
      ),
    );
  }
  assert.match(
    sharingPanelSourceText,
    /accessProjection\.accessRequestRows\.map\(\(row\) =>[\s\S]*label=\{`Approve \$\{row\.label\}`\}/,
  );
  assert.match(sharingPanelSourceText, /label=\{`Remove \$\{row\.label\}`\}/);
  // Icon sizing and aria-hidden come from the Button variant and lucide's own
  // defaults; per-icon overrides here drift from the design system.
  assert.doesNotMatch(sharingPanelSourceText, /<[A-Z]\w*[^>]*\bsize-3\.5\b/);
  assert.doesNotMatch(sharingPanelSourceText, /aria-hidden/);
  assert.doesNotMatch(sharingPanelSourceText, /\bleading-5\b/);
  // Enable/Disable and Copy link are real buttons, not ghost text that reads
  // as a link.
  assert.doesNotMatch(sharingPanelSourceText, /variant="ghost"\s+size="sm"/);
  assert.match(sharingPanelSourceText, /import \{ Button \} from "@\/components\/ui\/button";/);
  assert.match(sharingPanelSourceText, /import \{ Input \} from "@\/components\/ui\/input";/);
  assert.match(
    sharingPanelSourceText,
    /import \{\s*Select,\s*SelectContent,\s*SelectItem,\s*SelectTrigger,\s*SelectValue,\s*\} from "@\/components\/ui\/select";/,
  );
  assert.match(
    sharingPanelSourceText,
    /import \{ Separator \} from "@\/components\/ui\/separator";/,
  );
  assert.doesNotMatch(sharingPanelSourceText, /<details/);
  assert.doesNotMatch(sharingPanelSourceText, /<summary/);
  assert.doesNotMatch(sharingPanelSourceText, /className="cloud-share-/);
  assert.match(
    sharingSourceText,
    /import \{ Popover, PopoverContent, PopoverTrigger \} from "@\/components\/ui\/popover";/,
  );
  assert.match(sharingSourceText, /<Popover open=\{open\} onOpenChange=\{handleOpenChange\}>/);
  assert.match(sharingSourceText, /<PopoverTrigger asChild>/);
  assert.match(
    sharingSourceText,
    /<PopoverContent[\s\S]*align="end"[\s\S]*sideOffset=\{8\}[\s\S]*>/,
  );
  assert.doesNotMatch(sharingSourceText, /<details/);
  assert.doesNotMatch(sharingSourceText, /<summary/);
  assert.doesNotMatch(sharingSourceText, /className="cloud-share-/);
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
  assert.doesNotMatch(cssText, /\.cloud-share-/);
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
  assert.match(noticesText, /Sign in to open the live notebook room\./);
  assert.match(noticesText, /Notebook access needed\./);
  assert.match(noticesText, /message: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC/);
  assert.match(noticesText, /Notebook not found\./);
  assert.match(noticesText, /CLOUD_CONNECTION_NOT_FOUND_DIAGNOSTIC/);
  assert.match(noticesText, /tone: "success"/);
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
  assert.match(
    sourceText,
    /\.cloud-notebook-stage > \[data-slot="notebook-document-stage-body"\]\s*\{[\s\S]*display: grid;[\s\S]*grid-template-columns: auto minmax\(0, 1fr\);/,
  );
  assert.match(
    sourceText,
    /\[data-slot="notebook-document-rail-panel-host"\]:has\(\[data-slot="notebook-rail-panel"\]\)\s*\{[\s\S]*grid-column: 1 \/ -1;/,
  );
  assert.match(
    sourceText,
    /\[data-slot="notebook-document-stage-body"\]:has\(\[data-slot="notebook-rail-panel"\]\)\s*> :is\(\s*\[data-slot="notebook-document-stage-content-toolbar"\],\s*\[data-slot="notebook-document-stage-content"\]\s*\)\s*\{\s*display: none;/,
  );
  assert.doesNotMatch(
    sourceText,
    /\[data-slot="(?:notebook-rail-panel-title-row|rail-panel-header)"\][^}]*display: none;/,
  );
  assert.doesNotMatch(
    sourceText.match(
      /\.cloud-notebook-stage > \[data-slot="notebook-document-stage-body"\]\s*\{[^}]*\}/,
    )?.[0] ?? "",
    /grid-template-rows:/,
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
