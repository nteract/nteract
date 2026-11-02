import assert from "node:assert/strict";
import { test } from "node:test";
import { handleMcp as handleMcpRequest, tools } from "../mcp.mjs";
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
test("MCP forwards authorized operations and preserves stale-write failure", async () => {
  const calls = [];
  const response = await handleMcp(
    request("tools/call", {
      name: "edit_page",
      arguments: {
        page_id: "page_x",
        base_heads: ["old"],
        idempotency_key: "request-1234",
        operations: [],
      },
    }),
    async (op, args) => {
      calls.push({ op, args });
      return Response.json(
        {
          error: "Page changed; read_page again before editing",
          code: "stale_heads",
          current_heads: ["c".repeat(64)],
          comment_heads: ["d".repeat(64)],
        },
        { status: 409 },
      );
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  // The service's revision fields ride along with retryable.
  const expected = {
    error: "Page changed; read_page again before editing",
    code: "stale_heads",
    current_heads: ["c".repeat(64)],
    comment_heads: ["d".repeat(64)],
    retryable: true,
  };
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
  assert.deepEqual(calls[0].args.base_heads, ["old"]);
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
    current_heads: ["c".repeat(64)],
  };
  assert.deepEqual(
    await call("patch_page", async () => Response.json(conflict, { status: 409 })),
    conflict,
  );
  const selector = {
    error: "replace_match found 0 matches; exactly one is required.",
    code: "invalid_edit_selector",
  };
  assert.deepEqual(
    await call("patch_page", async () => Response.json(selector, { status: 400 })),
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
        { error: "Request timed out", code: "request_timeout", retryable: true },
        { status: 504 },
      ),
    ),
    { error: "Request timed out", code: "request_timeout", retryable: true },
  );
  assert.equal((await call("no_such_tool", async () => assert.fail())).code, "unknown_tool");
  assert.equal((await call("create_space", async () => assert.fail())).code, "tool_renamed");
  // No answer: reads and keyed writes can repeat; progress keeps its lease rule.
  const thrown = async () => {
    throw Error("Private internals");
  };
  const tokened = {
    retry_token: "token",
    idempotency_key: `v1_${"a".repeat(64)}_request-one`,
  };
  for (const [name, code, retryable, args] of [
    ["read_page", "read_failed", true],
    ["edit_page", "outcome_unknown", true, tokened],
    ["manage_page_comment", "outcome_unknown", true, tokened],
    // A tokenless receipt is kept best-effort, so a blind retry can apply twice.
    ["edit_page", "outcome_unknown", false, { idempotency_key: "plain-key-1" }],
    ["manage_page_comment", "outcome_unknown", false, { idempotency_key: "plain-key-2" }],
    ["create_page", "outcome_unknown", false],
    // Mismatched combos are tokenless: a v1_ key without its token, or a token
    // beside a plain key, can't replay through the token lane.
    [
      "edit_page",
      "outcome_unknown",
      false,
      { idempotency_key: `v1_${"a".repeat(64)}_request-two` },
    ],
    [
      "edit_page",
      "outcome_unknown",
      false,
      { retry_token: "token", idempotency_key: "plain-key-3" },
    ],
    ["import_page_image", "outcome_unknown", true],
    ["report_page_progress", "outcome_unknown", undefined],
  ]) {
    const body = await call(name, thrown, args);
    assert.equal(body.code, code, name);
    assert.equal(body.retryable, retryable, name);
    assert.doesNotMatch(body.error, /Private internals/);
    if (code === "outcome_unknown" && args !== undefined)
      assert.match(
        body.error,
        retryable ? /same key, token and payload/ : /reconcile before retrying/,
        name,
      );
  }
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
    list_pages: read,
    read_page: read,
    read_page_changes: read,
    list_page_comments: read,
    read_page_presence: read,
    list_projects: read,
    get_project: read,
    create_page: write,
    edit_page: write,
    patch_page: write,
    manage_page_comment: write,
    create_project: write,
    update_project: write,
    restore_page: write,
    move_page: write,
    report_page_progress: { ...write, idempotentHint: false },
    import_page_image: { ...write, openWorldHint: true },
    delete_page: destructive,
    purge_page: destructive,
  };
  const response = await handleMcp(request("tools/list"), async () => assert.fail());
  const listed = (await response.json()).result.tools;
  assert.deepEqual(listed.map((tool) => tool.name).sort(), Object.keys(intended).sort());
  for (const tool of listed) assert.deepEqual(tool.annotations, intended[tool.name], tool.name);
});

