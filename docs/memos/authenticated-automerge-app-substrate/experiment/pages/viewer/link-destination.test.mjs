import test from "node:test";
import assert from "node:assert/strict";
import { linkDestination } from "./link-destination.mjs";

const base = "https://pages.example/p/example";

test("link activation resolves relative links and rejects unsafe destinations", () => {
  for (const [href, expected] of [
    ["https://nteract.io/docs", "https://nteract.io/docs"],
    ["/p/second", "https://pages.example/p/second"],
    ["#details", "https://pages.example/p/example#details"],
    ["mailto:hello@example.com", "mailto:hello@example.com"],
    ["tel:+1234567", "tel:+1234567"],
  ])
    assert.equal(linkDestination(href, base), expected);
  for (const href of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,test",
    "file:///tmp/test",
    "blob:https://pages.example/id",
    "java\nscript:alert(1)",
    " https://nteract.io",
    "",
    "https:javascript:alert(1)",
  ]) {
    assert.equal(linkDestination(href, base), null, href);
  }
});
