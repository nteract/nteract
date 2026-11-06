import test from "node:test";
import assert from "node:assert/strict";
import {
  PAGE_LINK_CLASS,
  linkAttributes,
  linkDestination,
  openInNewTab,
  wantsNewTab,
} from "./link-destination.mjs";

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

test("only a link to another of this deployment's Pages draws with the Page glyph's hooks", () => {
  const here = "1a160b47-6df1-4983-81eb-489ca5a26812";
  const other = "2b160b47-6df1-4983-81eb-489ca5a26812";
  const page = `https://pages.example/p/${here}`;
  const plain = (href) => ({ href, title: "", target: "_blank", rel: "noopener noreferrer" });
  const glyph = (href, pageId) => ({
    ...plain(href),
    class: PAGE_LINK_CLASS,
    "data-page-id": pageId,
  });
  const rows = [
    [`/p/${other}`, glyph(`https://pages.example/p/${other}`, other)],
    [
      `https://pages.example/p/${other}#plan`,
      glyph(`https://pages.example/p/${other}#plan`, other),
    ],
    [`HTTPS://PAGES.EXAMPLE:443/p/${other}`, glyph(`https://pages.example/p/${other}`, other)],
    // This Page's own links are section links; other routes and origins
    // are ordinary links.
    [`/p/${here}#plan`, plain(`https://pages.example/p/${here}#plan`)],
    ["#plan", plain(`https://pages.example/p/${here}#plan`)],
    [`/project/prj_${other}`, plain(`https://pages.example/project/prj_${other}`)],
    [`/p/${other}/meta.json`, plain(`https://pages.example/p/${other}/meta.json`)],
    [
      `https://pages.example.evil.example/p/${other}`,
      plain(`https://pages.example.evil.example/p/${other}`),
    ],
    [`https://page2.example/p/${other}`, plain(`https://page2.example/p/${other}`)],
    ["https://nteract.io/docs", plain("https://nteract.io/docs")],
    ["mailto:hello@example.com", plain("mailto:hello@example.com")],
  ];
  for (const [href, expected] of rows)
    assert.deepEqual(linkAttributes({ href, title: null }, { base: page }), expected, href);
  assert.deepEqual(linkAttributes({ href: "javascript:alert(1)" }, { base: page }), {});
  assert.deepEqual(linkAttributes(null, { base: page }), {});
  assert.equal(
    linkAttributes({ href: `/p/${other}`, title: "Plan" }, { base: page }).title,
    "Plan",
  );
  // A Project's content shows at its Project's address; the editor names it.
  const project = `https://pages.example/project/prj_${other}`;
  assert.equal(linkAttributes({ href: `/p/${here}` }, { base: project })["data-page-id"], here);
  assert.equal(
    linkAttributes({ href: `/p/${here}` }, { base: project, currentPageId: here })["data-page-id"],
    undefined,
  );
});
