const IFRAME_HEIGHT_FUDGE_PX = 2;

function measuredElementHeight(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  let maxBottom = Math.max(element.scrollHeight, element.offsetHeight, rect.bottom);

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const child = walker.currentNode as HTMLElement;
    const childRect = child.getBoundingClientRect();
    const style = window.getComputedStyle(child);
    const marginBottom = Number.parseFloat(style.marginBottom) || 0;
    maxBottom = Math.max(maxBottom, childRect.bottom + marginBottom);
  }

  return maxBottom;
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
