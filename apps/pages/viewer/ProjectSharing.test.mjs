import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// Bundle so the shared panel under src/ resolves React from this workspace,
// as the Pages build does.
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./ProjectSharing.jsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  plugins: [
    {
      name: "test-component",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({
          path: pathToFileURL(require.resolve(path)).href,
          external: true,
        }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "empty" }));
      },
    },
  ],
});
const { ProjectSharing, projectSharingTransition: step } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

test("Project sharing transitions reject out-of-order completions and duplicate saves", () => {
  const states = ["idle", "loading", "ready", "saving", "failed"];
  const events = ["load", "save", "loaded", "failed"];
  for (const name of states)
    for (const type of events) {
      const state = { name, value: { revision: 1 } };
      const next = step(state, { type, value: { revision: 2 }, request: {}, error: "Denied" });
      const allowed =
        type === "load"
          ? !["loading", "saving"].includes(name)
          : type === "save"
            ? name === "ready"
            : ["loading", "saving"].includes(name);
      assert.equal(next === state, !allowed, `${name}/${type}`);
    }
});

test("owner shares Project by email with revision fencing; members never fetch the ACL", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const saved = new Map();
  const copied = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  const project = { project_id: "prj_3b160b47-6df1-4983-81eb-489ca5a26812", role: "owner" };
  const tool = async (name, args) => {
    calls.push([name, args]);
    return {
      revision: 4,
      members: { "account:member": { role: "viewer" }, removed: { role: "none" } },
      invites: [
        {
          id: "pending",
          email: "pending@example.com",
          role: "editor",
          expiresAt: Date.now() + 10000,
        },
        { id: "expired", email: "expired@example.com", role: "viewer", expiresAt: 1 },
      ],
    };
  };
  try {
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          project,
          tool,
          session: { identity: { principal: "owner", displayName: "Kyle Kelley" } },
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    assert.match(document.body.textContent, /No email is sent/);
    assert.ok(
      document.querySelector(".page-sharing-popover.project-sharing-panel"),
      "Project sharing uses the shell's viewport-constrained popover",
    );
    assert.equal(document.querySelector("input").type, "email");
    assert.equal(
      document.querySelector(".page-sharing > button").getAttribute("aria-haspopup"),
      "dialog",
    );
    await act(async () => document.querySelector('button[aria-label="Copy Project link"]').click());
    assert.equal(copied[0], `http://localhost/project/${project.project_id}`);
    assert.match(document.body.textContent, /Project link copied/);
    const rows = [...document.querySelectorAll("[data-sharing-row]")];
    assert.deepEqual(
      rows.map((row) => row.querySelector("strong").textContent),
      ["Kyle Kelley", "Collaborator", "p•••@example.com", "e•••@example.com"],
      "owner first, then members, then invites; emails masked until hover",
    );
    assert.doesNotMatch(document.body.textContent, /pending@example\.com/);
    assert.equal(rows[2].getAttribute("title"), null, "a masked row has no tooltip to leak it");
    assert.match(rows[2].textContent, /Can edit\s*Pending/);
    assert.match(rows[3].textContent, /Can view\s*Expired/);
    const rowProps = (node) =>
      node[Object.keys(node).find((key) => key.startsWith("__reactProps"))];
    await act(async () => rowProps(rows[2]).onPointerEnter());
    assert.equal(rows[2].querySelector("strong").textContent, "pending@example.com");
    await act(async () => rowProps(rows[2]).onPointerLeave());
    assert.equal(rows[2].querySelector("strong").textContent, "p•••@example.com");
    assert.equal(document.querySelector('select[aria-label="Role for removed"]'), null);
    assert.doesNotMatch(document.body.textContent, /removed:/);
    await act(async () =>
      document.querySelector('button[aria-label="Remove Collaborator"]').click(),
    );
    assert.equal(calls[1][0], "manage_project_access");
    assert.deepEqual(
      { ...calls[1][1], nonce: undefined },
      {
        project_id: project.project_id,
        action: "set_role",
        principal: "account:member",
        role: null,
        expected_revision: 4,
        nonce: undefined,
      },
    );
    assert.ok(calls[1][1].nonce);
    await act(async () =>
      document.querySelector('button[aria-label="Remove pending@example.com"]').click(),
    );
    assert.equal(calls.at(-1)[1].action, "revoke_invite");
    assert.equal(calls.at(-1)[1].invite_id, "pending");
    const input = document.querySelector("input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(
        input,
        "person@example.com",
      );
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    // React's event delegation was loaded before jsdom; change through its
    // controlled handler as the other shell fixtures do.
    const props = input[Object.keys(input).find((key) => key.startsWith("__reactProps"))];
    await act(async () => props.onChange({ target: { value: "person@example.com" } }));
    await act(async () =>
      document
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(calls.at(-1)[1].action, "invite");
    assert.equal(calls.at(-1)[1].email, "person@example.com");
    assert.equal(calls.at(-1)[1].principal, undefined);
    const beforeInvalid = calls.length;
    await act(async () => props.onChange({ target: { value: "not-an-email" } }));
    await act(async () =>
      document
        .querySelector("form")
        .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })),
    );
    assert.equal(calls.length, beforeInvalid, "invalid email never reaches sharing API");
    const memberRole = document.querySelector('select[aria-label="Role for Collaborator"]');
    await act(async () => {
      memberRole.value = "commenter";
      memberRole.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(calls.at(-1)[1].action, "set_role");
    assert.equal(calls.at(-1)[1].principal, "account:member");
    assert.equal(calls.at(-1)[1].role, "commenter");
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "claimed",
          project,
          tool: async () => ({
            revision: 5,
            invites: [],
            members: {
              "account:claimed": { email: "person@example.com", role: "editor" },
            },
          }),
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    assert.equal(document.querySelector('[aria-label="Pending access"]'), null);
    assert.ok(document.querySelector('select[aria-label="Role for person@example.com"]'));
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "failure",
          project,
          tool: async () => {
            throw new Error("Revision conflict: reload members");
          },
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    assert.match(document.querySelector('[role="alert"]').textContent, /Revision conflict/);
    assert.equal(document.querySelector("input"), null, "failed authority cannot be reused");
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "pending",
          project,
          tool: () => pending,
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    const count = calls.length;
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "member",
          project: { ...project, role: "editor" },
          tool,
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    assert.equal(calls.length, count);
    assert.equal(document.querySelector("input"), null);
    assert.doesNotMatch(document.body.textContent, /account:member/);
    assert.match(document.body.textContent, /Only the Project owner/);
    await act(async () => resolve({ revision: 9, members: { secret: { role: "editor" } } }));
    assert.doesNotMatch(document.body.textContent, /secret/);
    let dismissed = false;
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "outside",
          project: { ...project, role: "viewer" },
          tool,
          open: true,
          onOpenChange: (value) => {
            dismissed = !value;
          },
        }),
      ),
    );
    await act(async () =>
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })),
    );
    assert.equal(dismissed, true);
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "authority",
          project: { ...project, role: "unknown" },
          tool,
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    assert.match(document.body.textContent, /Loading Project access/);
    assert.doesNotMatch(document.body.textContent, /Only the Project owner/);
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "authority",
          project,
          tool,
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    const draftInput = document.querySelector("input");
    const draftProps =
      draftInput[Object.keys(draftInput).find((key) => key.startsWith("__reactProps"))];
    await act(async () => draftProps.onChange({ target: { value: "draft@example.com" } }));
    await act(async () =>
      root.render(
        createElement(ProjectSharing, {
          key: "authority",
          project: { ...project, title: "Fresh title" },
          tool,
          open: true,
          onOpenChange() {},
        }),
      ),
    );
    assert.equal(document.querySelector("input"), draftInput);
    assert.equal(draftInput.value, "draft@example.com");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
