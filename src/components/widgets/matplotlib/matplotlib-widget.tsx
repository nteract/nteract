import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { buildMediaSrc } from "../buffer-utils";
import type { WidgetComponentProps } from "../widget-registry";
import { parseModelRef } from "../widget-store";
import {
  useWidgetModel,
  useWidgetModelValue,
  useWidgetStoreRequired,
} from "../widget-store-context";

type CanvasSize = [number, number];

interface MplMessage {
  type?: string;
  [key: string]: unknown;
}

interface Rubberband {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_SIZE: CanvasSize = [0, 0];
const RESIZE_HANDLE_SIZE = 20;
const CHECKPOINT_KEY = "_nteract_mpl_canvas";

function asSize(value: unknown): CanvasSize {
  if (!Array.isArray(value) || value.length < 2) return DEFAULT_SIZE;
  const width = Number(value[0]);
  const height = Number(value[1]);
  return [
    Number.isFinite(width) && width > 0 ? width : 0,
    Number.isFinite(height) && height > 0 ? height : 0,
  ];
}

function parseCustomMessage(content: Record<string, unknown>): MplMessage | null {
  const raw = content.data;
  const annotatedMode =
    typeof content._nteract_image_mode === "string" ? content._nteract_image_mode : undefined;
  if (typeof raw === "string") {
    try {
      return { ...(JSON.parse(raw) as MplMessage), _nteract_image_mode: annotatedMode };
    } catch {
      return null;
    }
  }
  if (typeof content.type === "string") {
    return { ...content, _nteract_image_mode: annotatedMode } as MplMessage;
  }
  return null;
}

function dataViewToArrayBuffer(view: DataView): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function bufferToBlobUrl(buffer: DataView | ArrayBuffer): string {
  const bytes = buffer instanceof DataView ? new Uint8Array(dataViewToArrayBuffer(buffer)) : buffer;
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

function getCheckpointFrame(value: unknown): string | ArrayBuffer | Uint8Array | DataView | null {
  if (!value || typeof value !== "object") return null;
  const frame = (value as Record<string, unknown>).frame;
  if (
    typeof frame === "string" ||
    frame instanceof ArrayBuffer ||
    frame instanceof Uint8Array ||
    frame instanceof DataView
  ) {
    return frame;
  }
  return null;
}

function simpleKeys(event: React.MouseEvent | React.WheelEvent | React.KeyboardEvent) {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  };
}

function modifiers(event: React.MouseEvent | React.WheelEvent) {
  const result: string[] = [];
  if (event.altKey) result.push("alt");
  if (event.ctrlKey) result.push("control");
  if (event.metaKey) result.push("meta");
  if (event.shiftKey) result.push("shift");
  return result;
}

function toolbarButtonLabel(name: string, text: string) {
  switch (name) {
    case "home":
      return "Home";
    case "back":
      return "Back";
    case "forward":
      return "Forward";
    case "pan":
      return "Pan";
    case "zoom":
      return "Zoom";
    case "download":
    case "save_figure":
      return "Save";
    default:
      return text || name;
  }
}

export function MatplotlibCanvasWidget({ modelId, className }: WidgetComponentProps) {
  const { store, sendCustom } = useWidgetStoreRequired();
  const sizeValue = useWidgetModelValue<unknown>(modelId, "_size");
  const figureLabel = useWidgetModelValue<string>(modelId, "_figure_label") ?? "Figure";
  const message = useWidgetModelValue<string>(modelId, "_message") ?? "";
  const cursor = useWidgetModelValue<string>(modelId, "_cursor") ?? "pointer";
  const imageMode = useWidgetModelValue<string>(modelId, "_image_mode") ?? "full";
  const headerVisible = useWidgetModelValue<boolean>(modelId, "header_visible") ?? true;
  const footerVisible = useWidgetModelValue<boolean>(modelId, "footer_visible") ?? true;
  const toolbarVisible = useWidgetModelValue<string | boolean>(modelId, "toolbar_visible") ?? true;
  const toolbarPosition = useWidgetModelValue<string>(modelId, "toolbar_position") ?? "left";
  const resizable = useWidgetModelValue<boolean>(modelId, "resizable") ?? true;
  const captureScroll = useWidgetModelValue<boolean>(modelId, "capture_scroll") ?? false;
  const panZoomThrottle = useWidgetModelValue<number>(modelId, "pan_zoom_throttle") ?? 33;
  const toolbarRef = useWidgetModelValue<string>(modelId, "toolbar");
  const checkpoint = useWidgetModelValue<unknown>(modelId, CHECKPOINT_KEY);

  const toolbarId = typeof toolbarRef === "string" ? parseModelRef(toolbarRef) : null;
  const [renderSize, setRenderSize] = useState<CanvasSize>(() => asSize(sizeValue));
  const [rubberband, setRubberband] = useState<Rubberband | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const ratioRef = useRef(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasDivRef = useRef<HTMLDivElement>(null);
  const waitingForImageRef = useRef(false);
  const throttleRef = useRef(0);
  const imageUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const offscreen = document.createElement("canvas");
    offscreenCanvasRef.current = offscreen;
    offscreenContextRef.current = offscreen.getContext("2d");
    return () => {
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setRenderSize(asSize(sizeValue));
  }, [sizeValue]);

  const resizeCanvases = useCallback((nextSize: CanvasSize) => {
    const ratio = ratioRef.current;
    const [width, height] = nextSize;
    const cssWidth = Math.max(0, Math.round(width));
    const cssHeight = Math.max(0, Math.round(height));
    const pixelWidth = Math.max(0, Math.round(width * ratio));
    const pixelHeight = Math.max(0, Math.round(height * ratio));
    const offscreen = offscreenCanvasRef.current;
    const base = baseCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    const div = canvasDivRef.current;

    if (offscreen) {
      if (offscreen.width !== pixelWidth) {
        offscreen.width = pixelWidth;
      }
      if (offscreen.height !== pixelHeight) {
        offscreen.height = pixelHeight;
      }
      offscreenContextRef.current = offscreen.getContext("2d");
    }
    if (base) {
      if (base.width !== pixelWidth) {
        base.width = pixelWidth;
      }
      if (base.height !== pixelHeight) {
        base.height = pixelHeight;
      }
      base.style.width = `${cssWidth}px`;
      base.style.height = `${cssHeight}px`;
    }
    if (overlay) {
      if (overlay.width !== cssWidth) {
        overlay.width = cssWidth;
      }
      if (overlay.height !== cssHeight) {
        overlay.height = cssHeight;
      }
      overlay.style.width = `${cssWidth}px`;
      overlay.style.height = `${cssHeight}px`;
    }
    if (div) {
      div.style.width = `${cssWidth}px`;
      div.style.height = `${cssHeight}px`;
    }
  }, []);

  const drawOverlay = useCallback(() => {
    const overlay = overlayCanvasRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (rubberband && rubberband.width !== 0 && rubberband.height !== 0) {
      ctx.save();
      ctx.strokeStyle = "gray";
      ctx.lineWidth = 1;
      ctx.shadowColor = "black";
      ctx.shadowBlur = 2;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.strokeRect(rubberband.x, rubberband.y, rubberband.width, rubberband.height);
      ctx.restore();
    }

    if (resizable && overlay.width > 0 && overlay.height > 0) {
      ctx.save();
      const gradient = ctx.createLinearGradient(
        overlay.width - RESIZE_HANDLE_SIZE,
        overlay.height - RESIZE_HANDLE_SIZE,
        overlay.width,
        overlay.height,
      );
      gradient.addColorStop(0, "white");
      gradient.addColorStop(1, "black");
      ctx.fillStyle = gradient;
      ctx.strokeStyle = "gray";
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.moveTo(overlay.width, overlay.height);
      ctx.lineTo(overlay.width, overlay.height - RESIZE_HANDLE_SIZE);
      ctx.lineTo(overlay.width - RESIZE_HANDLE_SIZE, overlay.height);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, [resizable, rubberband]);

  const drawBase = useCallback((stretch = false) => {
    const base = baseCanvasRef.current;
    const offscreen = offscreenCanvasRef.current;
    if (!base || !offscreen || base.width === 0 || base.height === 0) return;
    const ctx = base.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, base.width, base.height);
    if (stretch) {
      ctx.drawImage(offscreen, 0, 0, base.width, base.height);
    } else {
      ctx.drawImage(offscreen, 0, 0);
    }
  }, []);

  const updateCanvas = useCallback(
    (stretch = false) => {
      drawBase(stretch);
      drawOverlay();
    },
    [drawBase, drawOverlay],
  );

  useEffect(() => {
    resizeCanvases(renderSize);
    updateCanvas();
  }, [renderSize, resizeCanvases, updateCanvas]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  const loadImageUrl = useCallback(
    (url: string, mode: string, stretch = false) => {
      const image = new Image();
      image.onload = () => {
        const offscreen = offscreenCanvasRef.current;
        if (!offscreen) return;
        if (offscreen.width === 0 || offscreen.height === 0) {
          const ratio = ratioRef.current;
          const nextSize: CanvasSize = [image.width / ratio, image.height / ratio];
          resizeCanvases(nextSize);
          setRenderSize(nextSize);
        }
        const ctx = offscreenContextRef.current ?? offscreen.getContext("2d");
        if (!ctx) return;
        offscreenContextRef.current = ctx;
        if (mode === "full") {
          ctx.clearRect(0, 0, offscreen.width, offscreen.height);
        }
        ctx.drawImage(image, 0, 0);
        waitingForImageRef.current = false;
        updateCanvas(stretch);
      };
      image.src = url;
    },
    [updateCanvas],
  );

  useEffect(() => {
    const frame = getCheckpointFrame(checkpoint);
    if (!frame) return;
    const src = buildMediaSrc(frame, "image", "png");
    if (src) {
      loadImageUrl(src, "full");
    }
  }, [checkpoint, loadImageUrl]);

  const sendMessage = useCallback(
    (type: string, payload: Record<string, unknown> = {}) => {
      sendCustom(modelId, { ...payload, type });
    },
    [modelId, sendCustom],
  );

  useEffect(() => {
    const ratio = ratioRef.current;
    if (ratio !== 1) {
      sendMessage("set_dpi_ratio", { dpi_ratio: ratio });
      sendMessage("set_device_pixel_ratio", { device_pixel_ratio: ratio });
    }
    sendMessage("refresh");
    sendMessage("send_image_mode");
    sendMessage("initialized");
  }, [sendMessage]);

  const sendDrawMessage = useCallback(() => {
    if (!waitingForImageRef.current) {
      waitingForImageRef.current = true;
      sendMessage("draw");
    }
  }, [sendMessage]);

  useEffect(() => {
    return store.subscribeToCustomMessage(modelId, (content, buffers) => {
      const msg = parseCustomMessage(content);
      if (!msg?.type) return;

      if (msg.type === "binary") {
        const first = buffers?.[0];
        if (!first) return;
        if (imageUrlRef.current) {
          URL.revokeObjectURL(imageUrlRef.current);
        }
        imageUrlRef.current = bufferToBlobUrl(first);
        const mode =
          typeof msg._nteract_image_mode === "string" ? msg._nteract_image_mode : imageMode;
        loadImageUrl(imageUrlRef.current, mode);
        return;
      }

      if (msg.type === "draw") {
        sendDrawMessage();
        return;
      }

      if (msg.type === "resize") {
        const size = asSize(msg.size);
        if (size[0] > 0 && size[1] > 0) {
          setRenderSize(size);
        }
        sendMessage("refresh");
        return;
      }

      if (msg.type === "rubberband") {
        const ratio = ratioRef.current;
        const offscreen = offscreenCanvasRef.current;
        const x0 = Number(msg.x0 ?? -1) / ratio;
        const y0 = offscreen ? (offscreen.height - Number(msg.y0 ?? -1)) / ratio : -1;
        const x1 = Number(msg.x1 ?? -1) / ratio;
        const y1 = offscreen ? (offscreen.height - Number(msg.y1 ?? -1)) / ratio : -1;
        if (x0 < 0 || y0 < 0 || x1 < 0 || y1 < 0) {
          setRubberband(null);
        } else {
          setRubberband({
            x: Math.min(Math.floor(x0) + 0.5, Math.floor(x1) + 0.5),
            y: Math.min(Math.floor(y0) + 0.5, Math.floor(y1) + 0.5),
            width: Math.abs(Math.floor(x1) - Math.floor(x0)),
            height: Math.abs(Math.floor(y1) - Math.floor(y0)),
          });
        }
        return;
      }

      if (msg.type === "save") {
        const first = buffers?.[0];
        const format = typeof msg.format === "string" ? msg.format : "png";
        const href = first ? bufferToBlobUrl(first) : baseCanvasRef.current?.toDataURL();
        if (!href) return;
        const link = document.createElement("a");
        link.href = href;
        link.download = `${figureLabel}.${format}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        if (first) URL.revokeObjectURL(href);
      }
    });
  }, [figureLabel, imageMode, loadImageUrl, modelId, sendDrawMessage, sendMessage, store]);

  const requestResize = useCallback(
    (width: number, height: number) => {
      if (width <= 5 || height <= 5) return;
      setRenderSize([width, height]);
      sendMessage("resize", { width, height });
    },
    [sendMessage],
  );

  const canvasPoint = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (canvas.width * (event.clientX - rect.left)) / rect.width,
      y: (canvas.height * (event.clientY - rect.top)) / rect.height,
    };
  }, []);

  const sendMouseEvent = useCallback(
    (name: string, event: React.MouseEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) => {
      const now = performance.now();
      if ((name === "motion_notify" || name === "scroll") && now - throttleRef.current < panZoomThrottle) {
        return;
      }
      throttleRef.current = now;

      const point = canvasPoint(event as React.MouseEvent<HTMLCanvasElement>);
      const ratio = ratioRef.current;
      const step =
        name === "scroll" ? ((event as React.WheelEvent<HTMLCanvasElement>).deltaY < 0 ? 1 : -1) : undefined;
      sendMessage(name, {
        x: point.x * ratio,
        y: point.y * ratio,
        button: "button" in event ? event.button : 0,
        buttons: "buttons" in event ? event.buttons : 0,
        step,
        modifiers: modifiers(event),
        guiEvent: simpleKeys(event),
      });
    },
    [canvasPoint, panZoomThrottle, sendMessage],
  );

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const canvas = overlayCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(6, event.clientX - rect.left);
      const height = Math.max(6, event.clientY - rect.top);
      requestResize(width, height);
    };
    const onUp = () => setIsResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing, requestResize]);

  const toolbarVisibleNow =
    toolbarVisible === true ||
    toolbarVisible === "visible" ||
    (toolbarVisible === "fade-in-fade-out" && isHovering);

  return (
    <div
      className={className}
      data-widget-id={modelId}
      data-widget-type="MPLCanvas"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      style={{ display: "inline-block", maxWidth: "100%" }}
    >
      <div
        style={{
          display: "inline-block",
          border: "1px solid hsl(var(--border))",
          background: "hsl(var(--background))",
          maxWidth: "100%",
        }}
      >
        {headerVisible && (
          <div style={{ textAlign: "center", fontSize: 12, padding: "2px 6px" }}>
            {figureLabel}
          </div>
        )}
        <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
          <div
            ref={canvasDivRef}
            tabIndex={0}
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              let key = "";
              if (event.ctrlKey && event.key !== "Control") key += "ctrl+";
              else if (event.altKey && event.key !== "Alt") key += "alt+";
              else if (event.shiftKey && event.key !== "Shift") key += "shift+";
              key += `k${event.key}`;
              sendMessage("key_press", { key, guiEvent: simpleKeys(event) });
            }}
            onKeyUp={(event) => {
              event.preventDefault();
              event.stopPropagation();
              sendMessage("key_release", { key: `k${event.key}`, guiEvent: simpleKeys(event) });
            }}
            style={{ position: "relative", outline: "none" }}
          >
            <canvas
              ref={baseCanvasRef}
              style={{ display: "block", left: 0, position: "absolute", top: 0, zIndex: 0 }}
            />
            <canvas
              ref={overlayCanvasRef}
              onContextMenu={(event) => event.preventDefault()}
              onDoubleClick={(event) => sendMouseEvent("dblclick", event)}
              onMouseDown={(event) => {
                const point = canvasPoint(event);
                const overlay = overlayCanvasRef.current;
                if (
                  overlay &&
                  resizable &&
                  point.x >= overlay.width - RESIZE_HANDLE_SIZE &&
                  point.y >= overlay.height - RESIZE_HANDLE_SIZE
                ) {
                  setIsResizing(true);
                  return;
                }
                canvasDivRef.current?.focus();
                sendMouseEvent("button_press", event);
              }}
              onMouseUp={(event) => sendMouseEvent("button_release", event)}
              onMouseMove={(event) => sendMouseEvent("motion_notify", event)}
              onMouseEnter={(event) => sendMouseEvent("figure_enter", event)}
              onMouseLeave={(event) => sendMouseEvent("figure_leave", event)}
              onWheel={(event) => {
                sendMouseEvent("scroll", event);
                if (captureScroll) event.preventDefault();
              }}
              style={{
                cursor,
                display: "block",
                left: 0,
                position: "absolute",
                top: 0,
                zIndex: 1,
              }}
            />
          </div>
          {toolbarId && toolbarVisibleNow && (
            <MatplotlibToolbar
              modelId={toolbarId}
              position={toolbarPosition}
              overlay
            />
          )}
        </div>
        {footerVisible && (
          <div style={{ fontSize: 12, minHeight: 18, padding: "2px 6px" }}>{message}</div>
        )}
      </div>
    </div>
  );
}

function MatplotlibToolbar({
  modelId,
  position = "left",
  overlay = false,
}: {
  modelId: string;
  position?: string;
  overlay?: boolean;
}) {
  const { sendCustom, sendUpdate } = useWidgetStoreRequired();
  const toolitems = useWidgetModelValue<unknown[]>(modelId, "toolitems") ?? [];
  const currentAction = useWidgetModelValue<string>(modelId, "_current_action") ?? "";
  const buttonStyle = useWidgetModelValue<string>(modelId, "button_style") ?? "";

  const isVertical = position === "left" || position === "right";
  const style = useMemo<CSSProperties>(() => {
    const base: CSSProperties = {
      display: "flex",
      flexDirection: isVertical ? "column" : "row",
      gap: 2,
      padding: 3,
      background: "color-mix(in srgb, hsl(var(--background)) 88%, transparent)",
      border: "1px solid hsl(var(--border))",
    };
    if (!overlay) return base;
    return {
      ...base,
      position: "absolute",
      zIndex: 2,
      ...(position === "right" ? { right: 3 } : { left: 3 }),
      ...(position === "bottom" ? { bottom: 3 } : { top: 3 }),
    };
  }, [isVertical, overlay, position]);

  return (
    <div data-widget-id={modelId} data-widget-type="Toolbar" style={style}>
      {toolitems.map((item, index) => {
        if (!Array.isArray(item)) return null;
        const [text, tooltip, image, method] = item;
        const name = typeof method === "string" ? method : "";
        if (!name) {
          return <span key={index} style={{ width: isVertical ? 1 : 8, height: isVertical ? 8 : 1 }} />;
        }
        const active = currentAction === name;
        const label = toolbarButtonLabel(name, String(text ?? image ?? name));
        return (
          <button
            key={`${name}-${index}`}
            type="button"
            title={String(tooltip ?? label)}
            aria-label={label}
            data-active={active ? "true" : "false"}
            onClick={() => {
              if (name === "pan" || name === "zoom") {
                void sendUpdate(modelId, { _current_action: active ? "" : name });
              }
              sendCustom(modelId, { type: "toolbar_button", name });
            }}
            style={{
              alignItems: "center",
              background: active
                ? "hsl(var(--accent))"
                : buttonStyle
                  ? "hsl(var(--secondary))"
                  : "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 4,
              color: "hsl(var(--foreground))",
              display: "inline-flex",
              fontSize: 11,
              height: 24,
              justifyContent: "center",
              minWidth: 34,
              padding: "0 6px",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function MatplotlibToolbarWidget({ modelId, className }: WidgetComponentProps) {
  const model = useWidgetModel(modelId);
  if (!model) return null;
  return (
    <div className={className}>
      <MatplotlibToolbar modelId={modelId} />
    </div>
  );
}
