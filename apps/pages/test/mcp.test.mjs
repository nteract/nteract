import assert from "node:assert/strict";
import { MAX_PAGE_TITLE } from "../shared/page-title.mjs";
import { REVISION_DOCS, parseRevision } from "../worker/revisions.mjs";
import { test } from "node:test";
import { handleMcp as handleMcpRequest, tools } from "../mcp.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";
import { logUsage } from "../worker/usage.mjs";
import { CURSOR_MAX_LENGTH } from "../worker/catalog-index.mjs";
const env = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example" };
const handleMcp = (request, invoke) => handleMcpRequest(request, invoke, env);
const request = (method, params = {}, id = 1) =>
  new Request("http://127.0.0.1:9477/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "untrusted.example",
      "X-Forwarded-Host": "also-untrusted.example",
      "X-Forwarded-Proto": "http",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
test("patch_page is an unknown tool", async () => {
  const response = await handleMcp(
    request("tools/call", { name: "patch_page", arguments: {} }),
    async () => assert.fail("unknown tool must not run"),
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unknown/i);
});

test("tool schemas use only the JSON Schema subset clients forward as written", () => {
  const refused = ["oneOf", "anyOf", "allOf", "not", "const", "$ref", "$defs", "definitions"];
  const visit = (schema, path) => {
    for (const keyword of refused)
      assert.equal(Object.hasOwn(schema, keyword), false, `${path} uses ${keyword}`);
    const types = [schema.type].flat();
    assert.equal(typeof types[0], "string", `${path} states no type`);
    assert.ok(
      types[0] !== "null" && (types.length === 1 || (types.length === 2 && types[1] === "null")),
      `${path} type`,
    );
    for (const [name, property] of Object.entries(schema.properties ?? {}))
      visit(property, `${path}.${name}`);
    if (schema.items) visit(schema.items, `${path}[]`);
    if (typeof schema.additionalProperties === "object")
      visit(schema.additionalProperties, `${path}.additionalProperties`);
  };
  for (const tool of tools) visit(tool.inputSchema, tool.name);
});

test("tool catalog has a deliberate size ceiling", () => {
  assert.ok(
    JSON.stringify(tools).length <= 39500,
    "Tool catalog grew; raise the ceiling on purpose when a tool grows",
  );
});

test("MCP forwards authorized operations and preserves stale-write failure", async () => {
  const calls = [];
  const response = await handleMcp(
    request("tools/call", {
      name: "edit_page",
      arguments: {
        page_id: "page_x",
        revision: "r7",
        nonce: "request-1234",
        operations: [],
      },
    }),
    async (op, args) => {
      calls.push({ op, args });
      return Response.json(
        {
          error:
            "Page changed since this revision, so the edit was not applied. The refusal carries current_revision: resend at it with a new nonce only if the edit doesn't depend on content that may have changed; otherwise read what you're replacing first",
          code: "stale_revision",
          current_revision: "r9",
          comment_revision: "c4",
        },
        { status: 409 },
      );
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  // The service's revision fields ride along with retryable.
  const expected = {
    error:
      "Page changed since this revision, so the edit was not applied. The refusal carries current_revision: resend at it with a new nonce only if the edit doesn't depend on content that may have changed; otherwise read what you're replacing first",
    code: "stale_revision",
    current_revision: "r9",
    comment_revision: "c4",
    retryable: true,
  };
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
  assert.equal(calls[0].args.revision, "r7");
});

test("MCP gives every refusal a stable code in text and structured content", async () => {
  const call = async (name, reply, args = {}) => {
    const response = await handleMcp(request("tools/call", { name, arguments: args }), reply);
    const result = (await response.json()).result;
    assert.equal(result.isError, true, name);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, name);
    return result.structuredContent;
  };
  // A code the service supplied is kept with every field beside it.
  const conflict = {
    error: "The selected passage changed; read changes before editing again",
    code: "edit_conflict",
    current_revision: "r9",
  };
  assert.deepEqual(
    await call("edit_page", async () => Response.json(conflict, { status: 409 })),
    conflict,
  );
  const selector = {
    error: "replace_match found 0 matches; exactly one is required.",
    code: "invalid_edit_selector",
  };
  assert.deepEqual(
    await call("edit_page", async () => Response.json(selector, { status: 400 })),
    selector,
  );
  // An uncoded refusal is named by its status, which MCP results don't carry.
  for (const [status, code] of [
    [400, "invalid_request"],
    [401, "unauthenticated"],
    [403, "access_denied"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "request_too_large"],
    [418, "request_refused"],
    [500, "server_error"],
  ])
    assert.deepEqual(
      await call("read_page", async () => Response.json({ error: "Refused" }, { status })),
      { error: "Refused", code },
      String(status),
    );
  assert.deepEqual(
    await call("read_page", async () =>
      Response.json(
        {
          error: "Request timed out",
          code: "request_timeout",
          retryable: true,
        },
        { status: 504 },
      ),
    ),
    { error: "Request timed out", code: "request_timeout", retryable: true },
  );
  assert.equal((await call("no_such_tool", async () => assert.fail())).code, "unknown_tool");
  assert.equal((await call("create_space", async () => assert.fail())).code, "tool_renamed");
  // A client that cached import_page_image is sent to the tool that takes its
  // arguments now, before anything runs.
  assert.deepEqual(await call("import_page_image", async () => assert.fail()), {
    error: "`import_page_image` was renamed `create_page_asset_upload`",
    code: "tool_renamed",
  });
  // No answer: reads and writes with a nonce can repeat; progress keeps its lease rule.
  const thrown = async () => {
    throw Error("Private internals");
  };
  const keyed = { nonce: "request-one" };
  for (const [name, code, retryable, args] of [
    ["read_page", "read_failed", true],
    ["edit_page", "outcome_unknown", true, keyed],
    ["manage_page_comment", "outcome_unknown", true, keyed],
    ["create_page", "outcome_unknown", true, keyed],
    // Without a well-formed nonce there is no receipt to replay.
    ["create_page", "outcome_unknown", false],
    ["edit_page", "outcome_unknown", false, { nonce: "short" }],
    ["edit_page", "outcome_unknown", false, { nonce: "x".repeat(65) }],
    ["create_page_asset_upload", "outcome_unknown", true],
    ["report_page_progress", "outcome_unknown", undefined],
  ]) {
    const body = await call(name, thrown, args);
    assert.equal(body.code, code, name);
    assert.equal(body.retryable, retryable, name);
    assert.doesNotMatch(body.error, /Private internals/);
    if (code === "outcome_unknown" && args !== undefined)
      assert.match(
        body.error,
        retryable ? /same nonce and arguments/ : /reconcile before retrying/,
        name,
      );
  }
  // An upload URL stores nothing; a file import may have stored the file.
  assert.match((await call("create_page_asset_upload", thrown)).error, /nothing was stored/);
  const imported = await call("create_page_asset_upload", thrown, { file: {} });
  assert.equal(imported.code, "outcome_unknown");
  assert.equal(imported.retryable, true);
  assert.match(imported.error, /storage may have completed/);
});

test("MCP tools declare every annotation hint, and each tool's hints are intended", async () => {
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const write = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const destructive = { ...write, destructiveHint: true };
  // A new tool fails here until its hints are chosen.
  const intended = {
    get_page_access: read,
    get_project_access: read,
    manage_page_access: destructive,
    manage_project_access: destructive,
    list_pages: read,
    read_page: read,
    read_page_changes: read,
    list_page_comments: read,
    read_page_presence: read,
    list_projects: read,
    get_project: read,
    create_page: write,
    edit_page: write,
    edit_page: write,
    manage_page_comment: write,
    create_project: write,
    update_project: write,
    restore_page: write,
    move_page: write,
    report_page_progress: { ...write, idempotentHint: false },
    create_page_asset_upload: { ...write, openWorldHint: true },
    delete_page: destructive,
    purge_page: destructive,
    delete_project: destructive,
  };
  const response = await handleMcp(request("tools/list"), async () => assert.fail());
  const listed = (await response.json()).result.tools;
  assert.deepEqual(listed.map((tool) => tool.name).sort(), Object.keys(intended).sort());
  for (const tool of listed) assert.deepEqual(tool.annotations, intended[tool.name], tool.name);
});

test("Project tools describe document_id and project_id content addressing, never a home", () => {
  const descriptor = (name) => tools.find((tool) => tool.name === name);
  assert.match(
    descriptor("create_project").description,
    /own editable content and a hierarchy of Pages/,
  );
  assert.match(descriptor("create_project").description, /project_id, document_id .* and url/);
  assert.match(
    descriptor("get_project").description,
    /revision, role, owner, url and document_id[\s\S]*passing project_id instead of page_id/,
  );
  assert.match(descriptor("get_project").description, /content document is not one of them/);
  assert.match(descriptor("list_projects").description, /role, owner, url and document_id/);
  assert.match(descriptor("update_project").description, /does not change its content/);
  assert.match(descriptor("move_page").description, /project_content_protected/);
  assert.match(descriptor("delete_page").description, /project_content_protected/);
  assert.doesNotMatch(JSON.stringify(tools), /home/i);
});

test("every Page tool takes project_id in place of page_id for Project content", async () => {
  const addressed = [
    "read_page",
    "read_page_changes",
    "list_page_comments",
    "read_page_presence",
    "report_page_progress",
    "create_page_asset_upload",
    "edit_page",
    "edit_page",
    "manage_page_comment",
  ];
  for (const name of addressed) {
    const { inputSchema } = tools.find((tool) => tool.name === name);
    const { page_id, project_id } = inputSchema.properties;
    assert.equal(page_id.type, "string", name);
    assert.equal(project_id.pattern, "^(prj|sp)_", name);
    assert.match(project_id.description, /never both \(invalid_arguments\)/i, name);
    // Exactly one of the two: neither is in required; oneOf says which.
    assert.ok(!inputSchema.required.includes("page_id"), name);
    assert.ok(!inputSchema.required.includes("project_id"), name);
    assert.equal(inputSchema.oneOf, undefined);
  }
  // Catalog operations keep page_id required: the content document is not in the tree.
  for (const name of ["delete_page", "restore_page", "move_page", "purge_page"]) {
    const { inputSchema } = tools.find((tool) => tool.name === name);
    assert.ok(inputSchema.required.includes("page_id"), name);
    // move_page's project_id is a destination, never content addressing.
    if (name !== "move_page") assert.equal(inputSchema.properties.project_id, undefined, name);
  }
  // A content read forwards project_id unchanged, keeps the content's own
  // page_id, kind and project_id, and links to the Project rather than /p/.
  const projectId = "prj_55555555-5555-4555-8555-555555555555";
  const args = { project_id: projectId, comments: "none" };
  const body = {
    kind: "project",
    project_id: projectId,
    page_id: pageId,
    title: "Project content",
    blocks: [],
    revision: "r3",
  };
  const response = await handleMcp(
    request("tools/call", { name: "read_page", arguments: args }),
    async (operation, received) => {
      assert.equal(operation, "read_page");
      assert.deepEqual(received, args);
      return Response.json(body);
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    ...body,
    url: `https://pages.example/project/${projectId}`,
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const both = await handleMcp(
    request("tools/call", {
      name: "edit_page",
      arguments: { page_id: pageId, project_id: projectId, operations: [] },
    }),
    async () =>
      Response.json(
        { error: "Give page_id or project_id, not both", code: "invalid_arguments" },
        { status: 400 },
      ),
  );
  const refused = (await both.json()).result;
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.code, "invalid_arguments");
});

test("sharing tools preserve access guards and require separate OAuth consent", async () => {
  for (const target of ["page", "project"]) {
    const name = `manage_${target}_access`;
    const descriptor = tools.find((tool) => tool.name === name);
    assert.deepEqual(descriptor.securitySchemes[0].scopes, [
      "pages:read",
      "pages:write",
      "pages:share",
    ]);
    assert.equal(descriptor.inputSchema.properties.retry_token, undefined);
    assert.ok(descriptor.inputSchema.required.includes("expected_revision"));
    const args = {
      [`${target}_id`]: target === "page" ? pageId : "prj_fixture",
      action: "set_role",
      principal: "anaconda:recipient",
      role: "commenter",
      expected_revision: 3,
      nonce: "share-test-0001",
    };
    const req = request("tools/call", { name, arguments: args });
    req.headers.set("authorization", "Bearer pages_at_fixture");
    const response = await handleMcp(req, async (operation, received) => {
      assert.equal(operation, name);
      assert.deepEqual(received, args);
      return Response.json(
        { code: "oauth_insufficient_scope", error: "Sharing consent required" },
        { status: 403 },
      );
    });
    const result = (await response.json()).result;
    assert.equal(result.isError, true);
    assert.match(
      result._meta["mcp/www_authenticate"][0],
      /scope="pages:read pages:write pages:share"/,
    );
  }
  assert.deepEqual(
    tools.find((tool) => tool.name === "manage_project_access").inputSchema.properties.action,
    {
      type: "string",
      enum: ["invite", "set_role", "revoke_invite", "set_organization_access"],
    },
  );
});

test("Project discovery descriptions distinguish claim reads from Page listings", () => {
  const descriptor = (name) => tools.find((tool) => tool.name === name);
  for (const name of ["get_project", "list_projects"])
    assert.match(descriptor(name).description, /authenticated read can claim/);
  assert.match(descriptor("get_project").description, /the \/project\/ url, not \/p\//);
  assert.match(
    descriptor("list_pages").description,
    /Project Pages you never opened may be missing/,
  );
  assert.match(
    descriptor("list_pages").inputSchema.properties.project_id.description,
    /for owners and members/,
  );
  assert.match(descriptor("get_project_access").description, /expiresAt \(epoch milliseconds\)/);
});

test("Project email invitations forward exact email without requiring principal lookup", async () => {
  const descriptor = tools.find((tool) => tool.name === "manage_project_access");
  assert.ok(!descriptor.inputSchema.required.includes("principal"));
  assert.ok(!descriptor.inputSchema.required.includes("role"));
  assert.match(descriptor.description, /exact known email/);
  assert.match(descriptor.description, /no email is sent/);
  for (const fields of [
    { action: "invite", email: "known.person@example.com", role: "commenter" },
    { action: "revoke_invite", invite_id: "invite-fixture" },
  ]) {
    const args = {
      project_id: "prj_fixture",
      expected_revision: 7,
      nonce: `project-${fields.action}-fixture`,
      ...fields,
    };
    const receipt = { project_id: args.project_id, revision: 8, members: {}, invites: [] };
    const response = await handleMcp(
      request("tools/call", { name: "manage_project_access", arguments: args }),
      async (operation, received) => {
        assert.equal(operation, "manage_project_access");
        assert.deepEqual(received, args);
        assert.equal(received.principal, undefined);
        return Response.json(receipt);
      },
    );
    const result = (await response.json()).result;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.invites, []);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
});

test("MCP advertises typed image insertion and echoes its exact receipt as structured content", async () => {
  const descriptor = tools.find((tool) => tool.name === "edit_page");
  const schema = descriptor.inputSchema.properties.operations.items;
  assert.ok(schema.properties.op.enum.includes("insert_image"));
  assert.deepEqual(schema.required, ["op"]);
  assert.equal(schema.additionalProperties, false);
  const asset_id = "a".repeat(64);
  const receipt = {
    page_id: pageId,
    heads: ["b".repeat(64)],
    result: {
      page_id: pageId,
      edits: [
        {
          op: "insert_image",
          node_id: "12@ab",
          nodes: ["13@ab"],
          image: "14@ab",
          asset_id,
          asset_url: `/api/pages/${pageId}/assets/${asset_id}`,
          alt: "A cat",
        },
      ],
    },
  };
  const response = await handleMcp(
    request("tools/call", {
      name: "edit_page",
      arguments: {
        page_id: pageId,
        operations: [{ op: "insert_image", asset_id, alt: "A cat" }],
      },
    }),
    async () => Response.json(receipt),
  );
  const result = (await response.json()).result;
  assert.deepEqual(result.structuredContent, {
    ...receipt,
    url: `https://pages.example/p/${pageId}`,
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});
test("MCP refuses resource URLs outside this service before invoking tools", async () => {
  let invoked = false;
  const response = await handleMcp(
    request("resources/read", {
      uri: "https://elsewhere.example/?page=page_" + "a".repeat(32),
    }),
    async () => {
      invoked = true;
      return Response.json({});
    },
  );
  assert.equal(invoked, false);
  assert.ok((await response.json()).error);
});
const pageId = "1a160b47-6df1-4983-81eb-489ca5a26812";
test("MCP change budgets count both representations, escaping and the JSON-RPC ID", async () => {
  for (const [markdown, maxBytes, succeeds] of [
    ["small passage", 4096, true],
    ["a".repeat(70000), 131072, false],
    ['"\\\n🌳'.repeat(150), 4096, false],
  ]) {
    const body = {
      page_id: pageId,
      revision: "r3",
      changes: [{ node_id: "4@ab", block: "3@ab", scope: "node", change: "updated", markdown }],
    };
    const response = await handleMcp(
      request("tools/call", {
        name: "read_page_changes",
        arguments: {
          page_id: pageId,
          since_revision: "r2",
          max_bytes: maxBytes,
        },
      }),
      async () => Response.json(body),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length <= maxBytes, `Complete response ${bytes.length} exceeds ${maxBytes}`);
    const result = JSON.parse(new TextDecoder().decode(bytes)).result;
    assert.equal(result.isError === true, !succeeds);
    if (succeeds) assert.equal(result.structuredContent.changes[0].markdown, markdown);
    else {
      const failure = JSON.parse(result.content[0].text);
      assert.equal(failure.code, "changes_budget_exceeded");
      assert.equal(failure.changes, undefined);
      assert.deepEqual(result.structuredContent, failure);
      assert.equal(failure.revision, "r3");
    }
  }
  const tooLarge = await handleMcp(
    request(
      "tools/call",
      { name: "read_page_changes", arguments: { max_bytes: 4096 } },
      "x".repeat(5000),
    ),
    async () => Response.json({ revision: "r1", changes: [] }),
  );
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "mcp_request_id_too_large");
});
test("MCP exposes net changes and node-scoped target edits without changing exact receipts", async () => {
  const changeTool = tools.find((tool) => tool.name === "read_page_changes");
  assert.deepEqual(changeTool.securitySchemes[0].scopes, ["pages:read"]);
  assert.equal(changeTool.annotations.readOnlyHint, true);
  const editTool = tools.find((tool) => tool.name === "edit_page");
  assert.deepEqual(editTool.inputSchema.properties.conflict_scope.enum, ["page", "target"]);
  const match = editTool.inputSchema.properties.operations.items;
  assert.equal(match.properties.node_id.type, "string");
  assert.equal(match.properties.node_index, undefined);
  const args = {
    page_id: pageId,
    since_revision: "r2",
    comments: "none",
  };
  const body = {
    page_id: pageId,
    heads: ["c".repeat(64)],
    changes: [],
    comments: [],
    title_changed: false,
    attribution: "unavailable",
  };
  const response = await handleMcp(
    request("tools/call", { name: "read_page_changes", arguments: args }),
    async (op, received) => {
      assert.equal(op, "read_page_changes");
      assert.deepEqual(received, args);
      return Response.json(body);
    },
  );
  const result = (await response.json()).result;
  assert.deepEqual(result.structuredContent, {
    ...body,
    url: `https://pages.example/p/${pageId}`,
  });
  assert.equal(result.isError, undefined);
  const conflict = {
    code: "edit_conflict",
    current_heads: ["c".repeat(64)],
    conflicts: [{ node_id: "7@ab", reason: "Target changed" }],
  };
  const failed = await handleMcp(
    request("tools/call", {
      name: "edit_page",
      arguments: { page_id: pageId, conflict_scope: "target" },
    }),
    async () => Response.json(conflict, { status: 409 }),
  );
  const failure = (await failed.json()).result;
  assert.equal(failure.isError, true);
  assert.deepEqual(JSON.parse(failure.content[0].text).conflicts, conflict.conflicts);
});
test("MCP initialization guides title authoring and successful receipts preserve advisory warnings", async () => {
  const initialization = await handleMcp(
    request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "title-warning-test", version: "1" },
    }),
    async () => {
      throw Error("Initialization must not invoke a document tool");
    },
  );
  const initialized = (await initialization.json()).result;
  assert.equal(initialized.serverInfo.name, PRODUCT_NAME);
  assert.equal(initialized.serverInfo.name, "Pages");
  const [orientation, ...rest] = initialized.instructions.split("\n");
  assert.match(orientation, /^Start with list_pages/);
  assert.match(
    rest.join("\n"),
    /Projects have editable content[\s\S]*url field[\s\S]*opening_heading_repeats_title/,
  );
  const receipt = {
    page_id: pageId,
    heads: ["b".repeat(64)],
    warnings: [
      {
        code: "opening_heading_repeats_title",
        node_id: "2@ab",
        heading: "A document title",
        match_kind: "normalized_exact",
        suggested_action: "Read the current opening before correcting an accidental duplicate.",
      },
    ],
  };
  for (const name of ["create_page", "edit_page"]) {
    const response = await handleMcp(request("tools/call", { name, arguments: {} }), async () =>
      Response.json(receipt),
    );
    const result = (await response.json()).result;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.warnings, receipt.warnings);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
});
test("MCP advertises and forwards selective reads and read-only compact comments", async () => {
  for (const [name, args] of [
    [
      "read_page",
      {
        page_id: pageId,
        section: "Repeated",
        section_occurrence: 2,
        comments: "none",
        max_bytes: 8192,
      },
    ],
    [
      "list_page_comments",
      {
        page_id: pageId,
        state: "open",
        thread_ids: ["thread-id"],
        include_messages: false,
      },
    ],
  ]) {
    const descriptor = tools.find((tool) => tool.name === name);
    assert.equal(descriptor.annotations.readOnlyHint, true);
    assert.deepEqual(descriptor.securitySchemes[0].scopes, ["pages:read"]);
    let called = false;
    const result = await handleMcp(
      request("tools/call", { name, arguments: args }),
      async (op, received) => {
        called = true;
        assert.equal(op, name);
        assert.deepEqual(received, args);
        return Response.json({
          page_id: pageId,
          revision: "r1",
          comments: [],
        });
      },
    );
    assert.equal(called, true);
    assert.equal((await result.json()).result.structuredContent.revision, "r1");
  }
});

test("MCP preserves actionable read-budget errors and does not suggest mutation retries for reads", async () => {
  const budget = {
    error: "Too large",
    code: "read_budget_exceeded",
    heads: ["head"],
    outline: { entries: [], total: 0, offset: 0, next_offset: null },
  };
  const result = await handleMcp(
    request("tools/call", {
      name: "read_page",
      arguments: { page_id: pageId },
    }),
    async () => Response.json(budget, { status: 413 }),
  );
  const body = (await result.json()).result;
  assert.equal(body.isError, true);
  assert.deepEqual(JSON.parse(body.content[0].text), budget);
  const failed = await handleMcp(
    request("tools/call", {
      name: "list_page_comments",
      arguments: { page_id: pageId },
    }),
    async () => {
      throw Error("Private internals");
    },
  );
  const message = (await failed.json()).result.content[0].text;
  assert.match(message, /Retry the read/);
  assert.doesNotMatch(message, /same key|Private internals/);
});
test("MCP advertises ephemeral progress with write scope and reads presence without edit authority", async () => {
  const progress = tools.find((tool) => tool.name === "report_page_progress");
  assert.deepEqual(progress.securitySchemes[0].scopes, ["pages:read", "pages:write"]);
  assert.equal(progress.annotations.destructiveHint, false);
  assert.equal(progress.inputSchema.properties.retry_token, undefined);
  assert.equal(progress.inputSchema.properties.targets.maxItems, 3);
  const presence = tools.find((tool) => tool.name === "read_page_presence");
  assert.deepEqual(presence.securitySchemes[0].scopes, ["pages:read"]);
  assert.match(presence.description, /not proof|do not prove/);
  for (const [name, args, body] of [
    [
      "report_page_progress",
      { page_id: pageId, message: "Checking the summary" },
      {
        page_id: pageId,
        progress_id: "activity-1",
        lease_token: "private-capability",
      },
    ],
    [
      "read_page_presence",
      { page_id: pageId },
      { page_id: pageId, participants: [], progress: [], heads: [] },
    ],
  ]) {
    const response = await handleMcp(
      request("tools/call", { name, arguments: args }),
      async (op, received) => {
        assert.equal(op, name);
        assert.deepEqual(received, args);
        return Response.json(body);
      },
    );
    assert.deepEqual((await response.json()).result.structuredContent, {
      ...body,
      url: `https://pages.example/p/${pageId}`,
    });
  }
  const failed = await handleMcp(
    request("tools/call", {
      name: "report_page_progress",
      arguments: { page_id: pageId, message: "Working" },
    }),
    async () => {
      throw Error("Private server details");
    },
  );
  const message = (await failed.json()).result.content[0].text;
  assert.match(message, /document was not edited/);
  assert.match(message, /expires within 60 seconds/);
  assert.doesNotMatch(message, /idempotency|same key|Private server details/);
});
test("MCP creation and listings use the configured HTTPS origin behind an HTTP proxy", async () => {
  const response = await handleMcp(
    request("tools/call", {
      name: "create_page",
      arguments: { title: "Test", nonce: "create-route" },
    }),
    async () => Response.json({ page_id: pageId, title: "Test" }),
  );
  const created = JSON.parse((await response.json()).result.content[0].text);
  // A result's url carries the title's slug; a resource uri is the bare link.
  assert.equal(created.url, `https://pages.example/p/${pageId}/Test`);
  const list = await handleMcp(request("resources/list"), async () =>
    Response.json({ pages: [{ page_id: pageId, title: "Test" }] }),
  );
  assert.equal((await list.json()).result.resources[0].uri, `https://pages.example/p/${pageId}`);
});
test("MCP reads canonical and legacy links while rejecting ambiguous resource URLs", async () => {
  for (const uri of [
    `https://pages.example/p/${pageId}`,
    `https://pages.example/p/${pageId}/Any-Title`,
    `https://pages.example/?page=${pageId}`,
  ]) {
    let invoked = false;
    const response = await handleMcp(request("resources/read", { uri }), async (op, args) => {
      invoked = true;
      assert.equal(op, "read_page");
      assert.equal(args.page_id, pageId);
      return Response.json({ page_id: pageId });
    });
    assert.equal((await response.json()).result.contents[0].uri, uri);
    assert.equal(invoked, true);
  }
  for (const uri of [
    `https://pages.example/p/${pageId}?other=1`,
    `https://pages.example/p/${pageId}#other`,
    `https://pages.example/p/${pageId}/Any-Title/`,
    `https://pages.example/p/${pageId}/view`,
    `https://pages.example/?page=${pageId}&other=1`,
    `http://127.0.0.1:9477/p/${pageId}`,
    `http://pages.example/p/${pageId}`,
    `https://untrusted.example/p/${pageId}`,
    `https://also-untrusted.example/p/${pageId}`,
  ]) {
    let invoked = false;
    const response = await handleMcp(request("resources/read", { uri }), async () => {
      invoked = true;
      return Response.json({});
    });
    assert.ok((await response.json()).error);
    assert.equal(invoked, false);
  }
});

test("MCP advertises visible-text replacement separately from Markdown replacement", async () => {
  const edit = tools.find((tool) => tool.name === "edit_page");
  const operation = edit.inputSchema.properties.operations.items;
  assert.ok(operation.properties.op.enum.includes("replace_match"));
  assert.deepEqual(operation.required, ["op"]);
  assert.ok(operation.properties.remove.items.enum.includes("strong"));
  assert.equal(operation.properties.add.properties.strong.type, "boolean");
  assert.equal(operation.properties.replacement.type, "string");
  assert.equal(operation.properties.replacement_markdown.type, "string");
  assert.equal(operation.properties.context_before.type, "string");
  assert.equal(operation.properties.context_after.type, "string");
  const args = {
    page_id: pageId,
    revision: "r1",
    nonce: "replace-visible-text",
    operations: [
      {
        op: "replace_match",
        node_id: "5@ab",
        match_text: "word",
        replacement: "phrase",
        context_before: "second",
      },
    ],
  };
  const response = await handleMcp(
    request("tools/call", { name: "edit_page", arguments: args }),
    async (operation, received) => {
      assert.equal(operation, "edit_page");
      assert.deepEqual(received, args);
      return Response.json({
        page_id: pageId,
        result: {
          edits: [{ op: "replace_match", node_id: "5@ab", matched: 1 }],
        },
      });
    },
  );
  assert.equal(
    JSON.parse((await response.json()).result.content[0].text).result.edits[0].matched,
    1,
  );
});

test("MCP list and read tool links use the public origin regardless of proxy headers", async () => {
  for (const [name, body] of [
    ["list_pages", { pages: [{ page_id: pageId, title: "Test" }] }],
    ["read_page", { page_id: pageId, title: "Test", blocks: [] }],
  ]) {
    const response = await handleMcp(
      request("tools/call", {
        name,
        arguments: name === "read_page" ? { page_id: pageId } : {},
      }),
      async () => Response.json(body),
    );
    const result = JSON.parse((await response.json()).result.content[0].text);
    assert.equal((result.pages?.[0] ?? result).url, `https://pages.example/p/${pageId}/Test`);
  }
  // A result without the title links to the bare address: nothing reads the
  // title just to build a link.
  for (const [name, body] of [
    ["list_pages", { pages: [{ page_id: pageId }] }],
    ["read_page", { page_id: pageId, blocks: [] }],
    ["list_pages", { pages: [{ page_id: pageId, title: "日本語" }] }],
  ]) {
    const response = await handleMcp(
      request("tools/call", {
        name,
        arguments: name === "read_page" ? { page_id: pageId } : {},
      }),
      async () => Response.json(body),
    );
    const result = JSON.parse((await response.json()).result.content[0].text);
    assert.equal((result.pages?.[0] ?? result).url, `https://pages.example/p/${pageId}`);
  }
});

test("MCP does not fall back to the request URL when public origin configuration is missing", async () => {
  await assert.rejects(() =>
    handleMcpRequest(request("tools/list"), async () => Response.json({}), {}),
  );
});

test("MCP tool metadata declares the OAuth scopes needed by each operation", async () => {
  const response = await handleMcp(request("tools/list"), async () =>
    assert.fail("listing invoked an operation"),
  );
  const listed = (await response.json()).result.tools;
  assert.equal(listed.length, tools.length);
  for (const tool of listed) {
    assert.deepEqual(
      tool.securitySchemes,
      [
        {
          type: "oauth2",
          scopes: [
            ...([
              "get_page_access",
              "get_project_access",
              "list_pages",
              "read_page",
              "read_page_changes",
              "list_page_comments",
              "read_page_presence",
              "list_projects",
              "get_project",
            ].includes(tool.name)
              ? ["pages:read"]
              : ["pages:read", "pages:write"]),
            ...([
              "get_page_access",
              "get_project_access",
              "manage_page_access",
              "manage_project_access",
            ].includes(tool.name)
              ? ["pages:share"]
              : []),
          ],
        },
      ],
      tool.name,
    );
  }
});

test("create_page_asset_upload advertises a client's complete file descriptor and keeps the private asset URL", async () => {
  const listed = await handleMcp(request("tools/list"), async () => assert.fail("unexpected call"));
  const descriptor = (await listed.json()).result.tools.find(
    (tool) => tool.name === "create_page_asset_upload",
  );
  assert.deepEqual(descriptor._meta, { "openai/fileParams": ["file"] });
  const fileSchema = descriptor.inputSchema.properties.file;
  assert.deepEqual(Object.keys(fileSchema.properties).sort(), [
    "download_url",
    "file_id",
    "file_name",
    "mime_type",
  ]);
  assert.deepEqual(fileSchema.required, ["download_url", "file_id"]);
  assert.equal(fileSchema.additionalProperties, false);
  // page_id or project_id; file is optional.
  assert.deepEqual(descriptor.inputSchema.required, []);
  assert.equal(descriptor.inputSchema.oneOf, undefined);
  assert.deepEqual(descriptor.securitySchemes[0].scopes, ["pages:read", "pages:write"]);
  assert.equal(descriptor.annotations.destructiveHint, false);
  assert.equal(descriptor.annotations.openWorldHint, true);

  const file = {
    download_url: "https://files.oaiusercontent.com/file-fixture?temporary=secret",
    file_id: "file-fixture",
  };
  const assetUrl = `/api/pages/${pageId}/assets/${"a".repeat(64)}`;
  const response = await handleMcp(
    request("tools/call", {
      name: "create_page_asset_upload",
      arguments: { page_id: pageId, file },
    }),
    async (operation, args) => {
      assert.equal(operation, "create_page_asset_upload");
      assert.deepEqual(args, { page_id: pageId, file });
      return Response.json({
        page_id: pageId,
        asset_url: assetUrl,
        mime_type: "image/png",
      });
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  const asset = JSON.parse(result.content[0].text);
  assert.equal(asset.asset_url, assetUrl);
  assert.equal(asset.url, `https://pages.example/p/${pageId}`);
  assert.equal(JSON.stringify(result).includes("temporary=secret"), false);
});

test("MCP lists create_page_asset_upload for any client with write scope, and points other image paths at it", async () => {
  const listed = await handleMcp(request("tools/list"), async () => assert.fail("unexpected call"));
  const all = (await listed.json()).result.tools;
  assert.equal(
    all.find((tool) => tool.name === "import_page_image"),
    undefined,
    "one tool adds a file",
  );
  const descriptor = all.find((tool) => tool.name === "create_page_asset_upload");
  assert.deepEqual(descriptor.securitySchemes, [
    { type: "oauth2", scopes: ["pages:read", "pages:write"] },
  ]);
  assert.deepEqual(Object.keys(descriptor.inputSchema.properties).sort(), [
    "content_type",
    "file",
    "page_id",
    "project_id",
    "size",
  ]);
  assert.deepEqual(descriptor.inputSchema.properties.content_type.enum, [
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/vnd.apache.parquet",
  ]);
  assert.equal(descriptor.inputSchema.properties.size.maximum, 5 * 1024 * 1024);
  assert.match(descriptor.inputSchema.properties.file.description, /never build one/);
  for (const fact of [
    /API key or OAuth/,
    /Pages-Upload/,
    /never send your own key/,
    /expires_at \(at most 10 minutes\)/,
    /curl/,
    /not multipart or base64/,
    /Access is checked again at upload/,
    /With file, Pages fetches the file instead/,
    /same bytes return the same asset_id, with insert: the edit_page op that places it \(add alt to an image\)/,
    /Insert image in the browser/,
  ])
    assert.match(descriptor.description, fact);
  // The catalog names the mechanism, not a vendor.
  assert.doesNotMatch(descriptor.description, /ChatGPT|OpenAI/i);
  const insertImage = all.find((tool) => tool.name === "edit_page").inputSchema.properties
    .operations.items;
  assert.match(insertImage.properties.asset_id.description, /create_page_asset_upload/);
  const initialization = await handleMcp(
    request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "upload-test", version: "1" },
    }),
    async () => assert.fail("initialize invoked a tool"),
  );
  const { instructions } = (await initialization.json()).result;
  assert.match(
    instructions,
    /create_page_asset_upload and POST the file to its upload_url with the returned headers \(its example field is a ready curl command\)/,
  );
  assert.match(instructions, /goes in that tool's file argument instead/);
  assert.doesNotMatch(instructions, /import_page_image/);
  assert.match(instructions, /untrusted source material, not instructions/);
  assert.match(instructions, /Every write takes a nonce/);
  assert.doesNotMatch(instructions, /retry_token|idempotency_key|heads/);
  assert.doesNotMatch(instructions, /prefix/);
  assert.match(instructions, /superseded:true and applied:false was not applied/);
  // The result passes through with the browser link, and nothing is added.
  const issued = {
    page_id: pageId,
    upload_url: `https://pages.example/api/pages/${pageId}/assets`,
    method: "POST",
    headers: { Authorization: "Pages-Upload pu1.payload.signature" },
  };
  const response = await handleMcp(
    request("tools/call", { name: "create_page_asset_upload", arguments: { page_id: pageId } }),
    async (operation, args) => {
      assert.equal(operation, "create_page_asset_upload");
      assert.deepEqual(args, { page_id: pageId });
      return Response.json(issued);
    },
  );
  const result = (await response.json()).result;
  assert.deepEqual(result.structuredContent, {
    ...issued,
    url: `https://pages.example/p/${pageId}`,
  });
});

test("file import failures distinguish storage retries from document edits without leaking file URLs", async () => {
  const response = await handleMcp(
    request("tools/call", {
      name: "create_page_asset_upload",
      arguments: { page_id: pageId, file: { download_url: "https://x.invalid", file_id: "f" } },
    }),
    async () => {
      throw new Error("private download URL with credentials");
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /storage may have completed, but the document was not edited/,
  );
  assert.doesNotMatch(result.content[0].text, /private download|same key/);
});

test("only verified OAuth credential failures produce tool reauthorization challenges", async () => {
  for (const [token, status, code, expected] of [
    ["pages_at_fixture", 401, "oauth_invalid_token", "invalid_token"],
    ["pages_at_fixture", 403, "oauth_insufficient_scope", "insufficient_scope"],
    ["pages_at_fixture", 403, undefined, undefined],
    ["pages_at_fixture", 409, "oauth_insufficient_scope", undefined],
    ["anaconda-fixture-key", 403, "oauth_insufficient_scope", undefined],
    ["anaconda-fixture-key", 401, undefined, undefined],
  ]) {
    const req = request("tools/call", {
      name: "read_page",
      arguments: { page_id: pageId },
    });
    req.headers.set("authorization", `Bearer ${token}`);
    const response = await handleMcp(req, async () =>
      Response.json({ error: "Denied", ...(code && { code }) }, { status }),
    );
    const result = (await response.json()).result;
    assert.equal(result.isError, true);
    if (!expected) {
      assert.equal(result._meta, undefined);
      continue;
    }
    const [challenge] = result._meta["mcp/www_authenticate"];
    assert.match(challenge, new RegExp(`error="${expected}"`));
    assert.match(challenge, /error_description="[^"\n]+"/);
    assert.match(challenge, /scope="pages:read"/);
    assert.ok(
      challenge.includes(
        'resource_metadata="https://pages.example/.well-known/oauth-protected-resource/mcp"',
      ),
    );
    assert.equal(challenge.includes(token), false);
    assert.equal(challenge.includes("untrusted.example"), false);
    assert.equal(challenge.includes("127.0.0.1"), false);
  }
});
test("initialize hands out a presence session id; other calls don't, and stay stateless", async () => {
  const init = await handleMcp(
    request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "session-test", version: "1" },
    }),
    async () => {
      throw Error("Initialization must not invoke a document tool");
    },
  );
  const id = init.headers.get("mcp-session-id");
  assert.match(id, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
  const again = await handleMcp(
    request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "session-test", version: "1" },
    }),
    async () => {},
  );
  assert.notEqual(again.headers.get("mcp-session-id"), id);
  // A tool call with or without the id works without server-side session state.
  const list = await handleMcp(request("tools/list"), async () => {});
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("mcp-session-id"), null);
});

