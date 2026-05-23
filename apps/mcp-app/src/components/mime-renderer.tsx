import { useEffect, useState } from "react";
import { fetchBlobText, isBlobUrl } from "../lib/blob-fetch";
import { selectMimeType } from "../lib/mime-priority";
import { loadPluginForMime, needsDaemonPlugin } from "../lib/plugin-loader";
import { getPluginRenderer } from "../lib/plugin-executor";
import { AnsiText } from "./ansi-text";
import { HtmlOutput } from "./html-output";
import { ImageOutput } from "./image-output";
import { JsonOutput } from "./json-output";
import type { CellOutput } from "../types";
import { errorDetails, hostLog, stringDetails } from "../lib/host-log";

const ARROW_STREAM_MANIFEST_MIME = "application/vnd.nteract.arrow-stream-manifest+json";

interface MimeRendererProps {
  data: Record<string, string>;
  /** Base URL for daemon HTTP server (for fetching blob data and plugins) */
  blobBaseUrl?: string;
}

export function MimeRenderer({ data, blobBaseUrl }: MimeRendererProps) {
  const mime = selectMimeType(data);
  const raw = mime ? data[mime] : undefined;

  useEffect(() => {
    if (!mime) {
      hostLog("warning", "mime-renderer-no-supported-mime", {
        availableMimes: Object.keys(data),
        hasBlobBaseUrl: blobBaseUrl !== undefined,
      });
    } else if (raw == null) {
      hostLog("warning", "mime-renderer-missing-selected-data", {
        mime,
        availableMimes: Object.keys(data),
      });
    }
  }, [data, mime, raw, blobBaseUrl]);

  if (!mime || raw == null) return null;

  // Images: use blob URL directly as <img src>, no fetch needed
  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    return (
      <ImageOutput data={String(raw)} mediaType={mime} alt={data["text/plain"] || undefined} />
    );
  }

  // text/plain fallback for when blob fetch or plugin load fails
  const plainFallback = data["text/plain"] ? String(data["text/plain"]) : undefined;

  // Plugin-rendered MIME types (markdown, latex, plotly, vega, leaflet)
  if (needsDaemonPlugin(mime)) {
    return (
      <PluginRenderer
        mime={mime}
        raw={String(raw)}
        blobBaseUrl={blobBaseUrl}
        plainFallback={plainFallback}
      />
    );
  }

  return <FetchAndRender mime={mime} raw={String(raw)} plainFallback={plainFallback} />;
}

function outputValueDetails(value: string): Record<string, unknown> {
  return {
    isBlobUrl: isBlobUrl(value),
    ...stringDetails(value),
  };
}

/**
 * Load a daemon-served plugin via <script> tag and render data with it.
 * Loads plugin and fetches blob data in parallel.
 */
