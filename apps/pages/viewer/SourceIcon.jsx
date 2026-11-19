import {
  ChartNoAxesCombined,
  File,
  FileAudio,
  FileCode,
  FileDigit,
  FileJson,
  FileSpreadsheet,
  Paintbrush,
  Puzzle,
  Table2,
} from "lucide-react";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { ANYWIDGET_MEDIA_TYPE } from "../shared/anywidget-view.mjs";

export function SourceIcon({ mediaType, size = 16, strokeWidth = 2 }) {
  const Icon =
    {
      [PARQUET_MEDIA_TYPE]: Table2,
      "text/javascript": FileCode,
      "text/css": Paintbrush,
      "application/json": FileJson,
      "text/csv": FileSpreadsheet,
      "application/octet-stream": FileDigit,
      "audio/wav": FileAudio,
      "application/vnd.vegalite.v6+json": ChartNoAxesCombined,
      [ANYWIDGET_MEDIA_TYPE]: Puzzle,
    }[mediaType] ?? File;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
}
