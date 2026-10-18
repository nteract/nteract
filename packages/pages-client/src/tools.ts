const page = {
  type: "string",
  description: "Explicit Page ID; permissions are checked on every request.",
};
const guards = {
  page_id: page,
  base_sequence: {
    type: "integer",
    minimum: 0,
    description: "through_sequence from the latest read",
  },
  idempotency_key: {
    type: "string",
    minLength: 8,
    maxLength: 128,
    description: "Unique request key. Reuse exactly when retrying an uncertain result.",
  },
};
const operation = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: [
        "set_title",
        "insert_markdown",
        "replace_block_markdown",
        "delete_block",
        "move_block",
        "set_block_metadata",
        "enable_rich_text",
      ],
    },
    block_id: { type: "string" },
    expected_hash: { type: "string" },
    expected_title_hash: { type: "string" },
    title: { type: "string" },
    markdown: { type: "string" },
    metadata: { type: "object" },
    after_block_id: { type: ["string", "null"] },
    block_kind: { enum: ["markdown", "agent_instructions"] },
    block_units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { enum: ["markdown", "agent_instructions"] },
          markdown: { type: "string" },
          format: { const: "automerge-rich-text-v1" },
        },
      },
    },
    at: {
      type: "object",
      properties: {
        kind: { const: "between_blocks" },
        preceding_block_id: { type: ["string", "null"] },
        following_block_id: { type: ["string", "null"] },
      },
      required: ["kind", "preceding_block_id", "following_block_id"],
    },
  },
  required: ["op"],
};
export const pageTools = [
  {
    name: "read_page",
    description:
      "Read a live Page as Markdown blocks with stable IDs, hashes, and through_sequence. Read before editing; use the observed guards.",
    inputSchema: {
      type: "object" as const,
      properties: {
        page_id: page,
        view: { enum: ["editing", "full"] },
        block_ids: { type: "array", items: { type: "string" } },
        search: { type: "array", items: { type: "string" } },
      },
      required: ["page_id"],
    },
  },
  {
    name: "patch_page",
    description:
      "Make intentional literal find-and-replace edits. Each replacement must match unambiguously. Applies to the live Automerge document; humans see changes immediately. Inspect partial operation_results; never blindly retry rejected edits against a newer revision.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...guards,
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              op: { const: "patch_block_markdown" },
              block_id: { type: "string" },
              expected_hash: { type: "string" },
              replacements: {
                type: "array",
                items: {
                  type: "object",
                  properties: { old: { type: "string" }, new: { type: "string" } },
                  required: ["old", "new"],
                },
              },
            },
            required: ["op", "block_id", "expected_hash", "replacements"],
          },
        },
      },
      required: ["page_id", "base_sequence", "idempotency_key", "operations"],
    },
  },
  {
    name: "edit_page",
    description:
      "Apply an atomic structural edit batch. Use observed block/hash guards and adjacency anchors; prefer patch_page for targeted prose replacements.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...guards,
        operations: { type: "array", minItems: 1, maxItems: 100, items: operation },
      },
      required: ["page_id", "base_sequence", "idempotency_key", "operations"],
    },
  },
  {
    name: "read_page_changes",
    description:
      "Recover changes since an observed sequence. If resync_required, read_page again. For live updates use the Pages WebSocket API or a resource subscription when the transport advertises it; do not poll.",
    inputSchema: {
      type: "object" as const,
      properties: { page_id: page, since_sequence: { type: "integer", minimum: 0 } },
      required: ["page_id", "since_sequence"],
    },
  },
  {
    name: "list_page_comments",
    description: "Read the Page's comment threads, replies and selected-passage anchors.",
    inputSchema: {
      type: "object" as const,
      properties: {
        page_id: page,
        state: { enum: ["open", "resolved"] },
        block_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "manage_page_comment",
    description:
      "Add, reply, resolve, reopen, edit or tombstone a comment. Selected passages are anchored in the live document. Use the current sequence and an idempotency key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ...guards,
        action: { enum: ["add", "reply", "resolve", "reopen", "edit", "delete_message"] },
        thread_id: { type: "string" },
        message_id: { type: "string" },
        block_id: { type: "string" },
        selected_text: { type: "string" },
        body: { type: "string" },
        occurrence: { type: "integer", minimum: 1 },
      },
      required: ["page_id", "base_sequence", "idempotency_key", "action"],
    },
  },
  {
    name: "reply_page_comment",
    description: "Reply to an existing thread using observed Page sequence and a stable retry key.",
    inputSchema: {
      type: "object" as const,
      properties: { ...guards, thread_id: { type: "string" }, body: { type: "string" } },
      required: ["page_id", "base_sequence", "idempotency_key", "thread_id", "body"],
    },
  },
];

export function operationPermission(name: string): "read" | "edit" | "comment" | null {
  if (["manage_page_comment", "reply_page_comment"].includes(name)) return "comment";
  if (["create_page", "patch_page", "edit_page"].includes(name)) return "edit";
  if (
    [
      "list_spaces",
      "get_space",
      "list_pages",
      "read_page",
      "read_page_changes",
      "list_page_comments",
    ].includes(name)
  )
    return "read";
  return null;
}
export const accountTools = [
  {
    name: "list_pages",
    description:
      "List Pages accessible to the authenticated account. Use returned Page IDs explicitly in subsequent calls.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "create_page",
    description:
      "Create a rich editable Page. Reuse the exact idempotency key and payload if the result is uncertain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string" },
        markdown: { type: "string" },
        idempotency_key: guards.idempotency_key,
      },
      required: ["title", "idempotency_key"],
    },
  },
];
