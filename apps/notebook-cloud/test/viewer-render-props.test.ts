import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as ts from "typescript";

test("cloud notebook rendering uses shared cell chrome instead of report-mode cells", () => {
  const sourcePaths = [new URL("../viewer/index.tsx", import.meta.url)];
  const offenders: string[] = [];

  for (const sourcePath of sourcePaths) {
    const sourceText = readFileSync(sourcePath, "utf8");
    const sourceFile = ts.createSourceFile(
      sourcePath.pathname,
      sourceText,
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
            offenders.push(`${sourcePath.pathname}:${tagName}:${position.line + 1}`);
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
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

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
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");
  const homeSource = sourceText.slice(
    sourceText.indexOf("function CloudHomeView"),
    sourceText.indexOf("function OidcCallbackView"),
  );
  const homePanelCss = cssText.slice(
    cssText.indexOf(".cloud-home-panel"),
    cssText.indexOf(".cloud-home-status"),
  );

  assert.match(homeSource, /homeStatusTitle[\s\S]*"Public viewer"/);
  assert.match(homeSource, /className="cloud-home-layout"/);
  assert.match(homeSource, /className="cloud-home-copy"/);
  assert.doesNotMatch(homeSource, /showPrototypeDevControls/);
  assert.doesNotMatch(homeSource, /className="cloud-home-scope"/);
  assert.doesNotMatch(homeSource, /<select/);
  assert.match(cssText, /\.cloud-home-layout/);
  assert.doesNotMatch(cssText, /\.cloud-home-scope/);
  assert.doesNotMatch(homePanelCss, /box-shadow/);
  assert.doesNotMatch(homePanelCss, /border-radius/);
});

test("cloud callback keeps sign-in handoff in the entry surface language", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");
  const callbackSource = sourceText.slice(
    sourceText.indexOf("function OidcCallbackView"),
    sourceText.indexOf("function NotebookViewer"),
  );

  assert.match(callbackSource, /className="cloud-home"/);
  assert.match(callbackSource, /className="cloud-home-layout"/);
  assert.match(callbackSource, /className="cloud-home-panel"/);
  assert.match(callbackSource, /Returning to the notebook\./);
  assert.match(callbackSource, /data-mode=\{status\.kind\}/);
  assert.match(cssText, /\.cloud-home-status-spinner/);
  assert.doesNotMatch(callbackSource, /className="flex min-h-screen/);
});

test("cloud viewer routes notebook header controls through the shared shell chrome", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");
  const cssPath = new URL("../viewer/index.css", import.meta.url);
  const cssText = readFileSync(cssPath, "utf8");

  assert.match(sourceText, /NotebookCommandToolbar,/);
  assert.match(sourceText, /NotebookDocumentHeader,/);
  assert.match(sourceText, /NotebookToolbarFrame,/);
  assert.match(
    sourceText,
    /<NotebookToolbarFrame className="z-20">[\s\S]*<NotebookDocumentHeader[\s\S]*shouldShowCloudNotebookCommandToolbar\(shellCapabilities\)[\s\S]*<NotebookCommandToolbar/,
  );
  assert.match(sourceText, /<NotebookDocumentHeader[\s\S]*capabilities=\{shellCapabilities\}/);
  assert.match(sourceText, /<NotebookCommandToolbar[\s\S]*capabilities=\{shellCapabilities\}/);
  assert.match(
    sourceText,
    /function shouldShowCloudNotebookCommandToolbar\(capabilities: NotebookShellCapabilities\): boolean \{[\s\S]*capabilities\.canEditStructure[\s\S]*capabilities\.canExecute[\s\S]*capabilities\.canManagePackages/,
  );
  assert.doesNotMatch(sourceText, /toolbarClassName="cloud-report-toolbar"/);
  assert.match(sourceText, /sharingControls=\{[\s\S]*<CloudSharingControls/);
  assert.match(sourceText, /editControls=\{[\s\S]*<CloudNotebookEditModeButton/);
  assert.match(
    sourceText,
    /authControls=\{[\s\S]*shouldShowCloudHeaderSignIn\(authState\) && !showCloudIdentityControls/,
  );
  assert.match(sourceText, /authControls=\{[\s\S]*<CloudNotebookSignInButton/);
  assert.match(sourceText, /identityControls=\{[\s\S]*showCloudIdentityControls \? \(/);
  assert.match(sourceText, /identityControls=\{[\s\S]*<CloudAuthControls/);
  assert.match(sourceText, /<NotebookIdentityBadge[\s\S]*showStatus=\{false\}/);
  assert.match(
    sourceText,
    /<UserRound className="cloud-auth-identity-icon" aria-hidden="true" \/>/,
  );
  assert.match(
    sourceText,
    /function shouldShowCloudIdentityControls[\s\S]*authState\.mode === "anonymous"[\s\S]*return showPrototypeDevControls && hasExplicitPrototypeDevAuthSearch\(search\);/,
  );
  assert.match(sourceText, /useState\(initialCloudRailCollapsed\)/);
  assert.match(sourceText, /function initialCloudRailCollapsed/);
  assert.match(sourceText, /matchMedia\("\(max-width: 599\.98px\)"\)/);
  assert.match(sourceText, /function hasExplicitPrototypeDevAuthSearch/);
  assert.match(sourceText, /presence=\{[\s\S]*<CloudPresenceStatus[\s\S]*presence=\{presence\}/);
  assert.match(sourceText, /cloudViewerPresenceDisplay,/);
  assert.match(
    sourceText,
    /function CloudPresenceStatus[\s\S]*const presenceDisplay = cloudViewerPresenceDisplay\(presence\);[\s\S]*if \(!presenceDisplay\.connected\) \{[\s\S]*return null;/,
  );
  assert.match(cssText, /@media \(max-width: 360px\) \{[\s\S]*cloud-auth-identity-icon/);
  assert.match(
    cssText,
    /cloud-auth-identity-summary \.cloud-auth-identity-badge > span[\s\S]*display: none;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 360px\) \{[\s\S]*cloud-room-toolbar \.cloud-connection-status[\s\S]*display: none;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 520px\) \{[\s\S]*cloud-room-toolbar \.cloud-connection-status[\s\S]*width: 2rem;[\s\S]*cloud-room-toolbar \.cloud-connection-status span[\s\S]*display: none;/,
  );
  assert.match(
    cssText,
    /@media \(max-width: 640px\) \{[\s\S]*cloud-share-current li[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto auto;/,
  );
  assert.match(cssText, /0 8px 20px color-mix\(in srgb, #000 8%, transparent\)/);
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
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /const connectionNotice = connectionError/);
  assert.match(sourceText, /const notebookHasReadableSnapshot =/);
  assert.match(
    sourceText,
    /notebookCellIds\.length > 0 \|\|[\s\S]*!\s*connectionError && snapshotResolvedRef\.current && status\.kind === "ready"/,
  );
  assert.match(
    sourceText,
    /cloudConnectionNoticeDisplay\(connectionError, notebookHasReadableSnapshot\)/,
  );
  assert.match(sourceText, /const shouldShowStatusNotice =/);
  assert.match(sourceText, /isStatusDerivedFromConnectionError\(status, connectionError\)/);
  assert.match(sourceText, /function isStatusDerivedFromConnectionError/);
  assert.match(sourceText, /function cloudConnectionNoticeDisplay/);
  assert.match(sourceText, /hasReadableSnapshot: boolean/);
  assert.match(sourceText, /Live room unavailable\./);
  assert.match(sourceText, /The notebook will load once the account or connection is refreshed\./);
  assert.match(sourceText, /tone=\{connectionNotice\.tone\}/);
  assert.match(sourceText, /Live room reconnecting\./);
  assert.match(sourceText, /tone: "warning"/);
  assert.match(sourceText, /function cloudConnectionStatusErrorTitle/);
  assert.match(sourceText, /aria-label=\{title\}/);
  assert.match(
    sourceText,
    /Reconnecting to the notebook room: \$\{cloudConnectionStatusErrorTitle\(error\)\}/,
  );
  assert.doesNotMatch(sourceText, /title="Live room connection failed\."/);
  assert.doesNotMatch(sourceText, /Reconnecting to the notebook room: \$\{error\}/);
  assert.doesNotMatch(sourceText, />\s*\{connectionError\}\s*<\/NotebookNotice>/);
});

test("cloud viewer defers supplemental CSS loading until the notebook surface mounts", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath.pathname,
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
  assert.match(sourceText, /\.cloud-report-toolbar\s*\{[\s\S]*top: 0;[\s\S]*border-bottom:/);
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
