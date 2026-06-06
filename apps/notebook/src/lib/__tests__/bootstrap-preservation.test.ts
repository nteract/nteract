import { describe, expect, it } from "vite-plus/test";
import {
  notebookReadyIdentity,
  shouldPreserveBootstrapProjection,
} from "../bootstrap-preservation";

describe("bootstrap projection preservation", () => {
  it("uses notebook_id as the preferred ready identity", () => {
    expect(
      notebookReadyIdentity({
        notebook_id: "room-1",
        notebook_path: "/tmp/notebook.ipynb",
      }),
    ).toBe("id:room-1");
  });

  it("falls back to notebook_path when no notebook id is present", () => {
    expect(
      notebookReadyIdentity({
        notebook_path: "/tmp/notebook.ipynb",
      }),
    ).toBe("path:/tmp/notebook.ipynb");
  });

  it("does not invent an identity for empty ready payloads", () => {
    expect(notebookReadyIdentity({})).toBeNull();
  });

  it("preserves projected notebook state for a same-notebook reconnect with visible cells", () => {
    expect(
      shouldPreserveBootstrapProjection({
        previousIdentity: "id:room-1",
        nextIdentity: "id:room-1",
        visibleCellCount: 3,
      }),
    ).toBe(true);
  });

  it("clears projected notebook state for first load, identity changes, or empty projections", () => {
    expect(
      shouldPreserveBootstrapProjection({
        previousIdentity: null,
        nextIdentity: "id:room-1",
        visibleCellCount: 3,
      }),
    ).toBe(false);
    expect(
      shouldPreserveBootstrapProjection({
        previousIdentity: "id:room-1",
        nextIdentity: "id:room-2",
        visibleCellCount: 3,
      }),
    ).toBe(false);
    expect(
      shouldPreserveBootstrapProjection({
        previousIdentity: "id:room-1",
        nextIdentity: "id:room-1",
        visibleCellCount: 0,
      }),
    ).toBe(false);
  });
});