test("an initialize whose usage hook throws still succeeds, and the loss is counted", async (t) => {
  const lines = [];
  t.mock.method(console, "info", (line) => lines.push(JSON.parse(line)));
  const init = await handleMcpRequest(
    request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hook-test", version: "1" },
    }),
    async () => assert.fail("initialize invokes no tool"),
    env,
    {
      onInitialize() {
        throw Error("usage sink exploded");
      },
    },
  );
  assert.equal(init.status, 200);
  assert.equal((await init.json()).result.serverInfo.name.length > 0, true);
  assert.match(init.headers.get("mcp-session-id"), /^[0-9a-f-]{36}\./);
  const next = logUsage({ action: "sync.open", surface: "browser-sync" });
  assert.ok(next.dropped >= 1);
  assert.equal(lines.at(-1).dropped, next.dropped);
});

test("MCP resources reach invoke() as kind resource; tool calls carry no kind", async () => {
  const calls = [];
  const invoke = async (operation, args, options) => {
    calls.push({ operation, options });
    return Response.json(
      operation === "list_pages"
        ? { pages: [] }
        : {
            page_id: "44444444-4444-4444-8444-444444444444",
            title: "T",
            blocks: [],
          },
    );
  };
  assert.equal((await handleMcp(request("resources/list"), invoke)).status, 200);
  assert.equal(
    (
      await handleMcp(
        request("resources/read", {
          uri: "https://pages.example/p/44444444-4444-4444-8444-444444444444",
        }),
        invoke,
      )
    ).status,
    200,
  );
  await handleMcp(
    request("tools/call", {
      name: "read_page",
      arguments: { page_id: "44444444-4444-4444-8444-444444444444" },
    }),
    invoke,
  );
  assert.deepEqual(calls, [
    { operation: "list_pages", options: { kind: "resource" } },
    { operation: "read_page", options: { kind: "resource" } },
    { operation: "read_page", options: undefined },
  ]);
});

