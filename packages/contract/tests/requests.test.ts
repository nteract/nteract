// @vitest-environment node
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type {
  BlobDurability,
  ExecutionIdRejectionReason,
  NotebookRequest,
  NotebookResponse,
} from "@runtimed/contract/requests";
import type { QueueEntry } from "@runtimed/contract/runtime-state";

describe("@runtimed/contract/requests", () => {
  it("loads as a module with no runtime exports", async () => {
    const module = await import("@runtimed/contract/requests");
    expect(Object.keys(module)).toEqual([]);
  });

  it("names the request and response unions by their tags", () => {
    const request = {
      type: "execute_cell",
      cell_id: "cell-1",
    } satisfies NotebookRequest;
    expectTypeOf(request.type).toEqualTypeOf<"execute_cell">();
    expectTypeOf<
      Extract<NotebookResponse, { result: "environment_selection_rejected" }>
    >().toEqualTypeOf<{
      result: "environment_selection_rejected";
      error: string;
    }>();
    expectTypeOf<BlobDurability>().toEqualTypeOf<"durable" | "ephemeral">();
    expectTypeOf<ExecutionIdRejectionReason>().toEqualTypeOf<
      "malformed" | "already_exists" | "duplicate_in_request"
    >();
  });

  it("shares the queue entry shape with the runtime state contract", () => {
    expectTypeOf<
      Extract<NotebookResponse, { result: "all_cells_queued" }>["queued"]
    >().toEqualTypeOf<QueueEntry[]>();
  });
});
