export interface PageBlock {
  id: string;
  kind: string;
  markdown: string;
  hash: string;
  metadata: Record<string, unknown>;
}
export interface PageSnapshot {
  page_id: string;
  title: string;
  title_hash: string;
  through_sequence: number;
  blocks: PageBlock[];
}
export interface PageRead {
  content: PageSnapshot;
  [key: string]: unknown;
}
export type Permission = "read" | "edit" | "comment";
export interface Connection {
  id: string;
  driver: string;
  display_name: string;
  page_id: string;
  permissions: Permission[];
  expires_at: number;
}
export interface EditRequest {
  page_id: string;
  base_sequence: number;
  idempotency_key: string;
  operations: Record<string, unknown>[];
}
export interface MutationReceipt {
  commit_status: "committed" | "not_committed";
  through_sequence: number;
  operation_id?: string;
  attribution?: { driver: string; display_name: string; driver_id: string };
  operation_results?: unknown[];
  [key: string]: unknown;
}
export interface PageChanges {
  through_sequence: number;
  resync_required: boolean;
  changes?: unknown[];
  blocks?: PageBlock[];
  comments_changed?: boolean;
  [key: string]: unknown;
}
export class PagesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly commitStatus: "committed" | "not_committed" | "unknown" = "unknown",
  ) {
    super(message);
  }
}
export function pagesOrigin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw Error("Use an HTTPS service origin (HTTP is allowed only on loopback)");
  return url.origin;
}
export class PagesClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly options: { token?: string; fetch?: typeof fetch } = {},
  ) {
    this.origin = pagesOrigin(origin);
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/api/") || path.startsWith("//") || path.includes("\\"))
      throw Error("Invalid API path");
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.origin + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PagesError(
        "Request failed; read back or retry the same idempotency key",
        "transport_error",
        0,
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new PagesError("Invalid service response", "invalid_response", response.status);
    }
    if (!response.ok) {
      const error = (
        result as { error?: { message?: string; code?: string; commit_status?: string } }
      )?.error;
      const certainty = error?.commit_status;
      throw new PagesError(
        error?.message ?? "Pages request failed",
        error?.code ?? "request_failed",
        response.status,
        certainty === "committed" || certainty === "not_committed" ? certainty : "unknown",
      );
    }
    return result as T;
  }
  connection() {
    return this.request<{ connection: Connection }>("/api/agent");
  }
  call<T = unknown>(operation: string, args: Record<string, unknown>) {
    return this.request<T>("/api/tools", { operation, arguments: args });
  }
  readPage(
    pageId: string,
    options: { view?: "editing" | "full"; block_ids?: string[]; search?: string[] } = {},
  ) {
    return this.call<PageRead>("read_page", { page_id: pageId, ...options });
  }
  patchPage(request: EditRequest) {
    return this.call<MutationReceipt>("patch_page", { ...request });
  }
  editPage(request: EditRequest) {
    return this.call<MutationReceipt>("edit_page", { ...request });
  }
  readChanges(pageId: string, sinceSequence: number) {
    return this.call<PageChanges>("read_page_changes", {
      page_id: pageId,
      since_sequence: sinceSequence,
    });
  }
  listComments(pageId: string) {
    return this.call("list_page_comments", { page_id: pageId });
  }
  comment(request: {
    page_id: string;
    base_sequence: number;
    idempotency_key: string;
    action: string;
    [key: string]: unknown;
  }) {
    return this.call<MutationReceipt>("manage_page_comment", request);
  }
}
