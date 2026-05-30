import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import "./style.css";
import {
  App,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NteractContent } from "./types";
import { Cell } from "./components/cell";
import { SummaryHeader } from "./components/summary-header";
import { hasRichOutput } from "./lib/rich-output";
import { errorDetails, hostLog, setHostLogSink } from "./lib/host-log";
import { NTERACT_MCP_APP_CAPABILITIES, NTERACT_MCP_APP_INFO } from "./app-config";
import { applyMcpAppHostDocumentContext } from "./lib/host-document-context";

/**
 * Collapse the widget to 0px when there's nothing to render.
 * Only collapse when there is truly no structured content — not when
 * cells exist but have empty outputs (those still show cell headers).
 */
function useCollapseWhenEmpty(hasCells: boolean) {
  useEffect(() => {
    const body = document.body;
    if (hasCells) {
      body.style.removeProperty("height");
      body.style.removeProperty("overflow");
    } else {
      body.style.height = "0px";
      body.style.overflow = "hidden";
    }
  }, [hasCells]);
}

function contentDetails(content: NteractContent | null): Record<string, unknown> {
  const cells = content?.cells || (content?.cell ? [content.cell] : []);
  const outputMimes = cells.flatMap((cell) =>
    (cell.outputs ?? []).flatMap((output) => Object.keys(output.data ?? {})),
  );

  return {
    cellCount: cells.length,
    outputCount: cells.reduce((count, cell) => count + (cell.outputs?.length ?? 0), 0),
    outputMimes,
    hasBlobBaseUrl: typeof content?.blob_base_url === "string",
  };
}

function layoutDetails(): Record<string, unknown> {
  const html = document.documentElement;
  const body = document.body;

  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    documentRectHeight: Math.ceil(html.getBoundingClientRect().height),
    documentScrollHeight: html.scrollHeight,
    bodyRectHeight: Math.ceil(body.getBoundingClientRect().height),
    bodyScrollHeight: body.scrollHeight,
    htmlStyleHeight: html.style.height || null,
    bodyStyleHeight: body.style.height || null,
    bodyStyleOverflow: body.style.overflow || null,
  };
}

function McpApp() {
  const [content, setContent] = useState<NteractContent | null>(null);
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | null>(null);
  const [hostCapabilities, setHostCapabilities] = useState<McpUiHostCapabilities | null>(null);

  useEffect(() => {
    const app = new App(NTERACT_MCP_APP_INFO, NTERACT_MCP_APP_CAPABILITIES);

    app.ontoolresult = (result: CallToolResult) => {
      const structured = result.structuredContent as NteractContent | undefined;
      if (!structured) {
        hostLog("info", "tool-result-without-structured-content", {
          contentItems: result.content?.length ?? 0,
          isError: result.isError ?? false,
          layout: layoutDetails(),
        });
        return;
      }
      hostLog("info", "tool-result-received", contentDetails(structured));
      setContent(structured);
      setAllExpanded(null); // Reset expand-all state for new content
    };

    app.onhostcontextchanged = (ctx: McpUiHostContext) => {
      const nextContext = app.getHostContext() ?? ctx;
      setHostContext(nextContext);
      applyMcpAppHostDocumentContext(nextContext);
    };

    app.onerror = (error) => {
      hostLog("error", "app-protocol-error", {
        error: errorDetails(error),
      });
    };

    // Apply initial theme after connecting
    app
      .connect()
      .then(() => {
        setHostLogSink({
          sendLog: (params) => app.sendLog(params),
        });
        const ctx = app.getHostContext();
        const capabilities = app.getHostCapabilities();
        setHostCapabilities(capabilities ?? null);
        hostLog("info", "app-connected", {
          host: app.getHostVersion(),
          loggingAdvertised: capabilities?.logging !== undefined,
          sandboxCsp: capabilities?.sandbox?.csp,
          displayMode: ctx?.displayMode,
          containerDimensions: ctx?.containerDimensions,
        });
        applyMcpAppHostDocumentContext(ctx);
        setHostContext(ctx ?? null);
      })
      .catch((error) => {
        hostLog("error", "app-connect-failed", {
          error: errorDetails(error),
        });
      });

    return () => {
      hostLog("debug", "app-dispose");
      setHostLogSink(null);
      setContent(null);
    };
  }, []);

  const cells = content?.cells || (content?.cell ? [content.cell] : []);
  const isMultiCell = cells.length > 1;

  useCollapseWhenEmpty(cells.length > 0);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      hostLog("debug", "layout-measured", {
        ...contentDetails(content),
        layout: layoutDetails(),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [content]);

  const blobBaseUrl = content?.blob_base_url;

  if (cells.length === 0) return null;

  return (
    <>
      {isMultiCell && (
        <SummaryHeader
          cells={cells}
          allExpanded={allExpanded ?? false}
          onToggleAll={() => setAllExpanded((prev) => !(prev ?? false))}
        />
      )}
      {cells.map((cell) => (
        <Cell
          key={cell.cell_id}
          cell={cell}
          blobBaseUrl={blobBaseUrl}
          hostContext={hostContext}
          hostCapabilities={hostCapabilities}
          defaultExpanded={!isMultiCell || hasRichOutput(cell)}
          forceExpanded={isMultiCell ? allExpanded : null}
          hideSource={!isMultiCell}
        />
      ))}
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<McpApp />);
