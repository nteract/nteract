import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as ts from "typescript";

test("cloud notebook rendering uses shared cell chrome instead of report-mode cells", () => {
  const sourcePaths = [
    new URL("../viewer/index.tsx", import.meta.url),
    new URL("../viewer/cloud-live-notebook.tsx", import.meta.url),
  ];
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

test("cloud viewer exposes the shared theme toggle and shared theme hook", () => {
  const sourcePath = new URL("../viewer/index.tsx", import.meta.url);
  const sourceText = readFileSync(sourcePath, "utf8");

  assert.match(sourceText, /import \{ ThemeToggle \} from "@\/components\/ui\/theme-toggle";/);
  assert.match(sourceText, /useTheme\(CLOUD_VIEWER_THEME_STORAGE_KEY\)/);
  assert.match(sourceText, /<ThemeToggle/);
  assert.match(sourceText, /className="cloud-theme-toggle"/);
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
