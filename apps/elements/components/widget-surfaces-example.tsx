"use client";

import {
  Boxes,
  Cable,
  CircleDotDashed,
  DatabaseZap,
  FileJson,
  PackageOpen,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MediaProvider } from "@/components/outputs/media-provider";
import type { CustomRenderer } from "@/components/outputs/media-router";
import { Button } from "@/components/ui/button";
import "@/components/widgets/controls";
import "@/components/widgets/ipycanvas";
import { COMMANDS } from "@/components/widgets/ipycanvas/ipycanvas-commands";
import {
  WidgetStoreContext,
  createCanvasManagerRouter,
  useWidgetModels,
  useWidgetStoreRequired,
} from "@/components/widgets/widget-store-context";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";
import { WidgetView } from "@/components/widgets/widget-view";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";

type FixtureModel = {
  id: string;
  state: Record<string, unknown>;
  bufferPaths?: string[][];
};

const binaryImageSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 96">
  <rect width="220" height="96" rx="12" fill="#f0fdf4"/>
  <rect x="18" y="18" width="58" height="60" rx="8" fill="#10b981"/>
  <circle cx="126" cy="48" r="28" fill="#0ea5e9"/>
  <path d="M158 70 L194 28" stroke="#111827" stroke-width="8" stroke-linecap="round"/>
  <text x="18" y="88" font-family="ui-sans-serif, system-ui" font-size="12" font-weight="700" fill="#111827">DataView ImageModel</text>
