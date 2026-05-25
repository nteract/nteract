import { useEffect, useRef } from "react";
import { hostLog } from "../lib/host-log";

interface HtmlOutputProps {
  html: string;
}

export const HTML_OUTPUT_HEIGHT_MESSAGE = "nteract/html-output-height";
const HTML_OUTPUT_MEASURE_REQUEST = "nteract/html-output-measure";
const HEIGHT_PADDING_PX = 2;
const HEIGHT_SENTINEL_ID = "__nteract-html-output-height-sentinel";

const heightReporterScript = `
<script>
(() => {
  const HEIGHT_MESSAGE = ${JSON.stringify(HTML_OUTPUT_HEIGHT_MESSAGE)};
  const MEASURE_REQUEST = ${JSON.stringify(HTML_OUTPUT_MEASURE_REQUEST)};
  const SENTINEL_ID = ${JSON.stringify(HEIGHT_SENTINEL_ID)};
  let animationFrame = 0;
  let lastHeight = 0;
  let measurementStarted = false;

  const getHeight = () => {
    const body = document.body;
    const bodyRect = body?.getBoundingClientRect();
    const sentinelRect = document.getElementById(SENTINEL_ID)?.getBoundingClientRect();
    return Math.ceil(Math.max(
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      bodyRect?.height || 0,
      sentinelRect?.bottom || 0
    ));
  };

  const reportHeight = () => {
    if (!measurementStarted) return;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      const height = getHeight();
      if (!height || height === lastHeight) return;
      lastHeight = height;
      window.parent.postMessage({ type: HEIGHT_MESSAGE, height }, "*");
    });
  };

  window.addEventListener("load", reportHeight);
  window.addEventListener("resize", reportHeight);
  window.addEventListener("message", (event) => {
    if (event.data?.type === MEASURE_REQUEST) {
      measurementStarted = true;
      reportHeight();
    }
  });
  document.addEventListener("DOMContentLoaded", reportHeight);

  if (window.ResizeObserver) {
    const resizeObserver = new ResizeObserver(reportHeight);
    if (document.documentElement) resizeObserver.observe(document.documentElement);
    if (document.body) resizeObserver.observe(document.body);
  }

  if (window.MutationObserver && document.documentElement) {
    const mutationObserver = new MutationObserver(reportHeight);
    mutationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  reportHeight();
  setTimeout(reportHeight, 0);
  setTimeout(reportHeight, 100);
  setTimeout(reportHeight, 500);
})();
</script>`;

export function HtmlOutput({ html }: HtmlOutputProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const lastHeightRef = useRef(0);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const setFrameHeight = (height: number) => {
      const nextHeight = Math.ceil(height) + HEIGHT_PADDING_PX;
      if (nextHeight <= 0 || nextHeight === lastHeightRef.current) return;
      lastHeightRef.current = nextHeight;
      frame.style.height = `${nextHeight}px`;
      hostLog("debug", "html-output-iframe-resized", { height: nextHeight });
    };

    const requestMeasure = () => {
      frame.contentWindow?.postMessage({ type: HTML_OUTPUT_MEASURE_REQUEST }, "*");
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      if ((data as { type?: unknown }).type !== HTML_OUTPUT_HEIGHT_MESSAGE) return;
      event.stopImmediatePropagation();
      const height = (data as { height?: unknown }).height;
      if (typeof height !== "number" || !Number.isFinite(height)) return;
      setFrameHeight(height);
    };

    window.addEventListener("message", handleMessage, true);
    frame.addEventListener("load", requestMeasure);
    requestMeasure();

    const animationFrame = requestAnimationFrame(requestMeasure);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("message", handleMessage, true);
      frame.removeEventListener("load", requestMeasure);
    };
  }, [html]);

  const styles =
    typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const bg = styles?.getPropertyValue("--code-bg").trim() || "#1e1e1e";
  const fg = styles?.getPropertyValue("--fg").trim() || "#e5e5e5";
  const border = styles?.getPropertyValue("--border").trim() || "#374151";
  const codeBg = styles?.getPropertyValue("--code-bg").trim() || "#262626";
  const fgMuted = styles?.getPropertyValue("--fg-muted").trim() || "#9ca3af";

  const srcdoc = `<!DOCTYPE html><html><head><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { overflow-y: hidden; }
    body { font-family: system-ui, -apple-system, sans-serif; color: ${fg}; background: ${bg}; overflow-x: auto; }
    table { border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    th, td { padding: 6px 10px; border: 1px solid ${border}; text-align: left; }
    th { background: ${codeBg}; color: ${fgMuted}; font-weight: 600; }
    tr:hover td { background: ${codeBg}; }
  </style>${heightReporterScript}</head><body>${html}<div id="${HEIGHT_SENTINEL_ID}"></div></body></html>`;

  return (
    <iframe
      ref={frameRef}
      className="html-output"
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      title="HTML output"
    />
  );
}
