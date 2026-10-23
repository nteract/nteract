// Local-only actual ProseMirror/browser regression. Separate from default unit
// tests so ordinary test runs do not require an installed Chromium binary.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = `
import {Schema} from "prosemirror-model";
import {EditorState} from "prosemirror-state";
import {EditorView} from "prosemirror-view";
import {handleLinkDOMClick} from "./viewer/link-click.mjs";
const schema = new Schema({
  nodes: {doc:{content:"paragraph+"}, paragraph:{content:"text*",toDOM:()=>["p",0]}, text:{inline:true}},
  marks: {link:{attrs:{href:{}},toDOM:mark=>["a",{href:mark.attrs.href},0]}}
});
const doc = schema.node("doc", null, [schema.node("paragraph", null, [
  schema.text("Pages implementation notes", [schema.marks.link.create({href:"/target"})])
])]);
const settings = new URL(location.href).searchParams;
const activate = (_view, _position, event) => {
  if (!event.target.closest("a")) return false;
  event.preventDefault();
  document.querySelector("#menu").textContent = "Open link";
  return true;
};
new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({schema,doc}),
  editable: () => settings.get("editable") === "true",
  handleClick: activate,
  handleDOMEvents: settings.get("guard") === "true"
    ? {click:(view,event)=>handleLinkDOMClick(view,event,activate)} : {}
});
`;
const output = await build({
  stdin: { contents: source, resolveDir: app },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
});
const script = output.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/app.js" ? "text/javascript" : "text/html");
  response.end(
    request.url === "/app.js"
      ? script
      : '<!doctype html><div id="editor"></div><div id="menu"></div><script type="module" src="/app.js"></script>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  // Establish the exact native-navigation failure without the actual click guard.
  const baseline = await browser.newPage();
  await baseline.goto(`${origin}/?editable=false&guard=false`);
  await baseline.getByRole("link").click();
  await baseline.waitForURL(`${origin}/target`);
  await baseline.close();

  for (const editable of [true, false]) {
    // In editable text Enter edits the document; Mod-K is the editor shortcut.
    // Native anchor keyboard activation applies to read-only content.
    for (const activation of editable
      ? ["pointer", "assistive"]
      : ["pointer", "keyboard", "assistive"]) {
      const page = await browser.newPage();
      const initial = `${origin}/?editable=${editable}&guard=true`;
      await page.goto(initial);
      const link = page.getByRole("link");
      if (activation === "pointer") await link.click();
      else if (activation === "assistive") await link.evaluate((anchor) => anchor.click());
      else {
        await link.focus();
        await page.keyboard.press("Enter");
      }
      await page.waitForFunction(() => document.querySelector("#menu").textContent === "Open link");
      assert.equal(
        page.url(),
        initial,
        `${editable ? "writable" : "readonly"} ${activation} keeps the document open`,
      );
      await page.close();
    }
  }
  console.log(
    "Writable/read-only pointer and assistive clicks, plus read-only keyboard activation stay in the document; baseline navigation reproduced.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
