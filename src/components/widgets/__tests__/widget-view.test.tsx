import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { SavedWidgetStateProvider } from "../saved-widget-state-context";
import { createWidgetStore } from "../widget-store";
import { WidgetStoreContext } from "../widget-store-context";
import { WidgetView } from "../widget-view";

function renderWithWidgetStore(children: ReactNode) {
  const store = createWidgetStore();
  return render(
    <WidgetStoreContext.Provider
      value={{
        store,
        sendUpdate: async () => {},
        sendCustom: () => {},
        closeComm: () => {},
      }}
    >
      {children}
    </WidgetStoreContext.Provider>,
  );
}

describe("WidgetView stale/static states", () => {
  it("renders a saved widget snapshot instead of loading when metadata has the model", () => {
    renderWithWidgetStore(
      <SavedWidgetStateProvider
        models={
          new Map([
            [
              "slider-1",
              {
                id: "slider-1",
                modelName: "IntSliderModel",
                modelModule: "@jupyter-widgets/controls",
                state: { value: 7, min: 0, max: 10 },
              },
            ],
          ])
        }
      >
        <WidgetView modelId="slider-1" />
      </SavedWidgetStateProvider>,
    );

    expect(screen.getByText("Widget snapshot")).toBeInTheDocument();
    expect(screen.getByText("IntSlider: 7 (0-10)")).toBeInTheDocument();
    expect(screen.queryByText("Loading widget...")).not.toBeInTheDocument();
  });

  it("renders an unavailable state for static surfaces without model state", () => {
    renderWithWidgetStore(
      <WidgetView modelId="missing-1" widgetStateHint={{ missingState: "stale" }} />,
    );

    expect(screen.getByText("Widget state unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Loading widget...")).not.toBeInTheDocument();
  });
});
