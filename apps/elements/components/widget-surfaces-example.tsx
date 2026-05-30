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
import { Button } from "@/components/ui/button";
import "@/components/widgets/controls";
import { WidgetStoreContext, useWidgetModels } from "@/components/widgets/widget-store-context";
import { createWidgetStore, type WidgetStore } from "@/components/widgets/widget-store";
import { WidgetView } from "@/components/widgets/widget-view";

type FixtureModel = {
  id: string;
  state: Record<string, unknown>;
  bufferPaths?: string[][];
};

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
      ],
    },
  },
  {
    id: "widget-media-box",
    state: {
      _model_name: "GridBoxModel",
      _model_module: "@jupyter-widgets/controls",
      children: [
        "IPY_MODEL_widget-image",
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
    role: "Image, audio, and video widgets render through buildMediaSrc with static data URLs instead of kernel-provided buffers.",
  },
  {
    name: "FileUploadWidget",
    source: "src/components/widgets/controls/file-upload-widget.tsx",
    role: "The upload surface renders saved value state and keeps local file selection inside the fixture store.",
  },
  {
    name: "OutputWidget",
    source: "src/components/widgets/controls/output-widget.tsx",
    role: "Captured outputs flow through the widget OutputModel path and MediaRouter without a live comm channel.",
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
    body: "Media widgets render from static data URLs here; bufferPaths and DataView replacement remain adapter concerns for live kernel bytes.",
  },
  {
    title: "Anywidget ESM",
    icon: PackageOpen,
    body: "Dynamic _esm and _css loading remains an iframe/runtime boundary, not a docs-page side effect.",
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

function seedStore(store: WidgetStore) {
  for (const model of fixtureModels) {
    store.createModel(model.id, model.state, model.bufferPaths);
  }
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

  const resetFixtures = useCallback(() => {
    seedStore(store);
    logEvent("seeded fixture comm state");
  }, [logEvent, store]);

  useEffect(() => {
    resetFixtures();
  }, [resetFixtures]);

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

  return (
    <WidgetStoreContext.Provider value={contextValue}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <WidgetInventory />
          <Button size="sm" variant="outline" onClick={resetFixtures}>
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
                  WidgetView with saved comm state and static payloads.
                </p>
              </div>
              <div className="space-y-4">
                <WidgetView modelId="widget-media-title" />
                <WidgetView modelId="widget-media-box" />
                <WidgetView modelId="widget-output" />
              </div>
            </div>
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
              The remaining widget catalog work is narrower now: binary buffer hydration, live
              ControllerModel Gamepad polling, ipycanvas, output-widget nesting, and anywidget ESM
              loading need explicit iframe/runtime adapters before they can render here.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
