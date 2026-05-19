const IFRAME_HEIGHT_FUDGE_PX = 2;

function measuredElementHeight(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  return Math.max(element.scrollHeight, element.offsetHeight, rect.bottom);
}

export function measureDocumentHeight(): number {
  const root = document.getElementById("root");
  if (root) {
    return Math.ceil(measuredElementHeight(root)) + IFRAME_HEIGHT_FUDGE_PX;
  }

  const doc = document.documentElement;
  const body = document.body;
  return (
    Math.ceil(
      Math.max(
        body?.scrollHeight ?? 0,
        body?.offsetHeight ?? 0,
        doc?.scrollHeight ?? 0,
        doc?.offsetHeight ?? 0,
      ),
    ) + IFRAME_HEIGHT_FUDGE_PX
  );
}
