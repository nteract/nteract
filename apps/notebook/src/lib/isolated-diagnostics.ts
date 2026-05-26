import {
  shouldLogIsolatedDiagnostic,
  type IsolatedDiagnosticHandler,
} from "@/components/isolated/diagnostics";
import { logger } from "./logger";

export const logNotebookIsolatedDiagnostic: IsolatedDiagnosticHandler = (
  phase,
  details = {},
  level = "debug",
  source = "isolated-frame",
) => {
  if (!shouldLogIsolatedDiagnostic(level)) {
    return;
  }

  logger[level](`[${source}] ${phase}`, details);
};
