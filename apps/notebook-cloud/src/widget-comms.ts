export interface SnapshotWidgetComm {
  comm_id: string;
  target_name: string;
  model_module: string;
  model_name: string;
  state: Record<string, unknown>;
  buffer_paths?: string[][];
  seq: number;
}

export function snapshotWidgetCommsFromRuntimeState(runtimeState: unknown): SnapshotWidgetComm[] {
  const comms = asRecord(asRecord(runtimeState).comms);
  return normalizeSnapshotWidgetComms(
    Object.entries(comms).map(([commId, entry]) => ({
      ...asRecord(entry),
      comm_id: commId,
    })),
  );
}

export function normalizeSnapshotWidgetComms(value: unknown): SnapshotWidgetComm[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeSnapshotWidgetComm(entry))
    .filter((entry): entry is SnapshotWidgetComm => entry !== null)
    .sort((a, b) => a.seq - b.seq);
}

export function widgetCommStoreState(comm: SnapshotWidgetComm): Record<string, unknown> {
  return {
    ...comm.state,
    _model_module: stringValue(comm.state._model_module) ?? optionalString(comm.model_module),
    _model_name: stringValue(comm.state._model_name) ?? optionalString(comm.model_name),
  };
}

function normalizeSnapshotWidgetComm(value: unknown): SnapshotWidgetComm | null {
  const entry = asRecord(value);
  const commId = stringValue(entry.comm_id) ?? stringValue(entry.commId);
  if (!commId) return null;

  const modelModule = stringValue(entry.model_module) ?? stringValue(entry.modelModule) ?? "";
  const modelName = stringValue(entry.model_name) ?? stringValue(entry.modelName) ?? "UnknownModel";
  const state = asRecord(entry.state);

  const bufferPaths = normalizeBufferPaths(entry.buffer_paths ?? entry.bufferPaths);

  return {
    comm_id: commId,
    target_name:
      stringValue(entry.target_name) ?? stringValue(entry.targetName) ?? "jupyter.widget",
    model_module: modelModule,
    model_name: modelName,
    state,
    ...(bufferPaths ? { buffer_paths: bufferPaths } : {}),
    seq: numberValue(entry.seq) ?? 0,
  };
}

function normalizeBufferPaths(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value.filter(
    (path): path is string[] =>
      Array.isArray(path) && path.every((part) => typeof part === "string"),
  );
  return paths.length > 0 ? paths : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
