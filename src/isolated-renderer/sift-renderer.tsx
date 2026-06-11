/**
 * Sift Renderer Plugin
 *
 * On-demand renderer plugin for table outputs.
 * Loaded into the isolated iframe via the renderer plugin API.
 *
 * Data flow: kernel outputs table bytes → daemon stores in blob server →
 * frontend gets blob URL → iframe loads sift plugin → SiftTable fetches
 * parquet or Arrow IPC from blob URL → WASM decodes → table renders.
 */

import {
  setWasmUrl,
  SiftFocusStatus,
  SiftTable,
  type ArrowStreamManifest,
  type SiftLoadMilestone,
  type SiftSource,
  type TableEngineState,
} from "@nteract/sift";
import "@nteract/sift/style.css";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  RendererHostContext,
  RendererInstallContext,
  RendererProps,
} from "@/lib/renderer-registry";
import { resolveSiftWasmUrl } from "./sift-assets";

const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

// --- Types ---

interface RendererArrowStreamManifestChunk {
  url?: unknown;
  row_count?: unknown;
}

interface RendererArrowStreamManifest {
  chunks?: unknown;
}

// --- WASM configuration ---

let wasmConfigured = false;
let configuredWasmUrl: string | undefined;
let lastTableUrl: string | undefined;
let getHostContext: (() => RendererHostContext | undefined) | undefined;
let subscribeHostContext: RendererInstallContext["subscribeHostContext"] | undefined;
let unsubscribeHostContext: (() => void) | undefined;

/**
 * Configure Sift's WASM sidecar from the host's renderer asset base.
 * The daemon fallback remains the blob URL origin's /plugins/ route.
 */
function configureWasm(blobUrl: string): void {
  lastTableUrl = blobUrl;
  try {
    const hostNteract = getHostContext?.()?.nteract;
    const nextUrl = resolveSiftWasmUrl({
      tableUrl: blobUrl,
      rendererAssetsBaseUrl: hostNteract?.rendererAssetsBaseUrl,
      siftWasmAssetName: hostNteract?.siftWasmAssetName,
    });
    if (wasmConfigured && configuredWasmUrl === nextUrl) return;
    setWasmUrl(nextUrl);
    configuredWasmUrl = nextUrl;
    wasmConfigured = true;
  } catch (err) {
    console.warn("[sift-renderer] configureWasm failed, using defaults:", err);
  }
}

// --- Container sizing ---

// Size estimates for sift's internal layout. These don't have to match
// pretext's per-cell pixel-perfect math — the goal is a sensible default
// container height before any scrolling kicks in. Sift handles overflow
// internally regardless. Underestimating *does* clip the bottom rows
// because sift's virtual scroller doesn't compress rows to fit, so err
// generous: better a bit of empty space below the table than missing
// rows.
const SIFT_HEADER_PX = 104; // column header row (~24) + sparkline summary band (~80)
const SIFT_FOOTER_PX = 36; // "N rows" + corner controls strip
const SIFT_ROW_PX = 40; // default-theme row height (line-height + padding)

// Above this row count we stop fitting and let sift's virtual scroll page
// the rest. With the new constants 12 rows still fits inside the 720px
// cap (104 + 12*40 + 36 = 620), keeping a typical .head() / .describe()
// fully visible.
const SIFT_FIT_ROW_THRESHOLD = 12;

// Hard cap for the iframe container. The output well wrapper is already
// viewport-aware (`useOutputWellMaxHeight(0.75)` ≈ 75% vh in OutputArea),
// so on a small screen the wrapper shows a scrollbar above this. Keeping
// the cap as a constant pixel value avoids the chicken-and-egg of asking
// the iframe for a "viewport" that's actually the iframe's own height.
const SIFT_MAX_PX = 720;

// Floor so an empty / one-row dataframe still has somewhere to render
// the header band and footer.
const SIFT_MIN_PX = 220;

// Keep in sync with src/isolated-renderer/layout-measure.ts. The host adds
// this fudge to the measured iframe document height, so Sift needs to leave
// the same room when fitting inside a host-provided iframe cap.
const IFRAME_HEIGHT_FUDGE_PX = 2;

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function outputOffsetWithinRenderer(element: HTMLElement | null): number {
  if (typeof document === "undefined" || !element) return 0;
  const root = document.getElementById("root") ?? document.body;
  if (!root) return 0;
  const rootTop = root.getBoundingClientRect().top;
  const elementTop = element.getBoundingClientRect().top;
  return Math.max(0, Math.ceil(elementTop - rootTop));
}

function hostSiftMaxHeight(element: HTMLElement | null): number {
  const hostMaxHeight = finitePositiveNumber(getHostContext?.()?.containerDimensions?.maxHeight);
  if (hostMaxHeight === null) return SIFT_MAX_PX;
  const availableHeight =
    Math.floor(hostMaxHeight) - IFRAME_HEIGHT_FUDGE_PX - outputOffsetWithinRenderer(element);
  return Math.max(1, Math.min(SIFT_MAX_PX, availableHeight));
}

