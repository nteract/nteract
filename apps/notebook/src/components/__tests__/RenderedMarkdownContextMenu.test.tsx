import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildRenderedMarkdownContextGroups,
  type BuildRenderedMarkdownContextGroupsOptions,
} from "../RenderedMarkdownContextMenu";

function buildActions(overrides: Partial<BuildRenderedMarkdownContextGroupsOptions> = {}) {
  const groups = buildRenderedMarkdownContextGroups({
    hasSelection: false,
    canComment: false,
    onCopy: vi.fn(),
    onAddComment: vi.fn(),
    ...overrides,
  });

  return groups[0]?.actions ?? [];
}

describe("buildRenderedMarkdownContextGroups", () => {
  it("shows copy and comment for rendered selections that can comment", () => {
    const actions = buildActions({
      hasSelection: true,
      canComment: true,
    });

    expect(actions.map((action) => action.id)).toEqual(["copy", "add-comment"]);
    expect(actions.map((action) => action.shortcut)).toEqual(["⌘C", "C"]);
    expect(actions.find((action) => action.id === "add-comment")?.separatorBefore).toBe(true);
  });

  it("shows copy only for rendered selections without a comment handler", () => {
    const actions = buildActions({
      hasSelection: true,
      canComment: false,
    });

    expect(actions.map((action) => action.id)).toEqual(["copy"]);
  });

  it("returns no actions without a rendered selection", () => {
    expect(
      buildRenderedMarkdownContextGroups({
        hasSelection: false,
        canComment: true,
      }),
    ).toEqual([]);
  });
});
