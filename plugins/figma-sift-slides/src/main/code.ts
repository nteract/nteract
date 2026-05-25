/// <reference types="@figma/plugin-typings" />

import type {
  InsertTablePayload,
  PluginToUiMessage,
  SiftSourceMetadata,
  UiToPluginMessage,
} from "../shared";

declare const __html__: string;

const PLUGIN_DATA_SOURCE_KEY = "sift-table-source";
const REGULAR_FONT: FontName = { family: "Inter", style: "Regular" };
const MEDIUM_FONT: FontName = { family: "Inter", style: "Medium" };
const SEMIBOLD_FONT: FontName = { family: "Inter", style: "Semi Bold" };

const colors = {
  bg: { r: 0.988, g: 0.992, b: 0.996 },
  panel: { r: 1, g: 1, b: 1 },
  rule: { r: 0.85, g: 0.87, b: 0.9 },
  header: { r: 0.94, g: 0.96, b: 0.98 },
  text: { r: 0.08, g: 0.09, b: 0.11 },
  muted: { r: 0.36, g: 0.4, b: 0.46 },
  accent: { r: 0.07, g: 0.35, b: 0.78 },
};

type StoredSiftSource = {
  title: string;
  source: SiftSourceMetadata;
  totalRows: number;
  filteredRows: number;
  stateLabel: string;
};

figma.showUI(__html__, {
  width: 980,
  height: 760,
  title: "Sift Tables",
  themeColors: true,
});

hydrateSelectedSource();

