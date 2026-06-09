import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CloudWidgetStoreProvider } from "../../../../apps/notebook-cloud/viewer/widget-runtime";
import { setCrdtCommWriter } from "../crdt-comm-writer";
import { useWidgetStoreRequired, type WidgetStore } from "../widget-store-context";

describe("CloudWidgetStoreProvider", () => {
  afterEach(() => {
    setCrdtCommWriter(null);
  });

  it("persists widget state updates through the CRDT writer", async () => {
    const writes: Array<{ commId: string; patch: Record<string, unknown> }> = [];
    let context:
      | {
          sendUpdate: (commId: string, state: Record<string, unknown>) => Promise<void>;
          store: WidgetStore;
        }
      | undefined;

    setCrdtCommWriter((commId, patch) => {
      writes.push({ commId, patch });
    });

    function Probe() {
      context = useWidgetStoreRequired();
      useEffect(() => {
        context?.store.createModel("comm-slider", {
          _model_module: "@jupyter-widgets/controls",
          _model_name: "IntSliderModel",
          value: 7,
        });
      }, []);
      return null;
    }

    render(
      <CloudWidgetStoreProvider>
        <Probe />
      </CloudWidgetStoreProvider>,
    );

    await waitFor(() => expect(context?.store.getModel("comm-slider")).toBeDefined());
    await context?.sendUpdate("comm-slider", { value: 18 });

    expect(context?.store.getModel("comm-slider")?.state.value).toBe(18);
    await waitFor(() => expect(writes).toEqual([{ commId: "comm-slider", patch: { value: 18 } }]));
  });
});