test("MCP list_pages advertises access and sort and forwards them unchanged", async () => {
  const descriptor = tools.find((tool) => tool.name === "list_pages");
  const { access, sort, cursor } = descriptor.inputSchema.properties;
  assert.deepEqual(access.enum, ["owned", "shared"]);
  assert.deepEqual(sort.enum, ["activity", "created", "title"]);
  assert.match(access.description, /in_trash or project_id/);
  assert.match(sort.description, /activity \(default\)/);
  assert.match(sort.description, /content_updated_at/);
  assert.match(sort.description, /created lists the newest first/);
  assert.match(descriptor.description, /content_updated_at/);
  assert.equal(cursor.maxLength, CURSOR_MAX_LENGTH, "a title-sorted cursor must fit");
  assert.deepEqual(descriptor.inputSchema.required, []);
  const calls = [];
  const response = await handleMcp(
    request("tools/call", {
      name: "list_pages",
      arguments: { access: "shared", sort: "created", limit: 5 },
    }),
    async (operation, args) => {
      calls.push({ operation, args });
      return Response.json({ pages: [], limit: 5, next_cursor: null });
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      operation: "list_pages",
      args: { access: "shared", sort: "created", limit: 5 },
    },
  ]);
});

test("MCP advertises thread_ids for batch resolve and keeps the refusal's named IDs", async () => {
  const descriptor = tools.find((tool) => tool.name === "manage_page_comment");
  const { thread_id, thread_ids } = descriptor.inputSchema.properties;
  assert.equal(thread_id.type, "string");
  assert.deepEqual(
    {
      type: thread_ids.type,
      minItems: thread_ids.minItems,
      maxItems: thread_ids.maxItems,
      uniqueItems: thread_ids.uniqueItems,
      items: thread_ids.items,
    },
    {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 256 },
    },
  );
  assert.deepEqual(descriptor.inputSchema.required, ["nonce", "action"]);
  assert.match(descriptor.description, /thread_ids/);
  assert.match(descriptor.description, /not_found_thread_ids/);
  // Resolving keeps every message; a status change is not destructive.
  assert.equal(descriptor.annotations.destructiveHint, false);
  assert.equal(descriptor.annotations.idempotentHint, true);

  const calls = [];
  const refusal = {
    error:
      "1 of 2 comment threads not found; nothing was changed. not_found_thread_ids names them.",
    code: "invalid_comment_selector",
    not_found_thread_ids: ["gone"],
  };
  const response = await handleMcp(
    request("tools/call", {
      name: "manage_page_comment",
      arguments: {
        page_id: "page_x",
        nonce: "batch-1234",
        action: "resolve",
        thread_ids: ["kept", "gone"],
      },
    }),
    async (op, args) => {
      calls.push({ op, args });
      return Response.json(refusal, { status: 400 });
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, refusal);
  assert.deepEqual(calls[0].args.thread_ids, ["kept", "gone"]);
});

