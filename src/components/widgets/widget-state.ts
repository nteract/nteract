import type { WidgetModel } from "./widget-store";

export const WIDGET_VIEW_MIME = "application/vnd.jupyter.widget-view+json";
export const WIDGET_STATE_MIME = "application/vnd.jupyter.widget-state+json";

export interface SavedWidgetModel {
  id: string;
  modelName: string;
  modelModule: string;
  modelModuleVersion?: string;
  state: Record<string, unknown>;
}

export type SavedWidgetModels = Map<string, SavedWidgetModel>;

export interface WidgetViewStateHint {
  savedModel?: SavedWidgetModel;
  summary?: string;
  missingState?: "stale";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseWidgetViewModelId(value: unknown): string | null {
  const record = parseJsonObject(value);
  return stringValue(record?.model_id) ?? null;
}

function extractWidgetStateBlock(value: unknown): Record<string, unknown> | null {
  const record = parseJsonObject(value);
  if (!record) return null;

  const direct = parseJsonObject(record[WIDGET_STATE_MIME]);
  if (direct) return direct;

  const widgets = parseJsonObject(record.widgets);
  if (widgets) {
    const fromWidgets = parseJsonObject(widgets[WIDGET_STATE_MIME]);
    if (fromWidgets) return fromWidgets;
  }

  if (isRecord(record.state)) return record;
  return null;
}

export function parseSavedWidgetModels(value: unknown): SavedWidgetModels {
  const block = extractWidgetStateBlock(value);
  const state = parseJsonObject(block?.state);
  if (!state) return new Map();

  const models: SavedWidgetModels = new Map();
  for (const [id, rawModel] of Object.entries(state)) {
    const model = parseJsonObject(rawModel);
    const modelState = parseJsonObject(model?.state);
    if (!model || !modelState) continue;

    const modelName =
      stringValue(model.model_name) ?? stringValue(modelState._model_name) ?? "UnknownModel";
    const modelModule =
      stringValue(model.model_module) ?? stringValue(modelState._model_module) ?? "";
    const modelModuleVersion =
      stringValue(model.model_module_version) ?? stringValue(modelState._model_module_version);

    models.set(id, {
      id,
      modelName,
      modelModule,
      modelModuleVersion,
      state: modelState,
    });
  }

  return models;
}

function widgetDisplayName(modelName: string): string {
  return modelName.endsWith("Model") ? modelName.slice(0, -"Model".length) : modelName;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 77)}...` : json;
  } catch {
    return String(value);
  }
}

export function isSecretWidget(modelName: string): boolean {
  return modelName === "PasswordModel";
}

export function formatSavedWidgetSummary(model: SavedWidgetModel | WidgetModel): string {
  const name = widgetDisplayName(model.modelName);
  if (isSecretWidget(model.modelName)) return `${name}: value hidden`;

  const description =
    typeof model.state.description === "string" && model.state.description.length > 0
      ? `${model.state.description}: `
      : "";

  if ("value" in model.state) {
    const value = compactValue(model.state.value);
    if ("min" in model.state && "max" in model.state) {
      return `${description}${name}: ${value} (${compactValue(model.state.min)}-${compactValue(
        model.state.max,
      )})`;
    }
    return `${description}${name}: ${value}`;
  }

  return `${description}${name}`;
}
