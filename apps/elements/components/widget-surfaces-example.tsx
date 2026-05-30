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
    body: "bufferPaths and DataView replacement are adapter concerns for image, audio, video, and anywidget bytes.",
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
              Image, audio, video, FileUpload, OutputModel, controller, ipycanvas, and anywidget
              examples should be added once the catalog has isolated adapters for blob URLs,
              DataViews, rich output routing, browser APIs, and ESM module loading.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