function useHostSiftMaxHeight(elementRef: RefObject<HTMLElement | null>): number {
  const [maxHeight, setMaxHeight] = useState(() => hostSiftMaxHeight(null));

  useLayoutEffect(() => {
    let raf = 0;
    const update = () => setMaxHeight(hostSiftMaxHeight(elementRef.current));
    const scheduleUpdate = () => {
      if (typeof window === "undefined") {
        update();
        return;
      }
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(update);
    };
    update();

    const unsubscribe = subscribeHostContext?.(() => scheduleUpdate());
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    if (elementRef.current) {
      observer?.observe(elementRef.current);
    }
    const root = typeof document === "undefined" ? null : document.getElementById("root");
    if (root) {
      observer?.observe(root);
    }
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      unsubscribe?.();
      observer?.disconnect();
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [elementRef]);

  return maxHeight;
}

function fitHeightForRowCount(rowCount: number, maxHeight: number): number {
  if (rowCount <= 0) return Math.min(maxHeight, SIFT_MIN_PX);
  if (rowCount > SIFT_FIT_ROW_THRESHOLD) return maxHeight;
  const fit = SIFT_HEADER_PX + rowCount * SIFT_ROW_PX + SIFT_FOOTER_PX;
  return Math.min(maxHeight, Math.max(SIFT_MIN_PX, fit));
}

// --- SiftRenderer component ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tableUrlFromManifest(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const manifest = data as RendererArrowStreamManifest;
  if (!Array.isArray(manifest.chunks)) return undefined;
  const [firstChunk] = manifest.chunks as RendererArrowStreamManifestChunk[];
  return typeof firstChunk?.url === "string" ? firstChunk.url : undefined;
}

function tableManifestForData(data: unknown): ArrowStreamManifest | undefined {
  if (!isRecord(data)) return undefined;
  const manifest = data as RendererArrowStreamManifest;
  if (!Array.isArray(manifest.chunks)) return undefined;
  const chunks = [];
  for (const chunk of manifest.chunks) {
    if (!isRecord(chunk) || typeof chunk.url !== "string") return undefined;
    chunks.push({
      url: chunk.url,
      row_count: typeof chunk.row_count === "number" ? chunk.row_count : undefined,
    });
  }
  if (chunks.length === 0) return undefined;
  return {
    chunks,
    complete: typeof data.complete === "boolean" ? data.complete : undefined,
  };
}

function tableSourceForData(data: unknown, mimeType: string): SiftSource | undefined {
  if (mimeType === ARROW_STREAM_MANIFEST_MIME) {
    const manifest = tableManifestForData(data);
    return manifest ? { kind: "arrow-stream-manifest", manifest } : undefined;
  }
  const url = typeof data === "string" ? data : String(data);
  return { kind: "url", url };
}

function tableUrlForData(data: unknown, mimeType: string): string | undefined {
  if (mimeType === ARROW_STREAM_MANIFEST_MIME) {
    return tableUrlFromManifest(data);
  }
  return typeof data === "string" ? data : String(data);
}

function SiftRenderer({ data, mimeType, interactionActive = false }: RendererProps) {
  const url = tableUrlForData(data, mimeType);
  const source = useMemo(() => tableSourceForData(data, mimeType), [data, mimeType]);
  const tableHostRef = useRef<HTMLDivElement>(null);
  const maxTableHeight = useHostSiftMaxHeight(tableHostRef);

  // Default to the cap so the table is visible while sift's WASM loads
  // and reports its first state. Once we see a totalCount we settle on
  // the data-driven height. Filter changes (filteredCount moving while
  // totalCount stays put) are intentionally ignored so the cell layout
  // doesn't jump around as the user explores.
  const [tableHeight, setTableHeight] = useState<number>(maxTableHeight);
  const lastTotalRef = useRef<number | null>(null);
  const maxTableHeightRef = useRef(maxTableHeight);
  maxTableHeightRef.current = maxTableHeight;

  const handleLoadMilestone = useCallback(
    (milestone: SiftLoadMilestone) => {
      console.debug("[isolated-renderer] sift-load-milestone", {
        ...milestone,
        mimeType,
      });
    },
    [mimeType],
  );

  useEffect(() => {
    // New url (cell re-executed) — re-evaluate sizing on the next state.
    lastTotalRef.current = null;
    setTableHeight(maxTableHeightRef.current);
  }, [url]);

  useEffect(() => {
    const totalCount = lastTotalRef.current;
    setTableHeight(
      totalCount === null ? maxTableHeight : fitHeightForRowCount(totalCount, maxTableHeight),
    );
  }, [maxTableHeight]);

  const handleChange = useCallback(
    (state: TableEngineState) => {
      // Only react to totalCount changes. The engine fires onChange on init,
      // setStreamingDone (multi-row-group parquet finishing), sort, and
      // filter — totalCount only moves on the first two, so this filter is
      // what keeps filter / sort interactions from bouncing the layout.
      if (state.totalCount === lastTotalRef.current) return;
      lastTotalRef.current = state.totalCount;
      setTableHeight(fitHeightForRowCount(state.totalCount, maxTableHeight));
    },
    [maxTableHeight],
  );

  if (!url || !source) {
    console.warn("[sift-renderer] missing table URL", { mimeType, data });
    return <pre style={{ whiteSpace: "pre-wrap" }}>Unable to load Arrow stream manifest</pre>;
  }
  configureWasm(url);

  return (
    <div ref={tableHostRef} data-slot="sift-output" style={{ height: tableHeight, width: "100%" }}>
      <SiftTable
        source={source}
        onChange={handleChange}
        onLoadMilestone={handleLoadMilestone}
        footerControl={
          <div className="sift-footer-control">{interactionActive && <SiftFocusStatus />}</div>
        }
      />
    </div>
  );
}

// --- Plugin install ---

export function install(ctx: RendererInstallContext) {
  getHostContext = ctx.getHostContext;
  subscribeHostContext = ctx.subscribeHostContext;
  unsubscribeHostContext?.();
  unsubscribeHostContext = ctx.subscribeHostContext((context) => {
    if (!lastTableUrl || !context.nteract?.rendererAssetsBaseUrl) return;
    configureWasm(lastTableUrl);
  });
  ctx.register(
    [
      "application/vnd.apache.parquet",
      "application/vnd.apache.arrow.stream",
      ARROW_STREAM_MANIFEST_MIME,
    ],
    SiftRenderer,
  );
}