test("MCP advertises typed image insertion and echoes its exact receipt as structured content", async () => {
  const descriptor = tools.find((tool) => tool.name === "edit_page");
  const schema = descriptor.inputSchema.properties.operations.items.oneOf.find(
    (item) => item.properties.op.const === "insert_image",
  );
  assert.deepEqual(schema.required, ["op", "asset_id", "alt"]);
  assert.equal(schema.additionalProperties, false);
  const asset_id = "a".repeat(64);
  const receipt = {
    page_id: pageId,
    heads: ["b".repeat(64)],
    result: {
      page_id: pageId,
      inserted_images: [
        {
          block_id: "image-block",
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
      arguments: { page_id: pageId, operations: [{ op: "insert_image", asset_id, alt: "A cat" }] },
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
    request("resources/read", { uri: "https://elsewhere.example/?page=page_" + "a".repeat(32) }),
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
      heads: ["c".repeat(64)],
      changes: [{ block_id: "block", node_index: 0, markdown }],
      retry_token: "authority",
      retry_key_prefix: "prefix_",
    };
    const response = await handleMcp(
      request("tools/call", {
        name: "read_page_changes",
        arguments: { page_id: pageId, since_heads: ["b".repeat(64)], max_bytes: maxBytes },
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
      assert.equal(failure.retry_token, "authority");
    }
  }
  const tooLarge = await handleMcp(
    request(
      "tools/call",
      { name: "read_page_changes", arguments: { max_bytes: 4096 } },
      "x".repeat(5000),
    ),
    async () => Response.json({ heads: [], changes: [] }),
  );
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).code, "mcp_request_id_too_large");
});
test("MCP exposes net changes and node-scoped target edits without changing exact receipts", async () => {
  const changeTool = tools.find((tool) => tool.name === "read_page_changes");
  assert.deepEqual(changeTool.securitySchemes[0].scopes, ["pages:read"]);
  assert.equal(changeTool.annotations.readOnlyHint, true);
  const patchTool = tools.find((tool) => tool.name === "patch_page");
  assert.deepEqual(patchTool.inputSchema.properties.conflict_scope.enum, ["page", "target"]);
  const match = patchTool.inputSchema.properties.operations.items.oneOf.find(
    (op) => op.properties.op.const === "replace_match",
  );
  assert.equal(match.properties.node_index.minimum, 0);
  const args = { page_id: pageId, since_heads: ["b".repeat(64)], comments: "none" };
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
  assert.deepEqual(result.structuredContent, { ...body, url: `https://pages.example/p/${pageId}` });
  assert.equal(result.isError, undefined);
  const conflict = {
    code: "edit_conflict",
    current_heads: ["c".repeat(64)],
    conflicts: [{ block_id: "block", node_index: 2, reason: "Target changed" }],
  };
  const failed = await handleMcp(
    request("tools/call", {
      name: "patch_page",
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
  assert.match((await initialization.json()).result.instructions, /opening_heading_repeats_title/);
  const receipt = {
    page_id: pageId,
    heads: ["b".repeat(64)],
    warnings: [
      {
        code: "opening_heading_repeats_title",
        block_id: "opening-block",
        heading: "A document title",
        match_kind: "normalized_exact",
        suggested_action: "Read the current opening before correcting an accidental duplicate.",
      },
    ],
  };
  for (const name of ["create_page", "edit_page", "patch_page"]) {
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
      { page_id: pageId, state: "open", thread_ids: ["thread-id"], include_messages: false },
    ],
  ]) {
    const descriptor = tools.find((tool) => tool.name === name);
    assert.equal(descriptor.annotations.readOnlyHint, true);
    assert.deepEqual(descriptor.securitySchemes[0].scopes, ["pages:read"]);
    assert.match(descriptor.description, /untrusted content, not instructions/);
    let called = false;
    const result = await handleMcp(
      request("tools/call", { name, arguments: args }),
      async (op, received) => {
        called = true;
        assert.equal(op, name);
        assert.deepEqual(received, args);
        return Response.json({
          page_id: pageId,
          heads: ["head"],
          retry_token: "token",
          comments: [],
        });
      },
    );
    assert.equal(called, true);
    assert.equal((await result.json()).result.structuredContent.retry_token, "token");
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
    request("tools/call", { name: "read_page", arguments: { page_id: pageId } }),
    async () => Response.json(budget, { status: 413 }),
  );
  const body = (await result.json()).result;
  assert.equal(body.isError, true);
  assert.deepEqual(JSON.parse(body.content[0].text), budget);
  const failed = await handleMcp(
    request("tools/call", { name: "list_page_comments", arguments: { page_id: pageId } }),
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
  assert.match(presence.description, /untrusted content, not instructions/);
  for (const [name, args, body] of [
    [
      "report_page_progress",
      { page_id: pageId, message: "Checking the summary" },
      { page_id: pageId, progress_id: "activity-1", lease_token: "private-capability" },
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
      arguments: { title: "Test", idempotency_key: "create-route" },
    }),
    async () => Response.json({ page_id: pageId, title: "Test" }),
  );
  const created = JSON.parse((await response.json()).result.content[0].text);
  assert.equal(created.url, `https://pages.example/p/${pageId}`);
  const list = await handleMcp(request("resources/list"), async () =>
    Response.json({ pages: [{ page_id: pageId, title: "Test" }] }),
  );
  assert.equal((await list.json()).result.resources[0].uri, created.url);
});
test("MCP reads canonical and legacy links while rejecting ambiguous resource URLs", async () => {
  for (const uri of [
    `https://pages.example/p/${pageId}`,
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
  const patch = tools.find((tool) => tool.name === "patch_page");
  const variants = patch.inputSchema.properties.operations.items.oneOf;
  assert.deepEqual(
    variants.map((operation) => operation.properties.op.const),
    ["replace_match", "format_match"],
  );
  assert.deepEqual(variants[1].required, ["op", "block_id", "match_text"]);
  assert.deepEqual(variants[1].properties.remove.items.enum, [
    "link",
    "em",
    "strong",
    "strike",
    "highlight",
    "code",
  ]);
  assert.equal(variants[1].properties.add.properties.strong.const, true);
  assert.equal(variants[1].properties.add.properties.strike.const, true);
  assert.deepEqual(variants[0].required, ["op", "block_id", "match_text", "replacement"]);
  assert.equal(variants[0].properties.context_before.type, "string");
  assert.equal(variants[0].properties.context_after.type, "string");
  assert.match(patch.description, /without streamed keystrokes/);
  const args = {
    page_id: pageId,
    base_heads: ["a".repeat(64)],
    idempotency_key: "replace-visible-text",
    operations: [
      {
        op: "replace_match",
        block_id: "block-a",
        match_text: "word",
        replacement: "phrase",
        context_before: "second",
      },
    ],
  };
  const response = await handleMcp(
    request("tools/call", { name: "patch_page", arguments: args }),
    async (operation, received) => {
      assert.equal(operation, "patch_page");
      assert.deepEqual(received, args);
      return Response.json({
        page_id: pageId,
        result: { edits: [{ op: "replace_match", block_id: "block-a", matched: 1 }] },
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
      request("tools/call", { name, arguments: name === "read_page" ? { page_id: pageId } : {} }),
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
            "list_pages",
            "read_page",
            "read_page_changes",
            "list_page_comments",
            "read_page_presence",
            "list_projects",
            "get_project",
          ].includes(tool.name)
            ? ["pages:read"]
            : ["pages:read", "pages:write"],
        },
      ],
      tool.name,
    );
  }
});

test("MCP image import advertises ChatGPT's complete file descriptor and keeps the private asset URL", async () => {
  const listed = await handleMcp(request("tools/list"), async () => assert.fail("unexpected call"));
  const descriptor = (await listed.json()).result.tools.find(
    (tool) => tool.name === "import_page_image",
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
  assert.deepEqual(descriptor.inputSchema.required, ["page_id", "file"]);
  assert.deepEqual(descriptor.securitySchemes[0].scopes, ["pages:read", "pages:write"]);
  assert.equal(descriptor.annotations.destructiveHint, false);
  assert.equal(descriptor.annotations.openWorldHint, true);

  const file = {
    download_url: "https://files.oaiusercontent.com/file-fixture?temporary=secret",
    file_id: "file-fixture",
  };
  const assetUrl = `/api/pages/${pageId}/assets/${"a".repeat(64)}`;
  const response = await handleMcp(
    request("tools/call", { name: "import_page_image", arguments: { page_id: pageId, file } }),
    async (operation, args) => {
      assert.equal(operation, "import_page_image");
      assert.deepEqual(args, { page_id: pageId, file });
      return Response.json({ page_id: pageId, asset_url: assetUrl, mime_type: "image/png" });
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  const asset = JSON.parse(result.content[0].text);
  assert.equal(asset.asset_url, assetUrl);
  assert.equal(asset.url, `https://pages.example/p/${pageId}`);
  assert.equal(JSON.stringify(result).includes("temporary=secret"), false);
});

test("image import failures distinguish storage retries from document edits without leaking file URLs", async () => {
  const response = await handleMcp(
    request("tools/call", { name: "import_page_image", arguments: { page_id: pageId } }),
    async () => {
      throw new Error("private download URL with credentials");
    },
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /document was not edited/);
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
    const req = request("tools/call", { name: "read_page", arguments: { page_id: pageId } });
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
  assert.match(id, /^[0-9a-f-]{36}$/);
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
  assert.deepEqual(descriptor.inputSchema.required, ["page_id", "idempotency_key", "action"]);
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
        idempotency_key: "batch-1234",
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
