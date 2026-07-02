import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotebookCellStrip } from "@/components/notebook/NotebookCellStrip";

globalThis.React = React;

test("notebook cell strip renders markdown HTML-looking source as inert text", () => {
  const html = renderToStaticMarkup(
    React.createElement(NotebookCellStrip, {
      preview: [
        {
          kind: "markdown",
          text: "<img onerror=alert(1)> **bold** `code`",
        },
      ],
      thumbnail: null,
    }),
  );

  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img onerror=/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code class="nb-md-code">code<\/code>/);
});
