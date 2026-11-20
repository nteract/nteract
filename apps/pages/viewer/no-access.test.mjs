import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EVENTS,
  NO_ACCESS_HEADING,
  NO_ACCESS_INITIAL,
  STATES,
  noAccessMessage,
  noAccessRefusal,
  noAccessStep,
} from "./no-access.mjs";
import { formatRefused } from "./unopened-page.mjs";
import { classifyRefusal, signingKeyRefused } from "./session.mjs";

const PRINCIPAL = "account-1";
const httpError = (status, code, message = "Refused") =>
  Object.assign(Error(message), { status, code });
const PAGE_DENIED = httpError(403, "page_access_denied", "Document access denied");
const PROJECT_MISSING = httpError(404, "project_not_found", "Project not found");
const OPEN_PAGE = { current: true, pageId: "page-1", projectId: null, principal: PRINCIPAL };
const OPEN_PROJECT = {
  current: true,
  pageId: null,
  projectId: "project-1",
  principal: PRINCIPAL,
};

test("a Page the account can't read is a no-access refusal", () => {
  assert.equal(classifyRefusal(PAGE_DENIED), "access");
  assert.deepEqual(noAccessRefusal(PAGE_DENIED, OPEN_PAGE), {
    kind: "page",
    targetId: "page-1",
    principal: PRINCIPAL,
  });
});

test("a Project the account can't read is a no-access refusal", () => {
  assert.deepEqual(noAccessRefusal(PROJECT_MISSING, OPEN_PROJECT), {
    kind: "project",
    targetId: "project-1",
    principal: PRINCIPAL,
  });
});

test("a readable Project whose content Page refuses keeps its retry screen", () => {
  // get_project answered, so the Project exists and is shared with this
  // account. The screen's wording would be false.
  assert.equal(noAccessRefusal(PAGE_DENIED, { ...OPEN_PROJECT, pageId: "content-1" }), null);
});

test("refusals with screens or banners of their own are not no-access", () => {
  const formatDiscovery = httpError(409, "document_format_unsupported");
  const formatSocket = signingKeyRefused({ code: "document_format_unsupported" });
  assert.ok(formatRefused(formatDiscovery) && formatRefused(formatSocket));
  const cases = {
    formatDiscovery,
    formatSocket,
    trashed: httpError(403, "page_trashed", "This Page is in its owner's Trash"),
    signedOut: httpError(401, "sign_in_required", "Sign in"),
    network: Object.assign(Error("Failed to fetch"), { code: "NETWORK_ERROR" }),
    timeout: Object.assign(Error("Timed out"), { name: "TimeoutError", code: "REQUEST_TIMEOUT" }),
    serverError: httpError(503, "temporarily_unavailable"),
    deleted: httpError(404, "page_deleted"),
    otherForbidden: httpError(403, "access_changed"),
    // A Page address answered as a missing Project is not this Page's refusal.
    projectCodeOnPage: PROJECT_MISSING,
  };
  for (const [name, error] of Object.entries(cases)) {
    assert.equal(noAccessRefusal(error, OPEN_PAGE), null, name);
    if (name !== "projectCodeOnPage")
      assert.equal(noAccessRefusal(error, OPEN_PROJECT), null, name);
  }
  assert.equal(noAccessRefusal(undefined, OPEN_PAGE), null);
});

test("a refusal after the person navigated elsewhere is ignored", () => {
  assert.equal(noAccessRefusal(PAGE_DENIED, { ...OPEN_PAGE, current: false }), null);
  assert.equal(noAccessRefusal(PROJECT_MISSING, { ...OPEN_PROJECT, current: false }), null);
});

test("a refusal with no signed-in account or no target is not shown", () => {
  assert.equal(noAccessRefusal(PAGE_DENIED, { ...OPEN_PAGE, principal: undefined }), null);
  assert.equal(noAccessRefusal(PAGE_DENIED, { ...OPEN_PAGE, pageId: null }), null);
});

const REFUSAL = { kind: "page", targetId: "page-1", principal: PRINCIPAL };
const SHOWN = { name: "shown", ...REFUSAL };
const SAMPLE = {
  refused: { type: "refused", refusal: REFUSAL },
  cleared: { type: "cleared" },
};
const at = { none: NO_ACCESS_INITIAL, shown: SHOWN };
// The next state for each state × event.
const NEXT = {
  none: { refused: "shown", cleared: "none" },
  shown: { refused: "shown", cleared: "none" },
};

test("every state × event has its next state", () => {
  for (const name of STATES)
    for (const type of EVENTS) {
      const next = noAccessStep(at[name], SAMPLE[type]);
      assert.equal(next.name, NEXT[name][type], `${name} × ${type}`);
      if (next.name === "shown") assert.deepEqual(next, SHOWN);
    }
});

test("clearing with nothing shown keeps the same state object", () => {
  assert.equal(noAccessStep(NO_ACCESS_INITIAL, SAMPLE.cleared), NO_ACCESS_INITIAL);
});

test("a newer refusal replaces the one shown", () => {
  const project = { kind: "project", targetId: "project-1", principal: PRINCIPAL };
  assert.deepEqual(noAccessStep(SHOWN, { type: "refused", refusal: project }), {
    name: "shown",
    ...project,
  });
});

test("a refused event without a usable refusal changes nothing", () => {
  for (const refusal of [null, undefined, { ...REFUSAL, kind: "folder" }, { kind: "page" }])
    assert.equal(noAccessStep(NO_ACCESS_INITIAL, { type: "refused", refusal }), NO_ACCESS_INITIAL);
});

test("unknown states and events throw", () => {
  assert.throws(() => noAccessStep({ name: "open" }, SAMPLE.cleared), /Unknown no-access state/);
  assert.throws(
    () => noAccessStep(NO_ACCESS_INITIAL, { type: "opened" }),
    /Unknown no-access event/,
  );
});

test("the message never says the target exists, and names the account", () => {
  assert.equal(
    noAccessMessage("page", "Ada"),
    "This Page doesn't exist, or it isn't shared with your account. You're signed in as Ada.",
  );
  assert.equal(
    noAccessMessage("project", "Ada"),
    "This Project doesn't exist, or it isn't shared with your account. You're signed in as Ada.",
  );
  assert.equal(
    noAccessMessage("page", null),
    "This Page doesn't exist, or it isn't shared with your account.",
  );
});

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("./NoAccess.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "external",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
      },
    },
  ],
});
const { NoAccess } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

test("the screen is a heading, the message and one link to the library", () => {
  const html = renderToStaticMarkup(
    createElement(NoAccess, { kind: "project", accountName: "Ada", onHome: () => {} }),
  );
  assert.match(html, new RegExp(`<h1 tabindex="-1">${NO_ACCESS_HEADING}</h1>`));
  assert.ok(html.includes("This Project doesn&#x27;t exist"));
  assert.ok(html.includes("signed in as Ada."));
  assert.equal(html.match(/<a /g).length, 1);
  assert.match(html, /<a class="primary" href="\/">Go to your Pages<\/a>/);
  assert.ok(!/<button/.test(html));
  assert.ok(!/role="alert"/.test(html));
});
