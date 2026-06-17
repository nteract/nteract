export const CLOUD_VIEWER_ROUTE_CHANGE_EVENT = "nteract-cloud-viewer-route-change";

export function navigateCloudViewer(url: string): void {
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(CLOUD_VIEWER_ROUTE_CHANGE_EVENT));
}

export function shouldHandleCloudViewerLinkClick(
  event: Pick<
    MouseEvent,
    "button" | "defaultPrevented" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey"
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}
