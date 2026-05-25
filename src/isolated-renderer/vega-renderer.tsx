/**
 * Vega Renderer Plugin
 *
 * On-demand renderer plugin for Vega and Vega-Lite outputs. Bundles
 * vega-embed (+ vega, vega-lite as deps) directly — no window globals.
 * Loaded into the isolated iframe via the renderer plugin API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import vegaEmbed from "vega-embed";
import { cn } from "@/lib/utils";

// --- Vega MIME detection (inlined to avoid importing from core bundle) ---

function isVegaMimeType(mime: string): boolean {
  return /^application\/vnd\.vega(lite)?\.v\d/.test(mime);
}

// No hardcoded MIME list — we use registerPattern with the regex matcher
// to handle any Vega/Vega-Lite version (v1, v2, ..., v6, future versions).

// --- VegaOutput component (self-contained, no window globals) ---

interface VegaView {
  finalize: () => void;
  changeset: () => {
    remove: (tuples: unknown) => { insert: (tuples: unknown) => unknown };
  };
  change: (name: string, changeset: unknown) => VegaView;
  runAsync: () => Promise<unknown>;
}

function embedOptions(isDark: boolean) {
  return {
    actions: false,
    renderer: "canvas" as const,
    theme: isDark ? ("dark" as const) : undefined,
  };
}

interface RendererProps {
  data: unknown;
  metadata?: Record<string, unknown>;
  mimeType: string;
}

interface InlineDataUpdate {
  datasetName: string;
  values: unknown[];
  structuralKey: string;
}

interface EmbeddedVegaView {
  element: HTMLDivElement;
  view: VegaView;
  finalize: () => void;
  inlineUpdate: InlineDataUpdate | null;
}

interface VegaEmbedResult {
  view: VegaView;
  finalize?: () => void;
}

const INLINE_VALUES_SENTINEL = "__nteract_inline_values__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSpec(data: unknown): Record<string, unknown> | null {
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(data) ? data : null;
}

function withTransparentBackground(spec: Record<string, unknown>): Record<string, unknown> {
  // Spec-level background has the highest priority in Vega's merge chain,
  // so this reliably overrides theme and config defaults.
  return { ...spec, background: "transparent" };
}

function inlineDataUpdateForSpec(spec: Record<string, unknown>): InlineDataUpdate | null {
  const data = spec.data;

  if (isRecord(data) && Array.isArray(data.values)) {
    // Vega-Lite compiles a top-level inline `data.values` source to `source_0`.
    return {
      datasetName: "source_0",
      values: data.values,
      structuralKey: JSON.stringify(
        withTransparentBackground({
          ...spec,
          data: { ...data, values: INLINE_VALUES_SENTINEL },
        }),
      ),
    };
  }

  if (!Array.isArray(data)) return null;

  const inlineDataEntries = data.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.name === "string" && Array.isArray(entry.values),
  );
  if (inlineDataEntries.length !== 1) return null;

  // Reuse only the unambiguous Vega case: one named inline dataset whose values changed.
  const [inlineData] = inlineDataEntries;
  return {
    datasetName: inlineData.name as string,
    values: inlineData.values as unknown[],
    structuralKey: JSON.stringify(
      withTransparentBackground({
        ...spec,
        data: data.map((entry) =>
          entry === inlineData ? { ...inlineData, values: INLINE_VALUES_SENTINEL } : entry,
        ),
      }),
    ),
  };
}

function embeddedViewForResult(
  element: HTMLDivElement,
  result: VegaEmbedResult,
  inlineUpdate: InlineDataUpdate | null,
): EmbeddedVegaView {
  return {
    element,
    view: result.view,
    finalize:
      typeof result.finalize === "function" ? result.finalize : () => result.view.finalize(),
    inlineUpdate,
  };
}

function finalizeEmbedResult(result: VegaEmbedResult): void {
  if (typeof result.finalize === "function") {
    result.finalize();
  } else {
    result.view.finalize();
  }
}

function VegaRenderer({ data }: RendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const embeddedViewRef = useRef<EmbeddedVegaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = useMemo(() => parseSpec(data), [data]);
  const specForEmbed = useMemo(() => (spec ? withTransparentBackground(spec) : null), [spec]);
  const inlineUpdate = useMemo(() => (spec ? inlineDataUpdateForSpec(spec) : null), [spec]);

  const finalizeEmbeddedView = useCallback(() => {
    embeddedViewRef.current?.finalize();
    embeddedViewRef.current = null;
  }, []);

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      const previous = containerRef.current;
      if (!node && previous && embeddedViewRef.current?.element === previous) {
        finalizeEmbeddedView();
      }
      containerRef.current = node;
    },
    [finalizeEmbeddedView],
  );

  useEffect(() => () => finalizeEmbeddedView(), [finalizeEmbeddedView]);

  useEffect(() => {
    setError(null);
    if (!containerRef.current || !specForEmbed) {
      finalizeEmbeddedView();
      return;
    }

    const el = containerRef.current;
    const isDark = document.documentElement.classList.contains("dark");
    let active = true;

    const previous = embeddedViewRef.current;
    if (
      previous?.element === el &&
      previous.inlineUpdate &&
      inlineUpdate &&
      previous.inlineUpdate.structuralKey === inlineUpdate.structuralKey
    ) {
      const changeset = previous.view
        .changeset()
        .remove(() => true)
        .insert(inlineUpdate.values);
      previous.view
        .change(inlineUpdate.datasetName, changeset)
        .runAsync()
        .catch((err: Error) => {
          if (!active) return;
          console.error("[VegaRenderer] data update failed:", err);
          setError(err.message || String(err));
        });
      previous.inlineUpdate = inlineUpdate;
    } else {
      finalizeEmbeddedView();
      vegaEmbed(el, specForEmbed as never, embedOptions(isDark)).then(
        (result) => {
          if (!active) {
            finalizeEmbedResult(result as VegaEmbedResult);
            return;
          }
          embeddedViewRef.current = embeddedViewForResult(
            el,
            result as VegaEmbedResult,
            inlineUpdate,
          );
        },
        (err: Error) => {
          if (!active) return;
          console.error("[VegaRenderer] embed failed:", err);
          setError(err.message || String(err));
        },
      );
    }

    const themeObserver = new MutationObserver(() => {
      const nowDark = document.documentElement.classList.contains("dark");
      finalizeEmbeddedView();
      vegaEmbed(el, specForEmbed as never, embedOptions(nowDark)).then(
        (result) => {
          if (!active) {
            finalizeEmbedResult(result as VegaEmbedResult);
            return;
          }
          embeddedViewRef.current = embeddedViewForResult(
            el,
            result as VegaEmbedResult,
            inlineUpdate,
          );
        },
        (err: Error) => {
          if (!active) return;
          console.error("[VegaRenderer] embed failed on theme change:", err);
          setError(err.message || String(err));
        },
      );
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      active = false;
      themeObserver.disconnect();
    };
  }, [finalizeEmbeddedView, inlineUpdate, specForEmbed]);

  if (!specForEmbed) return null;

  return (
    <div
      ref={setContainerRef}
      data-slot="vega-output"
      className={cn("not-prose py-2 max-w-full overflow-visible")}
    >
      {error && <div className="text-sm text-destructive py-1">Vega rendering error: {error}</div>}
    </div>
  );
}

// --- Plugin install ---

export function install(ctx: {
  register: (mimeTypes: string[], component: React.ComponentType<RendererProps>) => void;
  registerPattern: (
    test: (mime: string) => boolean,
    component: React.ComponentType<RendererProps>,
  ) => void;
}) {
  // Use pattern matcher to handle any Vega/Vega-Lite version
  ctx.registerPattern(isVegaMimeType, VegaRenderer);
}

/**
 * Check if a MIME type is handled by this plugin.
 * Exported so iframe-libraries.ts can detect vega MIME types dynamically.
 */
export { isVegaMimeType };