</svg>`;

function textDataView(value: string): DataView {
  const bytes = new TextEncoder().encode(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new DataView(copy.buffer);
}

function fixtureAssetUrl(pathname: string): string {
  return new URL(pathname, window.location.origin).href;
}

function isHydratableFixtureUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith("/fixtures/");
  } catch {
    return false;
  }
}

async function resolveFixtureBufferUrlsInPlace(
  state: Record<string, unknown>,
  bufferPaths: string[][] | undefined,
): Promise<string[]> {
  if (!bufferPaths || bufferPaths.length === 0) return [];

  const hydratedPaths: string[] = [];
  await Promise.all(
    bufferPaths.map(async (path) => {
      if (path.length === 0) return;

      let current: unknown = state;
      for (const segment of path) {
        if (typeof current !== "object" || current === null) return;
        current = (current as Record<string, unknown>)[segment];
      }

      if (typeof current !== "string" || !isHydratableFixtureUrl(current)) return;

      const response = await fetch(current);
      if (!response.ok) return;

      let parent: Record<string, unknown> = state;
      for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i];
        const next = parent[segment];
        if (typeof next !== "object" || next === null) return;
        parent = next as Record<string, unknown>;
      }

      parent[path[path.length - 1]] = new DataView(await response.arrayBuffer());
      hydratedPaths.push(path.join("."));
    }),
  );

  return hydratedPaths;
}

const anyWidgetEsm = `
export default {
  render({ model, el }) {
    el.classList.add("elements-anywidget-fixture");

    const header = document.createElement("div");
    header.className = "elements-anywidget-header";

    const title = document.createElement("div");
    title.className = "elements-anywidget-title";
    title.textContent = String(model.get("title") || "AnyWidget");

    const status = document.createElement("div");
    status.className = "elements-anywidget-status";
    status.textContent = String(model.get("status") || "ready");

    header.append(title, status);

    const body = document.createElement("div");
    body.className = "elements-anywidget-body";

    const value = document.createElement("button");
    value.type = "button";
    value.className = "elements-anywidget-value";

    const meter = document.createElement("div");
    meter.className = "elements-anywidget-meter";
    const meterFill = document.createElement("div");
    meterFill.className = "elements-anywidget-meter-fill";
    meter.append(meterFill);

    const custom = document.createElement("div");
    custom.className = "elements-anywidget-custom";
    custom.textContent = "waiting for custom message";

    body.append(value, meter, custom);
    el.append(header, body);

    const update = () => {
      const count = Number(model.get("value") || 0);
      value.textContent = "value " + count;
      meterFill.style.width = Math.min(100, count * 12) + "%";
    };

    const onCustom = (content, buffers) => {
      const kind = content && typeof content.kind === "string" ? content.kind : "message";
      custom.textContent = kind + " with " + (buffers ? buffers.length : 0) + " buffer(s)";
    };

    value.addEventListener("click", () => {
      const next = Number(model.get("value") || 0) + 1;
      model.set("value", next);
      model.save_changes();
      model.send({ kind: "anywidget-click", value: next });
      update();
    });

    model.on("change:value", update);
    model.on("msg:custom", onCustom);
    update();

    return () => {
      model.off("change:value", update);
      model.off("msg:custom", onCustom);
      el.replaceChildren();
    };
  }
};
`;

const anyWidgetCss = `
.elements-anywidget-fixture {
  display: grid;
  gap: 12px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 8px;
  padding: 14px;
  background: color-mix(in srgb, canvas 94%, #0ea5e9 6%);
  color: canvastext;
}

.elements-anywidget-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.elements-anywidget-title {
  font: 700 14px/1.3 ui-sans-serif, system-ui, sans-serif;
}

.elements-anywidget-status,
.elements-anywidget-custom {
  color: color-mix(in srgb, currentColor 62%, transparent);
  font: 500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
}

.elements-anywidget-body {
  display: grid;
  gap: 10px;
}

.elements-anywidget-value {
  justify-self: start;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 6px;
  padding: 7px 10px;
  background: color-mix(in srgb, canvas 86%, currentColor 14%);
  color: canvastext;
  font: 700 13px/1 ui-sans-serif, system-ui, sans-serif;
}

.elements-anywidget-meter {
  overflow: hidden;
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.elements-anywidget-meter-fill {
  height: 100%;
  border-radius: inherit;
  background: #10b981;
  transition: width 160ms ease;
}
`;

const fixtureModels: FixtureModel[] = [
  {
    id: "widget-media-title",
    state: {
      _model_name: "HTMLModel",
      _model_module: "@jupyter-widgets/controls",
      value: "<strong>Media widget fixture</strong>",
    },
  },
  {
    id: "widget-image",
    state: {
      _model_name: "ImageModel",
      _model_module: "@jupyter-widgets/controls",
      description: "image",
      value:
        "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20240%20120%22%3E%3Crect%20width%3D%22240%22%20height%3D%22120%22%20rx%3D%2214%22%20fill%3D%22%23eff6ff%22%2F%3E%3Cpath%20d%3D%22M24%2088%20C58%2058%2082%2070%20112%2044%20C144%2016%20168%2058%20216%2032%22%20fill%3D%22none%22%20stroke%3D%22%230ea5e9%22%20stroke-width%3D%229%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%22112%22%20cy%3D%2244%22%20r%3D%228%22%20fill%3D%22%2310b981%22%2F%3E%3Ctext%20x%3D%2224%22%20y%3D%2228%22%20font-family%3D%22ui-sans-serif%2C%20system-ui%22%20font-size%3D%2214%22%20font-weight%3D%22700%22%20fill%3D%22%231e293b%22%3EImageWidget%3C%2Ftext%3E%3C%2Fsvg%3E",
      format: "svg+xml",
      width: "240",
      height: "120",
    },
  },
  {
    id: "widget-binary-image",
    state: {
      _model_name: "ImageModel",
      _model_module: "@jupyter-widgets/controls",
      description: "binary image",
      value: textDataView(binaryImageSvg),
      format: "svg+xml",
      width: "220",
      height: "96",
    },
    bufferPaths: [["value"]],
  },
  {
    id: "widget-buffer-url-image",
    state: {
      _model_name: "ImageModel",
      _model_module: "@jupyter-widgets/controls",
      description: "buffer URL",
      value: "",
      format: "svg+xml",
      width: "260",
      height: "112",
    },
    bufferPaths: [["value"]],
  },
  {
    id: "widget-audio",
    state: {
      _model_name: "AudioModel",
      _model_module: "@jupyter-widgets/controls",
      description: "audio",
      value: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=",
      format: "wav",
      controls: true,
      autoplay: false,
      loop: false,
    },
  },
  {
    id: "widget-video",
    state: {
      _model_name: "VideoModel",
      _model_module: "@jupyter-widgets/controls",
      description: "video",
      value: "data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=",
      format: "mp4",
      controls: true,
      autoplay: false,
      loop: false,
      width: "240",
      height: "120",
    },
  },
  {
    id: "widget-file-upload",
    state: {
      _model_name: "FileUploadModel",
      _model_module: "@jupyter-widgets/controls",
      description: "Attach data",
      button_style: "info",
      icon: "upload",
      accept: ".csv,.parquet",
      multiple: true,
      disabled: false,
      value: [
        {
          name: "forecast.csv",
          type: "text/csv",
          size: 1842,
          content: "cmVnaW9uLG1hZQp3ZXN0LDguNDIK",
          last_modified: 1772246400000,
        },
      ],
    },
  },
  {
    id: "widget-output",
    state: {
      _model_name: "OutputModel",
      _model_module: "@jupyter-widgets/output",
      outputs: [
        {
          output_type: "stream",
          name: "stdout",
          text: "captured widget output\n",
        },
        {
          output_type: "display_data",
          data: {
            "application/json": {
              status: "complete",
              rows: 128,
              source: "OutputWidget fixture",
            },
            "text/plain": "{status: complete, rows: 128}",
          },
          metadata: {
            "application/json": { collapsed: 1 },
          },
        },
        {
          output_type: "display_data",
          data: {
            [WIDGET_VIEW_MIME]: { model_id: "widget-output-nested-threshold" },
            "text/plain": "IntSlider(value=41)",
          },
          metadata: {},
        },
      ],
    },
  },
  {
    id: "widget-output-nested-threshold",
    state: {
      _model_name: "IntSliderModel",
      _model_module: "@jupyter-widgets/controls",
      description: "nested threshold",
      value: 41,
      min: 0,
      max: 100,
      step: 1,
      readout: true,
      orientation: "horizontal",
      disabled: false,
    },
  },
  {
    id: "widget-canvas",
    state: {
      _model_name: "CanvasModel",
      _model_module: "ipycanvas",
      _canvas_manager: "IPY_MODEL_widget-canvas-manager",
      _send_client_ready_event: true,
      width: 320,
      height: 180,
    },
  },
  {
    id: "widget-anywidget",
    state: {
      _model_name: "AnyModel",
      _model_module: "anywidget",
      _esm: anyWidgetEsm,
      _css: anyWidgetCss,
      title: "AnyWidget AFM fixture",
      status: "inline ESM loaded by AnyWidgetView",
      value: 4,
    },
  },
  {
    id: "widget-anywidget-url",
    state: {
      _model_name: "AnyModel",
      _model_module: "anywidget",
      _esm: "",
      _css: "",
      title: "AnyWidget URL fixture",
      status: "static ESM and CSS URL loaded by AnyWidgetView",
      value: 7,
    },
  },
  {
    id: "widget-media-box",
    state: {
      _model_name: "GridBoxModel",
      _model_module: "@jupyter-widgets/controls",
      children: [
        "IPY_MODEL_widget-image",
        "IPY_MODEL_widget-binary-image",
        "IPY_MODEL_widget-buffer-url-image",
        "IPY_MODEL_widget-audio",
        "IPY_MODEL_widget-video",
        "IPY_MODEL_widget-file-upload",
      ],
      box_style: "info",
    },
  },
  {
    id: "widget-axis-x",
    state: {
      _model_name: "ControllerAxisModel",
      _model_module: "@jupyter-widgets/controls",
      value: 0.42,
    },
  },
  {
    id: "widget-axis-y",
    state: {
      _model_name: "ControllerAxisModel",
      _model_module: "@jupyter-widgets/controls",
      value: -0.28,
    },
  },
  {
    id: "widget-controller-a",
    state: {
      _model_name: "ControllerButtonModel",
      _model_module: "@jupyter-widgets/controls",
      pressed: true,
      value: 0.94,
    },
  },
  {
    id: "widget-controller-b",
    state: {
      _model_name: "ControllerButtonModel",
      _model_module: "@jupyter-widgets/controls",
      pressed: false,
      value: 0.12,
    },
  },
  {
    id: "widget-play",
    state: {
      _model_name: "PlayModel",
      _model_module: "@jupyter-widgets/controls",
      description: "frame",
      value: 6,
      min: 0,
      max: 12,
      step: 1,
      interval: 500,
      _playing: false,
      repeat: true,
      disabled: false,
    },
  },
  {
    id: "widget-summary",
    state: {
      _model_name: "HTMLModel",
      _model_module: "@jupyter-widgets/controls",
      description: "status",
      value: "<strong>Forecast ready</strong> <span>after 42 training windows</span>",
    },
  },
  {
    id: "widget-threshold",
    state: {
      _model_name: "IntSliderModel",
      _model_module: "@jupyter-widgets/controls",
      description: "threshold",
      value: 63,
      min: 0,
      max: 100,
      step: 1,
      readout: true,
      orientation: "horizontal",
      disabled: false,
    },
  },
  {
    id: "widget-progress-style",
    state: {
      _model_name: "ProgressStyleModel",
      _model_module: "@jupyter-widgets/controls",
      bar_color: "#0ea5e9",
    },
  },
  {
    id: "widget-progress",
    state: {
      _model_name: "IntProgressModel",
      _model_module: "@jupyter-widgets/controls",
      description: "backtest",
      value: 72,
      min: 0,
      max: 100,
      bar_style: "info",
      orientation: "horizontal",
      style: "IPY_MODEL_widget-progress-style",
    },
  },
  {
    id: "widget-category",
    state: {
      _model_name: "DropdownModel",
      _model_module: "@jupyter-widgets/controls",
      description: "segment",
      index: 1,
      _options_labels: ["All orders", "Returning customers", "New customers"],
      disabled: false,
    },
  },
  {
    id: "widget-flag",
    state: {
      _model_name: "CheckboxModel",
      _model_module: "@jupyter-widgets/controls",
      description: "show confidence interval",
      value: true,
      indent: false,
      disabled: false,
    },
  },
  {
    id: "widget-action",
    state: {
      _model_name: "ButtonModel",
      _model_module: "@jupyter-widgets/controls",
      description: "Run forecast",
      button_style: "primary",
      tooltip: "Fixture click logs a custom comm message",
      icon: "",
      disabled: false,
    },
  },
  {
    id: "widget-dashboard",
    state: {
      _model_name: "VBoxModel",
      _model_module: "@jupyter-widgets/controls",
      children: [
        "IPY_MODEL_widget-summary",
        "IPY_MODEL_widget-threshold",
        "IPY_MODEL_widget-progress",
        "IPY_MODEL_widget-category",
        "IPY_MODEL_widget-flag",
        "IPY_MODEL_widget-action",
      ],
      box_style: "info",
    },
  },
  {
    id: "widget-region",
    state: {
      _model_name: "RadioButtonsModel",
      _model_module: "@jupyter-widgets/controls",
      description: "region",
      index: 2,
      _options_labels: ["North", "South", "West"],
      disabled: false,
    },
  },
  {
    id: "widget-metric",
    state: {
      _model_name: "ToggleButtonsModel",
      _model_module: "@jupyter-widgets/controls",
      description: "metric",
      index: 0,
      _options_labels: ["MAE", "MAPE", "RMSE"],
      tooltips: [
        "Mean absolute error",
        "Mean absolute percentage error",
        "Root mean squared error",
      ],
      disabled: false,
    },
  },
  {
    id: "widget-horizon",
    state: {
      _model_name: "FloatSliderModel",
      _model_module: "@jupyter-widgets/controls",
      description: "horizon",
      value: 6.5,
      min: 1,
      max: 12,
      step: 0.5,
      readout: true,
      readout_format: ".1f",
      orientation: "horizontal",
      disabled: false,
    },
  },
  {
    id: "widget-confidence",
    state: {
      _model_name: "FloatRangeSliderModel",
      _model_module: "@jupyter-widgets/controls",
      description: "confidence",
      value: [0.12, 0.84],
      min: 0,
      max: 1,
      step: 0.01,
      readout: true,
      readout_format: ".2f",
      orientation: "horizontal",
      disabled: false,
    },
  },
  {
    id: "widget-feature-picker",
    state: {
      _model_name: "SelectMultipleModel",
      _model_module: "@jupyter-widgets/controls",
      description: "features",
      index: [0, 2, 3],
      _options_labels: ["month", "region", "segment", "discount"],
      rows: 4,
      disabled: false,
    },
  },
  {
    id: "widget-sku",
    state: {
      _model_name: "ComboboxModel",
      _model_module: "@jupyter-widgets/controls",
      description: "sku",
      value: "SKU-2048",
      options: ["SKU-1024", "SKU-2048", "SKU-4096"],
      placeholder: "Select SKU",
      ensure_option: false,
      continuous_update: true,
      disabled: false,
    },
  },
  {
    id: "widget-notes",
    state: {
      _model_name: "TextareaModel",
      _model_module: "@jupyter-widgets/controls",
      description: "notes",
      value: "Holiday lift is excluded from the baseline forecast.",
      rows: 3,
      placeholder: "Fixture notebook note",
      continuous_update: false,
      disabled: false,
    },
  },
  {
    id: "widget-report-date",
    state: {
      _model_name: "DatePickerModel",
      _model_module: "@jupyter-widgets/controls",
      description: "report date",
      value: { year: 2026, month: 4, date: 29 },
      min: { year: 2026, month: 0, date: 1 },
      max: { year: 2026, month: 11, date: 31 },
      disabled: false,
    },
  },
  {
    id: "widget-accent",
    state: {
      _model_name: "ColorPickerModel",
      _model_module: "@jupyter-widgets/controls",
      description: "accent",
      value: "#0ea5e9",
      concise: false,
      disabled: false,
    },
  },
  {
    id: "widget-valid",
    state: {
      _model_name: "ValidModel",
      _model_module: "@jupyter-widgets/controls",
      description: "validated",
      value: true,
      readout: "missing columns",
    },
  },
  {
    id: "widget-control-note",
    state: {
      _model_name: "LabelModel",
      _model_module: "@jupyter-widgets/controls",
      value: "Control widgets render through the same registry path as live comms.",
    },
  },
  {
    id: "widget-control-strip",
    state: {
      _model_name: "HBoxModel",
      _model_module: "@jupyter-widgets/controls",
      children: [
        "IPY_MODEL_widget-report-date",
        "IPY_MODEL_widget-accent",
        "IPY_MODEL_widget-valid",
      ],
      box_style: "success",
    },
  },
  {
    id: "widget-controls-suite",
    state: {
      _model_name: "VBoxModel",
      _model_module: "@jupyter-widgets/controls",
      children: [
        "IPY_MODEL_widget-control-note",
        "IPY_MODEL_widget-region",
        "IPY_MODEL_widget-metric",
        "IPY_MODEL_widget-horizon",
        "IPY_MODEL_widget-confidence",
        "IPY_MODEL_widget-feature-picker",
        "IPY_MODEL_widget-sku",
        "IPY_MODEL_widget-notes",
        "IPY_MODEL_widget-control-strip",
      ],
      box_style: "success",
    },
  },
  {
    id: "widget-tab",
    state: {
      _model_name: "TabModel",
      _model_module: "@jupyter-widgets/controls",
      children: ["IPY_MODEL_widget-dashboard", "IPY_MODEL_widget-media-box"],
      _titles: ["Controls", "Media"],
      selected_index: 0,
    },
  },
  {
    id: "widget-accordion",
    state: {
      _model_name: "AccordionModel",
      _model_module: "@jupyter-widgets/controls",
      children: ["IPY_MODEL_widget-controls-suite", "IPY_MODEL_widget-output"],
      _titles: ["Built-ins", "Captured output"],
      selected_index: 0,
    },
  },
  {
    id: "widget-stack",
    state: {
      _model_name: "StackModel",
      _model_module: "@jupyter-widgets/controls",
      children: ["IPY_MODEL_widget-media-box", "IPY_MODEL_widget-output"],
      selected_index: 1,
    },
  },
  {
    id: "widget-unknown",
    state: {
      _model_name: "CustomResearchWidgetModel",
      _model_module: "lab-extension",
      value: "adapter needed",
    },
  },
];

const renderedWidgets = [
  {
    name: "WidgetView",
    source: "src/components/widgets/widget-view.tsx",
    role: "Registry lookup, anywidget detection, unsupported fallback, and render error boundary.",
  },
  {
    name: "WidgetStoreContext",
    source: "src/components/widgets/widget-store-context.tsx",
    role: "Fixture provider uses the production context shape without notebook comm routing.",
  },
  {
    name: "IntSlider",
    source: "src/components/widgets/controls/int-slider.tsx",
    role: "Interactive numeric traitlet fixture with optimistic store update.",
  },
  {
    name: "IntProgress",
    source: "src/components/widgets/controls/int-progress.tsx",
    role: "ProgressStyleModel reference resolution through IPY_MODEL state.",
  },
  {
    name: "Form controls",
    source:
      "src/components/widgets/controls/{textarea,radio-buttons,toggle-buttons,combobox,select-multiple}-widget.tsx",
    role: "Text entry and selection traitlets update local fixture state through the production store contract.",
  },
  {
    name: "Numeric controls",
    source: "src/components/widgets/controls/{float-slider,float-range-slider}.tsx",
    role: "Float widgets exercise the same readout formatting and range update paths as live comms.",
  },
  {
    name: "Status controls",
    source:
      "src/components/widgets/controls/{date-picker-widget,color-picker,valid-widget,label-widget}.tsx",
    role: "Date, color, validation, and label models render from ordinary saved widget state.",
  },
  {
    name: "HBoxWidget",
    source: "src/components/widgets/controls/hbox-widget.tsx",
    role: "Horizontal container resolves child model references and shares the WidgetView nesting path.",
  },
  {
    name: "VBoxWidget",
    source: "src/components/widgets/controls/vbox-widget.tsx",
    role: "Container widget resolves child model references and nests WidgetView.",
  },
  {
    name: "ButtonWidget",
    source: "src/components/widgets/controls/button-widget.tsx",
    role: "Custom comm event is logged by the fixture adapter instead of sent to a kernel.",
  },
  {
    name: "Media widgets",
    source: "src/components/widgets/controls/{image-widget,audio-widget,video-widget}.tsx",
    role: "Image, audio, and video widgets render through buildMediaSrc with static data URLs, hydrated DataViews, and a bufferPaths URL fixture.",
  },
  {
    name: "FileUploadWidget",
    source: "src/components/widgets/controls/file-upload-widget.tsx",
    role: "The upload surface renders saved value state and keeps local file selection inside the fixture store.",
  },
  {
    name: "OutputWidget",
    source: "src/components/widgets/controls/output-widget.tsx",
    role: "Captured outputs flow through the widget OutputModel path and nested widget-view MIME resolves through MediaProvider without a live comm channel.",
  },
  {
    name: "ipycanvas widget",
    source: "src/components/widgets/ipycanvas/{canvas-widget,ipycanvas-commands}.tsx",
    role: "CanvasModel renders through WidgetView and replays a local binary command buffer via the CanvasManager router.",
  },
  {
    name: "AnyWidgetView",
    source: "src/components/widgets/anywidget-view.tsx",
    role: "Inline and URL-backed _esm/_css fixtures exercise the AFM model proxy, CSS injection, state save, and custom message bridge.",
  },
  {
    name: "Layout containers",
    source: "src/components/widgets/controls/{gridbox,tab,accordion,stack}-widget.tsx",
    role: "Container widgets resolve IPY_MODEL children and render nested WidgetView surfaces from saved state.",
  },
  {
    name: "Play and controller controls",
    source:
      "src/components/widgets/controls/{play-widget,controller-button-widget,controller-axis-widget}.tsx",
    role: "Browser-bound controls render from frozen state while live Gamepad polling remains an explicit adapter boundary.",
  },
];

const adapterBoundaries = [
  {
    title: "RuntimeStateDoc inbound",
    icon: DatabaseZap,
    body: "The notebook app receives ResolvedComm events from sync. This page seeds the same WidgetStore shape directly.",
  },
  {
    title: "Comm bridge outbound",
    icon: Cable,
    body: "State updates stay local to the fixture. Custom messages are logged instead of crossing JSON-RPC or shell channels.",
  },
  {
    title: "Binary buffers",
    icon: FileJson,
    body: "Media widgets now cover inline DataViews and a docs-local bufferPaths URL hydrator; ipycanvas replays a local DataView command buffer. Live kernel blob resolver state and sync hydration remain adapter concerns.",
  },
  {
    title: "Anywidget ESM",
    icon: PackageOpen,
    body: "Inline and URL-backed _esm/_css now mount through AnyWidgetView. Kernel-originated blob resolver URLs and sandbox policy remain iframe/runtime adapter concerns.",
  },
];

const savedPasswordModel = {
  id: "widget-password-snapshot",
  modelName: "PasswordModel",
  modelModule: "@jupyter-widgets/controls",
  state: {
    description: "token",
    value: "hidden-in-static-summary",
  },
};

async function seedStore(store: WidgetStore): Promise<string[]> {
  const hydratedModels: string[] = [];

  for (const model of fixtureModels) {
    const state = structuredClone(model.state) as Record<string, unknown>;
    if (model.id === "widget-anywidget-url") {
      state._esm = fixtureAssetUrl("/fixtures/anywidget-url-fixture.js");
      state._css = fixtureAssetUrl("/fixtures/anywidget-url-fixture.css");
    } else if (model.id === "widget-buffer-url-image") {
      state.value = fixtureAssetUrl("/fixtures/widget-buffer-url-image.svg");
    }

    const hydratedPaths = await resolveFixtureBufferUrlsInPlace(state, model.bufferPaths);
    if (hydratedPaths.length > 0) {
      hydratedModels.push(`${model.id}: ${hydratedPaths.join(", ")}`);
    }

    store.createModel(model.id, state, model.bufferPaths);
  }

  return hydratedModels;
}

function canvasCommand(name: (typeof COMMANDS)[number], args: unknown[] = []) {
  const index = COMMANDS.indexOf(name);
  if (index < 0) throw new Error(`Unknown ipycanvas command: ${name}`);
  return [index, args];
}

const canvasCommands = [
  canvasCommand("switchCanvas", ["IPY_MODEL_widget-canvas"]),
  canvasCommand("clear"),
  canvasCommand("set", [0, "#eff6ff"]),
  canvasCommand("fillRect", [0, 0, 320, 180]),
  canvasCommand("set", [0, "#0ea5e9"]),
  canvasCommand("fillRect", [24, 32, 84, 104]),
  canvasCommand("set", [0, "#10b981"]),
  canvasCommand("fillCircle", [166, 84, 38]),
  canvasCommand("set", [1, "#111827"]),
  canvasCommand("set", [8, 4]),
  canvasCommand("strokeLine", [36, 146, 294, 46]),
  canvasCommand("set", [0, "#111827"]),
  canvasCommand("set", [3, "16px ui-sans-serif, system-ui"]),
  canvasCommand("fillText", ["ipycanvas fixture", 104, 158]),
];

function encodeCanvasCommands(commands: unknown[]): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(commands));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function CanvasCommandFixture() {
  const { store } = useWidgetStoreRequired();
  const [replayCount, setReplayCount] = useState(0);

  const replayCommands = useCallback(() => {
    store.emitCustomMessage("widget-canvas-manager", { dtype: "uint8" }, [
      encodeCanvasCommands(canvasCommands),
    ]);
    setReplayCount((count) => count + 1);
  }, [store]);

  useEffect(() => {
    replayCommands();
  }, [replayCommands]);

  return (
    <div
      className="rounded-lg border border-fd-border bg-fd-background p-4"
      data-testid="widget-canvas-suite"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">ipycanvas command replay</h3>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            CanvasModel renders through WidgetView. The fixture sends the same binary command buffer
            shape the CanvasManager router receives from the kernel, without a live comm.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={replayCommands}>
          Replay commands
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <div className="overflow-hidden rounded-md border border-fd-border bg-white p-2 dark:bg-neutral-950">
          <WidgetView modelId="widget-canvas" className="max-w-full" />
        </div>
        <div className="rounded-md border border-fd-border bg-fd-card p-3">
          <div className="text-[11px] font-medium uppercase text-fd-muted-foreground">
            Command buffer
          </div>
          <div className="mt-2 grid gap-2 text-xs">
            <div className="flex justify-between gap-3">
              <span className="text-fd-muted-foreground">commands</span>
              <span className="font-mono">{canvasCommands.length}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-fd-muted-foreground">dtype</span>
              <span className="font-mono">uint8</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-fd-muted-foreground">replays</span>
              <span className="font-mono">{replayCount}</span>
            </div>
          </div>
          <div className="mt-3 break-words font-mono text-[11px] leading-5 text-fd-muted-foreground [overflow-wrap:anywhere]">
            {"switchCanvas -> clear -> set -> fillRect -> fillCircle -> strokeLine -> fillText"}
          </div>
        </div>
      </div>
    </div>
  );
}

function AnyWidgetFixture() {
  const { store } = useWidgetStoreRequired();

  const sendCustomPayload = useCallback(() => {
    const buffer = new Uint8Array([4, 8, 15, 16]).buffer;
    store.emitCustomMessage("widget-anywidget", { kind: "docs-custom-payload" }, [buffer]);
    store.emitCustomMessage("widget-anywidget-url", { kind: "docs-url-payload" }, [buffer]);
  }, [store]);

  useEffect(() => {
    sendCustomPayload();
  }, [sendCustomPayload]);

  return (
    <div
      className="rounded-lg border border-fd-border bg-fd-background p-4"
      data-testid="widget-anywidget-suite"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">AnyWidget AFM fixture</h3>
          <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
            AnyModel renders through WidgetView and AnyWidgetView. The fixtures exercise inline and
            URL-backed ESM/CSS, model.get, model.set, save_changes, and msg:custom without a live
            comm.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={sendCustomPayload}>
          Send custom payload
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div data-testid="widget-anywidget-inline-surface">
          <WidgetView modelId="widget-anywidget" />
        </div>
        <div data-testid="widget-anywidget-url-surface">
          <WidgetView modelId="widget-anywidget-url" />
        </div>
      </div>
    </div>
  );
}

function WidgetFixtureProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<WidgetStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createWidgetStore();
  }
  const store = storeRef.current;
  const [events, setEvents] = useState<string[]>([]);

  const logEvent = useCallback((event: string) => {
    setEvents((current) => [event, ...current].slice(0, 5));
  }, []);

  const resetFixtures = useCallback(async () => {
    const hydratedModels = await seedStore(store);
    logEvent("seeded fixture comm state");
    for (const model of hydratedModels) {
      logEvent(`hydrated ${model}`);
    }
  }, [logEvent, store]);

  useEffect(() => {
    void resetFixtures();
  }, [resetFixtures]);
  useEffect(() => createCanvasManagerRouter(store), [store]);

  const sendUpdate = useCallback(
    async (commId: string, state: Record<string, unknown>) => {
      store.updateModel(commId, state);
      logEvent(`update ${commId}: ${Object.keys(state).join(", ")}`);
    },
    [logEvent, store],
  );

  const sendCustom = useCallback(
    (commId: string, content: Record<string, unknown>) => {
      logEvent(`custom ${commId}: ${JSON.stringify(content)}`);
    },
    [logEvent],
  );

  const closeComm = useCallback(
    (commId: string) => {
      store.deleteModel(commId);
      logEvent(`closed ${commId}`);
    },
    [logEvent, store],
  );

  const contextValue = useMemo(
    () => ({
      store,
      sendUpdate,
      sendCustom,
      closeComm,
    }),
    [closeComm, sendCustom, sendUpdate, store],
  );

  const widgetRenderers = useMemo<Record<string, CustomRenderer>>(
    () => ({
      [WIDGET_VIEW_MIME]: ({ data }) => {
        const modelId = parseWidgetViewModelId(data);
        return modelId ? <WidgetView modelId={modelId} /> : null;
      },
    }),
    [],
  );

  return (
    <WidgetStoreContext.Provider value={contextValue}>
      <MediaProvider renderers={widgetRenderers}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <WidgetInventory />
            <Button size="sm" variant="outline" onClick={() => void resetFixtures()}>
              Reset fixtures
            </Button>
          </div>
          {children}
          <div
            className="rounded-lg border border-fd-border bg-fd-background p-3"
            data-testid="widget-event-log"
          >
            <div className="text-xs font-medium uppercase text-fd-muted-foreground">Comm log</div>
            <div className="mt-2 space-y-1 font-mono text-xs text-fd-muted-foreground">
              {events.length > 0
                ? events.map((event, index) => <div key={`${index}-${event}`}>{event}</div>)
                : "idle"}
            </div>
          </div>
        </div>
      </MediaProvider>
    </WidgetStoreContext.Provider>
  );
}

function WidgetInventory() {
  const models = useWidgetModels();
  const visibleModels = Array.from(models.values()).filter(
    (model) => model.modelName !== "ProgressStyleModel",
  );

  return (
    <div className="flex flex-wrap gap-2 text-xs text-fd-muted-foreground">
      <span className="rounded-full border border-fd-border bg-fd-card px-2 py-1">
        {visibleModels.length} rendered models
      </span>
      <span className="rounded-full border border-fd-border bg-fd-card px-2 py-1">
        {models.size} fixture comms
      </span>
    </div>
  );
}

export function WidgetSurfacesExample() {
  return (
    <div className="not-prose space-y-6" data-testid="widget-surfaces-example">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-900 dark:text-emerald-100">
        <div className="flex items-start gap-3">
          <SlidersHorizontal className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Widget fixtures use the real widget path</h2>
            <p className="mt-1 text-xs leading-5">
              This page imports current widget store, registry, WidgetView, and selected built-in
              controls. Runtime sync, iframe transport, generated WASM, and kernel comms stay behind
              explicit adapters.
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
        <div className="border-b border-fd-border p-4">
          <div className="flex items-center gap-2">
            <Boxes className="size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h2 className="text-sm font-semibold">Fixture-backed widget output</h2>
          </div>
          <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
            The dashboard below is a VBoxModel rendered by WidgetView. Its children are ordinary
            ipywidgets model states stored in a local WidgetStore.
          </p>
        </div>
        <div className="p-4">
          <WidgetFixtureProvider>
            <div
              className="rounded-lg border border-fd-border bg-fd-background p-4"
              data-testid="widget-fixture-dashboard"
            >
              <WidgetView modelId="widget-dashboard" />
            </div>
            <div
              className="rounded-lg border border-fd-border bg-fd-background p-4"
              data-testid="widget-control-suite"
            >
              <div className="mb-3">
                <h3 className="text-sm font-semibold">Built-in controls suite</h3>
                <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                  These models come from the current controls registry and render through
                  WidgetView, not page-local form components.
                </p>
              </div>
              <WidgetView modelId="widget-controls-suite" />
            </div>
            <div
              className="rounded-lg border border-fd-border bg-fd-background p-4"
              data-testid="widget-media-suite"
            >
              <div className="mb-3">
                <h3 className="text-sm font-semibold">Media and captured output widgets</h3>
                <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                  Image, audio, video, file upload, and OutputModel fixtures render through
                  WidgetView with saved comm state, static payloads, hydrated DataView image values,
                  a docs-local buffer URL fixture, and a nested widget-view MIME output.
                </p>
              </div>
              <div className="space-y-4">
                <WidgetView modelId="widget-media-title" />
                <WidgetView modelId="widget-media-box" />
                <WidgetView modelId="widget-output" />
              </div>
            </div>
            <CanvasCommandFixture />
            <AnyWidgetFixture />
            <div
              className="rounded-lg border border-fd-border bg-fd-background p-4"
              data-testid="widget-layout-suite"
            >
              <div className="mb-3">
                <h3 className="text-sm font-semibold">Layout and browser-bound controls</h3>
                <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
                  Tabs, accordion, stack, play, and controller sub-controls render from fixture
                  state. The live ControllerModel Gamepad loop remains a browser adapter boundary.
                </p>
              </div>
              <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
                <div className="space-y-4">
                  <WidgetView modelId="widget-tab" />
                  <WidgetView modelId="widget-accordion" />
                  <WidgetView modelId="widget-stack" />
                </div>
                <div className="space-y-3 rounded-lg border border-fd-border bg-fd-card p-3">
                  <WidgetView modelId="widget-play" />
                  <div className="flex items-center gap-2">
                    <WidgetView modelId="widget-controller-a" />
                    <WidgetView modelId="widget-controller-b" />
                  </div>
                  <WidgetView modelId="widget-axis-x" />
                  <WidgetView modelId="widget-axis-y" />
                </div>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-fd-border bg-fd-background p-4">
                <h3 className="text-sm font-semibold">Unsupported model fallback</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
                  Unknown widget models still render through the production fallback path.
                </p>
                <div className="mt-3">
                  <WidgetView modelId="widget-unknown" />
                </div>
              </div>
              <div className="rounded-lg border border-fd-border bg-fd-background p-4">
                <h3 className="text-sm font-semibold">Static saved-state summary</h3>
                <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">
                  WidgetView can show a non-live saved snapshot when comm state is unavailable.
                </p>
                <div className="mt-3">
                  <WidgetView
                    modelId="widget-password-snapshot"
                    widgetStateHint={{ savedModel: savedPasswordModel }}
                  />
                </div>
              </div>
            </div>
          </WidgetFixtureProvider>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        {renderedWidgets.map((item) => (
          <div key={item.name} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <h3 className="text-sm font-semibold">{item.name}</h3>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{item.role}</p>
            <div className="mt-3 break-words font-mono text-[11px] leading-5 text-fd-muted-foreground [overflow-wrap:anywhere]">
              {item.source}
            </div>
          </div>
        ))}
      </section>

      <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {adapterBoundaries.map((item) => (
          <div key={item.title} className="rounded-lg border border-fd-border bg-fd-card p-4">
            <item.icon className="mb-3 size-4 text-fd-muted-foreground" aria-hidden="true" />
            <h3 className="text-sm font-semibold">{item.title}</h3>
            <p className="mt-2 text-xs leading-5 text-fd-muted-foreground">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <CircleDotDashed className="mt-0.5 size-4 flex-none text-amber-600" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Next widget adapters</h2>
            <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">
              The remaining widget catalog work is narrower now: live kernel blob resolver state,
              ControllerModel Gamepad polling, live output-widget comm replay, richer ipycanvas
              image buffers, and kernel-originated anywidget asset URLs need explicit iframe/runtime
              adapters before they can render here.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
