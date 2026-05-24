export type CloudLogLevel = "debug" | "info" | "warn" | "error";

export type CloudLogFieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean | null)[];

export type CloudLogFields = Record<string, CloudLogFieldValue>;

export interface CloudLogRecord extends Record<string, CloudLogFieldValue> {
  service: "nteract-notebook-cloud";
  event: string;
  timestamp: string;
}

const LOG_PREFIX = "[notebook-cloud]";

export function cloudLog(level: CloudLogLevel, event: string, fields: CloudLogFields = {}): void {
  console[level](LOG_PREFIX, structuredCloudLog(event, fields));
}

export function structuredCloudLog(event: string, fields: CloudLogFields = {}): CloudLogRecord {
  const record: CloudLogRecord = {
    service: "nteract-notebook-cloud",
    event,
    timestamp: new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    record[key] = value;
  }

  return record;
}

export function durationMs(startedAtMs: number): number {
  return Math.max(0, Math.round((Date.now() - startedAtMs) * 100) / 100);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
