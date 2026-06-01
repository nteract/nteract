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

test("cloud viewer routes notebook header controls through the shared command toolbar", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /NotebookCommandToolbar,/);
  assert.match(
    sourceText,
    /<NotebookCommandToolbar[\s\S]*canEditStructure=\{shellCapabilities\.canEditStructure\}/,
  );
  assert.match(sourceText, /trailingControls=\{[\s\S]*<CloudSharingControls/);
  assert.match(sourceText, /trailingControls=\{[\s\S]*<CloudNotebookEditModeButton/);
  assert.match(
    sourceText,
    /leadingControls=\{[\s\S]*<CloudPresenceStatus[\s\S]*interaction=\{shellCapabilities\.interaction \?\? null\}/,
  );
  assert.doesNotMatch(sourceText, /<CloudPresenceStatus[^>]*connectionScope=\{connectionScope\}/);
  assert.doesNotMatch(sourceText, /className="cloud-code-toggle"/);
  assert.doesNotMatch(sourceText, /shellCapabilities\.canManageSharing \? \(/);
  assert.doesNotMatch(sourceText, /shellCapabilities\.canToggleCode \? \(/);
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