figma.ui.onmessage = async (message: UiToPluginMessage) => {
  if (message.type === "notify") {
    figma.notify(message.message);
    return;
  }

  if (message.type !== "insert-table") return;

  try {
    const node = await insertTable(message.payload);
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    postToUi({
      type: "insert-result",
      ok: true,
      message: `Inserted ${message.payload.rows.length} rows into the focused slide.`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    figma.notify(errorMessage, { error: true });
    postToUi({ type: "insert-result", ok: false, message: errorMessage });
  }
};

function postToUi(message: PluginToUiMessage) {
  figma.ui.postMessage(message);
}

function hydrateSelectedSource() {
  for (const node of figma.currentPage.selection) {
    const value = node.getPluginData(PLUGIN_DATA_SOURCE_KEY);
    if (!value) continue;
    try {
      const payload = JSON.parse(value) as StoredSiftSource;
      if (payload.source) {
        postToUi({ type: "hydrate-source", source: payload.source });
      }
      return;
    } catch {
      return;
    }
  }
}

async function insertTable(payload: InsertTablePayload): Promise<FrameNode> {
  if (payload.columns.length === 0) {
    throw new Error("No columns available to insert.");
  }
  if (payload.rows.length === 0) {
    throw new Error("No visible rows available to insert.");
  }

  await Promise.all([
    figma.loadFontAsync(REGULAR_FONT),
    figma.loadFontAsync(MEDIUM_FONT),
    figma.loadFontAsync(SEMIBOLD_FONT),
  ]);

  const slide = findTargetSlide();
  if (!slide) {
    throw new Error("Open a Figma Slides deck and focus a slide before inserting a Sift table.");
  }

  const maxColumns = Math.min(payload.columns.length, 10);
  const columns = payload.columns.slice(0, maxColumns);
  const rows = payload.rows.map((row) => row.slice(0, maxColumns));
  const columnWidth = Math.max(112, Math.min(220, Math.floor(1280 / maxColumns)));
  const tableWidth = columnWidth * maxColumns;
  const rowHeight = 38;
  const headerHeight = 42;
  const chromeHeight = 118;
  const footerHeight = 36;
  const width = tableWidth + 56;
  const height = Math.min(
    900,
    chromeHeight + headerHeight + rows.length * rowHeight + footerHeight,
  );

  const frame = figma.createFrame();
  frame.name = payload.title || "Sift table";
  frame.resize(width, height);
  frame.x = 160;
  frame.y = 120;
  frame.fills = [{ type: "SOLID", color: colors.panel }];
  frame.strokes = [{ type: "SOLID", color: colors.rule }];
  frame.strokeWeight = 1;
  frame.cornerRadius = 14;
  frame.clipsContent = true;
  frame.setPluginData(PLUGIN_DATA_SOURCE_KEY, JSON.stringify(sourceMetadataFor(payload)));
  frame.setRelaunchData({ open: "Open in Sift" });

  slide.appendChild(frame);

  const title = createText(payload.title || "Sift table", 24, SEMIBOLD_FONT, colors.text);
  title.x = 28;
  title.y = 24;
  title.resize(width - 56, 30);
  frame.appendChild(title);

  const meta = createText(formatMeta(payload), 13, REGULAR_FONT, colors.muted);
  meta.x = 28;
  meta.y = 58;
  meta.resize(width - 56, 22);
  frame.appendChild(meta);

  const tableX = 28;
  const tableY = 94;
  appendRowBackground(frame, tableX, tableY, tableWidth, headerHeight, colors.header);

  for (let c = 0; c < columns.length; c++) {
    appendVerticalRule(frame, tableX + c * columnWidth, tableY, height - tableY - footerHeight);
    const label = createText(trimCell(columns[c], 26), 12, SEMIBOLD_FONT, colors.text);
    label.x = tableX + c * columnWidth + 12;
    label.y = tableY + 13;
    label.resize(columnWidth - 20, 18);
    frame.appendChild(label);
  }
  appendVerticalRule(frame, tableX + tableWidth, tableY, height - tableY - footerHeight);
  appendHorizontalRule(frame, tableX, tableY + headerHeight, tableWidth);

  rows.forEach((row, r) => {
    const y = tableY + headerHeight + r * rowHeight;
    appendRowBackground(
      frame,
      tableX,
      y,
      tableWidth,
      rowHeight,
      r % 2 === 0 ? colors.panel : colors.bg,
    );
    for (let c = 0; c < columns.length; c++) {
      const cell = createText(trimCell(row[c] ?? "", 34), 11, REGULAR_FONT, colors.text);
      cell.x = tableX + c * columnWidth + 12;
      cell.y = y + 11;
      cell.resize(columnWidth - 20, 18);
      frame.appendChild(cell);
    }
    appendHorizontalRule(frame, tableX, y + rowHeight, tableWidth);
  });

  const footer = createText(
    `${payload.visibleRows.toLocaleString()} visible rows inserted from ${payload.source.label}`,
    12,
    REGULAR_FONT,
    colors.muted,
  );
  footer.x = 28;
  footer.y = height - 28;
  footer.resize(width - 56, 18);
  frame.appendChild(footer);

  return frame;
}

function findTargetSlide(): SlideNode | null {
  const currentPage = figma.currentPage as PageNode & { focusedSlide?: SlideNode | null };
  if (currentPage.focusedSlide?.type === "SLIDE") return currentPage.focusedSlide;

  for (const node of figma.currentPage.selection) {
    const slide = findAncestorSlide(node);
    if (slide) return slide;
  }

  for (const row of figma.getCanvasGrid()) {
    const slide = row.find((node): node is SlideNode => node.type === "SLIDE");
    if (slide) return slide;
  }
  return null;
}

function findAncestorSlide(node: BaseNode): SlideNode | null {
  let current: BaseNode | null = node;
  while (current) {
    if (current.type === "SLIDE") return current as SlideNode;
    current = current.parent;
  }
  return null;
}

function appendRowBackground(
  parent: FrameNode,
  x: number,
  y: number,
  width: number,
  height: number,
  color: RGB,
) {
  const rect = figma.createRectangle();
  rect.name = "row background";
  rect.x = x;
  rect.y = y;
  rect.resize(width, height);
  rect.fills = [{ type: "SOLID", color }];
  parent.appendChild(rect);
}

function appendHorizontalRule(parent: FrameNode, x: number, y: number, width: number) {
  const rule = figma.createRectangle();
  rule.name = "row rule";
  rule.x = x;
  rule.y = y;
  rule.resize(width, 1);
  rule.fills = [{ type: "SOLID", color: colors.rule }];
  parent.appendChild(rule);
}

function appendVerticalRule(parent: FrameNode, x: number, y: number, height: number) {
  const rule = figma.createRectangle();
  rule.name = "column rule";
  rule.x = x;
  rule.y = y;
  rule.resize(1, height);
  rule.fills = [{ type: "SOLID", color: colors.rule }];
  parent.appendChild(rule);
}

function createText(text: string, fontSize: number, fontName: FontName, color: RGB): TextNode {
  const node = figma.createText();
  node.fontName = fontName;
  node.fontSize = fontSize;
  node.characters = text;
  node.fills = [{ type: "SOLID", color }];
  return node;
}

function trimCell(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatMeta(payload: InsertTablePayload): string {
  const filtered =
    payload.filteredRows === payload.totalRows
      ? `${payload.totalRows.toLocaleString()} rows`
      : `${payload.filteredRows.toLocaleString()} of ${payload.totalRows.toLocaleString()} rows`;
  return `${filtered} - ${payload.stateLabel}`;
}

function sourceMetadataFor(payload: InsertTablePayload): StoredSiftSource {
  return {
    title: payload.title,
    source: payload.source,
    totalRows: payload.totalRows,
    filteredRows: payload.filteredRows,
    stateLabel: payload.stateLabel,
  };
}