test("every write takes a nonce, a Page write a revision, and nothing takes heads or a retry token", () => {
  const schemas = JSON.stringify(tools);
  for (const name of [
    "retry_token",
    "idempotency_key",
    "base_heads",
    "expected_heads",
    "since_heads",
  ])
    assert.doesNotMatch(schemas, new RegExp(name), name);
  const unkeyed = new Set(["report_page_progress", "create_page_asset_upload"]);
  for (const tool of tools) {
    if (tool.annotations.readOnlyHint || unkeyed.has(tool.name)) continue;
    const { properties, required } = tool.inputSchema;
    assert.equal(properties.nonce?.pattern, "^[A-Za-z0-9_-]{6,64}$", tool.name);
    // A preview changes nothing, so only a confirm needs one.
    assert.equal(
      required.includes("nonce"),
      !["purge_page", "delete_project"].includes(tool.name),
      tool.name,
    );
  }
  const edit = tools.find((tool) => tool.name === "edit_page").inputSchema;
  assert.ok(edit.required.includes("revision"));
  assert.equal(edit.properties.revision.pattern, "^r[1-9][0-9]{0,15}$");
  const move = tools.find((tool) => tool.name === "move_page").inputSchema;
  assert.deepEqual(move.required, ["page_id", "nonce"]);
});

