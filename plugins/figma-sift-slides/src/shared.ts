export type SiftSourceMetadata = {
  kind: "url" | "file";
  label: string;
  url?: string;
};

export type InsertTablePayload = {
  title: string;
  source: SiftSourceMetadata;
  columns: string[];
  rows: string[][];
  totalRows: number;
  filteredRows: number;
  visibleRows: number;
  stateLabel: string;
};

export type UiToPluginMessage =
  | {
      type: "insert-table";
      payload: InsertTablePayload;
    }
  | {
      type: "notify";
      message: string;
    };

export type PluginToUiMessage =
  | {
      type: "insert-result";
      ok: boolean;
      message: string;
    }
  | {
      type: "hydrate-source";
      source: SiftSourceMetadata;
    };