function PluginRenderer({
  mime,
  raw,
  blobBaseUrl,
  plainFallback,
}: {
  mime: string;
  raw: string;
  blobBaseUrl?: string;
  plainFallback?: string;
}) {
  const [data, setData] = useState<unknown>(null);
  const [pluginReady, setPluginReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    hostLog("debug", "plugin-render-start", {
      mime,
      hasBlobBaseUrl: blobBaseUrl !== undefined,
      raw: outputValueDetails(raw),
      hasPlainFallback: plainFallback !== undefined,
      plainFallbackIsBlobUrl: plainFallback ? isBlobUrl(plainFallback) : false,
    });

    // Load plugin via <script> tag and fetch/parse data in parallel
    const pluginPromise = loadPluginForMime(mime, blobBaseUrl) ?? Promise.resolve();

    // Binary plugins (Sift table payloads) expect a URL and fetch data themselves.
    // Manifest/plugin JSON needs fetched + parsed content before rendering.
    const isBinaryPlugin =
      mime === "application/vnd.apache.parquet" || mime === "application/vnd.apache.arrow.stream";
    const parseData = (text: string) => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    const dataPromise = isBinaryPlugin
      ? Promise.resolve(raw)
      : isBlobUrl(raw)
        ? fetchBlobText(raw).then(parseData)
        : Promise.resolve(parseData(raw));

    Promise.all([pluginPromise, dataPromise])
      .then(([, parsedData]) => {
        if (cancelled) return;
        const hasRenderer = getPluginRenderer(mime) !== undefined;
        hostLog(hasRenderer ? "info" : "error", "plugin-render-ready", {
          mime,
          hasRenderer,
          dataType: typeof parsedData,
          dataIsArray: Array.isArray(parsedData),
        });
        setPluginReady(true);
        setData(
          mime === ARROW_STREAM_MANIFEST_MIME
            ? attachArrowManifestChunkUrls(parsedData, blobBaseUrl)
            : parsedData,
        );
      })
      .catch((error) => {
        hostLog("error", "plugin-render-failed", {
          mime,
          blobBaseUrl,
          raw: outputValueDetails(raw),
          hasPlainFallback: plainFallback !== undefined,
          plainFallbackIsBlobUrl: plainFallback ? isBlobUrl(plainFallback) : false,
          error: errorDetails(error),
        });
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [mime, raw, blobBaseUrl, plainFallback]);

  if (failed) {
    if (plainFallback) return <AnsiText text={plainFallback} />;
    return null;
  }

  if (!pluginReady || data === null) return null;

  const RendererComponent = getPluginRenderer(mime);
  if (!RendererComponent) {
    if (plainFallback) return <AnsiText text={plainFallback} />;
    return null;
  }

  return <RendererComponent data={data} mimeType={mime} />;
}

function attachArrowManifestChunkUrls(value: unknown, blobBaseUrl: string | undefined): unknown {
  if (!blobBaseUrl || typeof value !== "object" || value === null) return value;
  const manifest = value as Record<string, unknown>;
  if (!Array.isArray(manifest.chunks)) return value;

  const baseUrl = blobBaseUrl.replace(/\/$/, "");
  let changed = false;
  const chunks = manifest.chunks.map((chunk) => {
    if (typeof chunk !== "object" || chunk === null) return chunk;
    const chunkRecord = chunk as Record<string, unknown>;
    if (typeof chunkRecord.url === "string") return chunk;
    if (typeof chunkRecord.hash !== "string") return chunk;
    changed = true;
    return {
      ...chunkRecord,
      url: `${baseUrl}/blob/${chunkRecord.hash}`,
    };
  });

  if (!changed) return value;
  return { ...manifest, chunks };
}

function FetchAndRender({
  mime,
  raw,
  plainFallback,
}: {
  mime: string;
  raw: string;
  plainFallback?: string;
}) {
  const [content, setContent] = useState<string | null>(isBlobUrl(raw) ? null : raw);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isBlobUrl(raw)) {
      fetchBlobText(raw)
        .then(setContent)
        .catch((error) => {
          hostLog("error", "mime-blob-fetch-failed", {
            mime,
            raw: outputValueDetails(raw),
            hasPlainFallback: plainFallback !== undefined,
            plainFallbackIsBlobUrl: plainFallback ? isBlobUrl(plainFallback) : false,
            error: errorDetails(error),
          });
          setFailed(true);
        });
    }
  }, [mime, raw, plainFallback]);

  if (failed) {
    if (plainFallback) return <AnsiText text={plainFallback} />;
    return null;
  }

  if (content === null) return null;

  switch (mime) {
    case "text/html":
      return <HtmlOutput html={content} />;
    case "image/svg+xml":
      return <HtmlOutput html={content} />;
    case "application/json":
      return <JsonOutput data={content} />;
    case "text/plain":
      return <AnsiText text={content} />;
    default:
      return <AnsiText text={content} />;
  }
}

export function StreamOutput({ output }: { output: CellOutput }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const raw = output.text || "";
    if (isBlobUrl(raw)) {
      fetchBlobText(raw)
        .then(setText)
        .catch((error) => {
          hostLog("error", "stream-blob-fetch-failed", {
            streamName: output.name,
            raw: outputValueDetails(raw),
            error: errorDetails(error),
          });
          setText(raw);
        });
    } else {
      setText(raw);
    }
  }, [output.text]);

  if (!text) return null;

  const className = output.name === "stderr" ? "stream stream-stderr" : "stream";
  return <AnsiText text={text} className={className} />;
}
