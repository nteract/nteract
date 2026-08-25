import { NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY } from "@/components/notebook-rail";

interface NotebookRailStageNavigationOptions<Result> {
  railCollapsed: boolean;
  collapseRail: () => void;
  navigate: () => Result;
  deferredResult?: Result;
  matchMedia?: (query: string) => Pick<MediaQueryList, "matches">;
  scheduleAfterCollapse?: (callback: () => void) => void;
}

function browserMatchMedia(query: string): Pick<MediaQueryList, "matches"> {
  if (typeof window === "undefined") return { matches: false };
  return { matches: window.matchMedia?.(query).matches === true };
}

function browserScheduleAfterCollapse(callback: () => void): void {
  if (typeof window === "undefined") {
    callback();
    return;
  }
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }
  callback();
}

/**
 * Reveal the notebook stage before moving focus out of a takeover rail.
 *
 * React flushes the synchronous rail-store update after the click handler;
 * deferring navigation one frame gives the stage time to become visible before
 * its target receives focus or scrolls into view.
 */
export function navigateToNotebookStageFromRail<Result = void>({
  railCollapsed,
  collapseRail,
  navigate,
  deferredResult,
  matchMedia = browserMatchMedia,
  scheduleAfterCollapse = browserScheduleAfterCollapse,
}: NotebookRailStageNavigationOptions<Result>): Result | undefined {
  const narrowRailIsTakingOverStage =
    !railCollapsed && matchMedia(NOTEBOOK_RAIL_TAKEOVER_MEDIA_QUERY).matches;

  if (!narrowRailIsTakingOverStage) {
    return navigate();
  }

  collapseRail();
  scheduleAfterCollapse(() => {
    navigate();
  });
  return deferredResult;
}

/**
 * Outline links must claim their click immediately when navigation is deferred;
 * otherwise the browser follows the hash while the narrow rail still covers
 * the stage.
 */
export function navigateNotebookOutlineFromRail(
  options: NotebookRailStageNavigationOptions<boolean>,
): boolean {
  return (
    navigateToNotebookStageFromRail({
      ...options,
      deferredResult: true,
    }) ?? false
  );
}