test("revision, tag and title schemas follow the host's own rules", () => {
  const schema = (name) => tools.find((tool) => tool.name === name).inputSchema.properties;
  const accepts = (property, value) => new RegExp(property.pattern).test(value);
  // Each revision argument's pattern takes exactly the handles parseRevision
  // takes for it: since_comment_revision the comments' letter, every other
  // one the Page's. Checked against every letter the host mints.
  const letters = Object.values(REVISION_DOCS);
  for (const tool of tools)
    for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
      if (!name.endsWith("revision") || name === "source_revision" || !property.pattern) continue;
      const own = REVISION_DOCS[name === "since_comment_revision" ? "comments" : "page"];
      for (const letter of letters)
        assert.equal(
          accepts(property, `${letter}12`),
          letter === own,
          `${tool.name}.${name} ${letter}`,
        );
      assert.equal(
        parseRevision(`${own}12`, name === "since_comment_revision" ? "comments" : "page"),
        12,
      );
    }
  // A Page title has the one limit create_page and set_title enforce.
  assert.equal(schema("create_page").title.maxLength, MAX_PAGE_TITLE);
  assert.match(
    schema("edit_page").operations.items.properties.title.description,
    new RegExp(`up to ${MAX_PAGE_TITLE} characters`),
  );
});

test("no MCP tool tells a caller to build its key from a prefix", () => {
  const schemas = JSON.stringify(tools);
  assert.doesNotMatch(schemas, /retry_key_prefix/);
  assert.doesNotMatch(schemas, /v1_/);
  for (const tool of tools) {
    const key = tool.inputSchema.properties?.nonce;
    if (key?.description) assert.doesNotMatch(key.description, /prefix/, tool.name);
  }
});

test("MCP Events stays unavailable until durable delivery and safe transport are integrated", async () => {
  const invoke = async () => assert.fail("event groundwork must not invoke a tool");
  const response = await handleMcp(
    request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "event-boundary-test", version: "1" },
    }),
    invoke,
  );
  const initialized = (await response.json()).result;
  assert.ok(initialized.capabilities.tools);
  assert.equal(Object.hasOwn(initialized.capabilities, "events"), false);
  for (const method of ["events/list", "events/subscribe", "events/unsubscribe"]) {
    const result = await handleMcp(request(method), invoke);
    assert.equal((await result.json()).error.code, -32601, method);
  }
});
