import type { CellData } from "../types";
import {
	mcpAppCellHasRichOutput,
	mcpAppCellPreviewText,
} from "@/components/isolated/mcp-app-structured-content";

/** Whether a cell has any output that should be visually expanded. */
export function hasRichOutput(cell: CellData): boolean {
	return mcpAppCellHasRichOutput(cell);
}

/** Extract a one-line preview string for a collapsed cell. */
export function getPreviewText(cell: CellData): string {
	return mcpAppCellPreviewText(cell);
}
