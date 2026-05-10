import { createElement, useEffect, useState, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WidgetDCFCell } from "buckaroo/lib/components/DCFCell";

type AnyModel = {
  get(key: string): unknown;
  on(event: string, callback: () => void): void;
  off(event: string, callback: () => void): void;
  set(key: string, value: unknown): void;
  save_changes(): void;
};

const BuckarooTable = WidgetDCFCell as ComponentType<Record<string, unknown>>;

function useModelState<T>(model: AnyModel, key: string): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => model.get(key) as T);

  useEffect(() => {
    const update = () => setValue(model.get(key) as T);
    model.on(`change:${key}`, update);
    return () => model.off(`change:${key}`, update);
  }, [model, key]);

  return [
    value,
    (nextValue) => {
      setValue(nextValue);
      model.set(key, nextValue);
      model.save_changes();
    },
  ];
}

function BuckarooAnywidgetFixture({ model }: { model: AnyModel }) {
  const [operations, setOperations] = useModelState<unknown[]>(model, "operations");
  const [buckarooState, setBuckarooState] = useModelState<Record<string, unknown>>(model, "buckaroo_state");

  return createElement(
    "div",
    { className: "buckaroo_anywidget", style: { height: 360, width: 760 } },
    createElement(BuckarooTable, {
      df_data_dict: model.get("df_data_dict"),
      df_display_args: model.get("df_display_args"),
      df_meta: model.get("df_meta"),
      operations,
      on_operations: setOperations,
      operation_results: model.get("operation_results"),
      commandConfig: model.get("command_config"),
      buckaroo_state: buckarooState,
      on_buckaroo_state: setBuckarooState,
      buckaroo_options: model.get("buckaroo_options"),
    }),
  );
}

export function render({ model, el }: { model: AnyModel; el: HTMLElement }) {
  const root: Root = createRoot(el);
  root.render(createElement(BuckarooAnywidgetFixture, { model }));
  return () => root.unmount();
}
