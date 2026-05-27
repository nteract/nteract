import { describe, expect, it } from "vite-plus/test";
import { parseSavedWidgetModels, parseWidgetViewModelId, WIDGET_STATE_MIME } from "../widget-state";

describe("widget state parsing", () => {
  it("extracts the model id from object or string widget-view payloads", () => {
    expect(parseWidgetViewModelId({ model_id: "abc" })).toBe("abc");
    expect(parseWidgetViewModelId('{"model_id":"def"}')).toBe("def");
    expect(parseWidgetViewModelId('{"not_model_id":"def"}')).toBeNull();
  });

  it("parses saved models from Jupyter widget-state metadata", () => {
    const models = parseSavedWidgetModels({
      widgets: {
        [WIDGET_STATE_MIME]: {
          version_major: 2,
          version_minor: 0,
          state: {
            "slider-1": {
              model_name: "IntSliderModel",
              model_module: "@jupyter-widgets/controls",
              model_module_version: "2.0.0",
              state: {
                value: 5,
                min: 0,
                max: 10,
              },
            },
          },
        },
      },
    });

    expect(models.get("slider-1")).toMatchObject({
      id: "slider-1",
      modelName: "IntSliderModel",
      modelModule: "@jupyter-widgets/controls",
      modelModuleVersion: "2.0.0",
      state: {
        value: 5,
        min: 0,
        max: 10,
      },
    });
  });
});
