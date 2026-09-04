import { describe, expect, it, vi } from "vite-plus/test";
import { NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY } from "@/components/notebook-rail";
import {
  isNotebookStageTarget,
  navigateNotebookOutlineFromRail,
  navigateToNotebookStageFromRail,
} from "@/components/notebook/rail-stage-navigation";

describe("notebook rail stage navigation", () => {
  it.each(["notebook-document-stage-content", "notebook-document-stage-content-toolbar"])(
    "recognizes focus in %s before a rail takeover",
    (slot) => {
      const stage = document.createElement("div");
      stage.dataset.slot = slot;
      const control = document.createElement("button");
      stage.append(control);
      expect(isNotebookStageTarget(control)).toBe(true);
    },
  );

  it.each(["notebook-document-rail-panel-host", "notebook-document-toolbar", "rail-leading-slot"])(
    "does not move focus out of visible %s chrome during takeover",
    (slot) => {
      const chrome = document.createElement("div");
      chrome.dataset.slot = slot;
      const control = document.createElement("button");
      chrome.append(control);
      expect(isNotebookStageTarget(control)).toBe(false);
      expect(isNotebookStageTarget(null)).toBe(false);
    },
  );

  it("collapses a narrow takeover rail before scheduling focus and scroll", () => {
    const events: string[] = [];
    let scheduledNavigation: (() => void) | null = null;
    const matchMedia = vi.fn(() => ({ matches: true }));

    navigateToNotebookStageFromRail({
      railCollapsed: false,
      collapseRail: () => events.push("collapse"),
      navigate: () => events.push("navigate"),
      matchMedia,
      scheduleAfterCollapse: (callback) => {
        scheduledNavigation = callback;
      },
    });

    expect(matchMedia).toHaveBeenCalledWith(NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY);
    expect(events).toEqual(["collapse"]);

    scheduledNavigation?.();
    expect(events).toEqual(["collapse", "navigate"]);
  });

  it.each([
    { railCollapsed: true, narrowViewport: true },
    { railCollapsed: false, narrowViewport: false },
  ])(
    "navigates immediately when collapsed=$railCollapsed and narrow=$narrowViewport",
    ({ railCollapsed, narrowViewport }) => {
      const collapseRail = vi.fn();
      const navigate = vi.fn();
      const scheduleAfterCollapse = vi.fn();

      navigateToNotebookStageFromRail({
        railCollapsed,
        collapseRail,
        navigate,
        matchMedia: () => ({ matches: narrowViewport }),
        scheduleAfterCollapse,
      });

      expect(collapseRail).not.toHaveBeenCalled();
      expect(scheduleAfterCollapse).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledOnce();
    },
  );

  it("claims a deferred outline link and navigates only after collapse", () => {
    const events: string[] = [];
    let scheduledNavigation: (() => void) | null = null;

    const handled = navigateNotebookOutlineFromRail({
      railCollapsed: false,
      collapseRail: () => events.push("collapse"),
      navigate: () => {
        events.push("navigate");
        return true;
      },
      matchMedia: () => ({ matches: true }),
      scheduleAfterCollapse: (callback) => {
        scheduledNavigation = callback;
      },
    });

    expect(handled).toBe(true);
    expect(events).toEqual(["collapse"]);

    scheduledNavigation?.();
    expect(events).toEqual(["collapse", "navigate"]);
  });

  it("preserves the outline navigator result outside takeover mode", () => {
    const collapseRail = vi.fn();
    const navigate = vi.fn(() => false);

    const handled = navigateNotebookOutlineFromRail({
      railCollapsed: false,
      collapseRail,
      navigate,
      matchMedia: () => ({ matches: false }),
    });

    expect(handled).toBe(false);
    expect(collapseRail).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
  });
});
