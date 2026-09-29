import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import "./style.css";
import {
  App,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NteractContent } from "./types";
import { Cell } from "./components/cell";
import { createOutputResourceReader, type OutputResourceReader } from "./lib/output-resources";
import { mcpAppCellHasOutput } from "@/components/isolated/mcp-app-structured-content";
import { errorDetails, hostLog, setHostLogSink } from "./lib/host-log";
import { NTERACT_MCP_APP_CAPABILITIES, NTERACT_MCP_APP_INFO } from "./app-config";
import { applyMcpAppHostDocumentContext } from "./lib/host-document-context";

/**
 * Collapse the widget to 0px when there's nothing to render.
 * Execution status alone is not an output.
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
  const appRef = useRef<App | null>(null);
  const [content, setContent] = useState<NteractContent | null>(null);
  const [connected, setConnected] = useState(false);
  const [resourceReader, setResourceReader] = useState<OutputResourceReader | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | null>(null);
  const [hostCapabilities, setHostCapabilities] = useState<McpUiHostCapabilities | null>(null);
  const openLink = useCallback((url: string) => {
    void appRef.current?.openLink({ url }).catch((error) => {
      hostLog("warning", "open-link-failed", { error: errorDetails(error) });
    });
  }, []);

  useEffect(() => {
    const app = new App(NTERACT_MCP_APP_INFO, NTERACT_MCP_APP_CAPABILITIES);
    appRef.current = app;

    app.ontoolresult = (result: CallToolResult) => {
      const structured = result.structuredContent as NteractContent | undefined;
      if (!structured) {
        setContent(null);
        hostLog("info", "tool-result-without-structured-content", {
          contentItems: result.content?.length ?? 0,
          isError: result.isError ?? false,
          layout: layoutDetails(),
        });
        return;
      }
      hostLog("info", "tool-result-received", contentDetails(structured));
      setContent(structured);
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
        if (capabilities?.serverResources !== undefined) {
          setResourceReader(() =>
            createOutputResourceReader((uri) => app.readServerResource({ uri })),
          );
        }
        setConnected(true);
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
      appRef.current = null;
      hostLog("debug", "app-dispose");
      setHostLogSink(null);
      setContent(null);
      void app.close();
    };
  }, []);

  const cells = (content?.cells || (content?.cell ? [content.cell] : [])).filter(
    mcpAppCellHasOutput,
  );

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

  if (!connected || cells.length === 0) return null;

  return (
    <>
      {cells.map((cell) => (
        <Cell
          key={cell.cell_id}
          cell={cell}
          blobBaseUrl={blobBaseUrl}
          hostContext={hostContext}
          hostCapabilities={hostCapabilities}
          resourceReader={resourceReader}
          onLinkClick={openLink}
        />
      ))}
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<McpApp />);
