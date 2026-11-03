import test from "node:test";
import assert from "node:assert/strict";
import { linkDestination, openInNewTab, wantsNewTab } from "./link-destination.mjs";

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

test("Command-, Ctrl- and middle-clicks ask for a new tab; plain and Alt clicks don't", () => {
  const click = (fields) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...fields,
  });
  assert.equal(wantsNewTab(click({ metaKey: true })), true);
  assert.equal(wantsNewTab(click({ ctrlKey: true })), true);
  assert.equal(wantsNewTab(click({ button: 1 })), true);
  assert.equal(wantsNewTab(click({})), false);
  assert.equal(wantsNewTab(click({ metaKey: true, altKey: true })), false);
  assert.equal(wantsNewTab(click({ button: 2, metaKey: true })), false);
});

test("a new tab opens only a resolved destination, without an opener", () => {
  const calls = [];
  const open = (...args) => calls.push(args);
  assert.equal(openInNewTab(linkDestination("/p/second", base), open), true);
  assert.equal(openInNewTab(linkDestination("javascript:alert(1)", base), open), false);
  assert.deepEqual(calls, [["https://pages.example/p/second", "_blank", "noopener,noreferrer"]]);
});
