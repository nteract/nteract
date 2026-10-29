import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMMENTS_SHEET_QUERY } from "./comments-layout.mjs";

test("docked comments use the exact complement of the sheet query", async () => {
  // A gap between the two queries (for example 900.5px under browser zoom)
  // leaves the panel undocked and over the Page.
  assert.equal(COMMENTS_SHEET_QUERY, "(max-width: 900px)");
  const css = await readFile(new URL("./style.css", import.meta.url), "utf8");
  assert.match(css, /@media screen and \(width > 900px\) \{\s*\.document\.with-comments \{/);
  assert.doesNotMatch(css, /min-width: 901px\) \{\s*\.document\.with-comments/);
});
