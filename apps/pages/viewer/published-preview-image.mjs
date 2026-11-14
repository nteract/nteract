import { PRODUCT_NAME } from "../shared/product.mjs";

/** Only visual nodes, never the editor chrome, comments, or full document. */
export function previewVisuals(root = document) {
  return [
    ...root.querySelectorAll(
      ".rich-editor img, .rich-editor .pages-chart svg, .rich-editor .pages-chart canvas, .rich-editor .wordgard-diagram-canvas svg",
    ),
  ]
    .filter((node) => node.getBoundingClientRect().width > 0)
    .map((node, index) => ({
      id: String(index),
      node,
      label:
        node.tagName === "IMG"
          ? node.alt || `Image ${index + 1}`
          : node.closest(".pages-chart")
            ? `Chart ${index + 1}`
            : `Diagram ${index + 1}`,
    }));
}

export function previewTextLines(context, text, width, count) {
  const result = [];
  let line = "";
  for (const word of text.trim().split(/\s+/u)) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= width) {
      line = next;
      continue;
    }
    if (line) result.push(line);
    line = "";
    // Break only words too wide to fit on a line, preserving Unicode points.
    for (const character of word) {
      if (line && context.measureText(line + character).width > width) {
        result.push(line);
        line = "";
      }
      line += character;
    }
  }
  if (line) result.push(line);
  if (result.length <= count) return result;
  const visible = result.slice(0, count);
  const last = Array.from(visible[count - 1]);
  while (last.length && context.measureText(last.join("") + "…").width > width) last.pop();
  visible[count - 1] = last.join("").trimEnd() + "…";
  return visible;
}

/** Rasterize once, then show and upload the same bytes. No generated content,
 * remote model call, or live-document update can change the approved image. */
export async function renderPublishedPreview(draft, visuals, signal) {
  await document.fonts?.ready;
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext("2d");
  const background = context.createLinearGradient(0, 630, 1200, 0);
  background.addColorStop(0, "#f7f8f5");
  background.addColorStop(0.6, "#f7f8f5");
  background.addColorStop(1, "#dceae3");
  context.fillStyle = background;
  context.fillRect(0, 0, 1200, 630);
  context.fillStyle = "#37665c";
  context.font = "600 24px system-ui, sans-serif";
  context.fillText(PRODUCT_NAME, 64, 62);
  let titleY = 180;
  if (draft.visual !== "text") {
    let visual;
    if (draft.visual === "upload") {
      if (!draft.file) throw Error("Choose a cover image first.");
      visual = await createImageBitmap(draft.file);
    } else {
      const node = visuals.find((item) => item.id === draft.visual)?.node;
      if (!node?.isConnected)
        throw Error("That visual changed. Reopen Link preview to choose it again.");
      const { domToCanvas } = await import("modern-screenshot");
      visual = await domToCanvas(node, { backgroundColor: "#ffffff", scale: 2 });
    }
    signal.throwIfAborted();
    const scale = Math.min(1072 / visual.width, 300 / visual.height);
    context.drawImage(
      visual,
      (1200 - visual.width * scale) / 2,
      90,
      visual.width * scale,
      visual.height * scale,
    );
    visual.close?.();
    titleY = 448;
  }
  const textOnly = draft.visual === "text";
  context.fillStyle = "#172a2b";
  context.font = `600 ${textOnly ? 62 : 40}px system-ui, sans-serif`;
  const titleLines = previewTextLines(context, draft.title, 1072, textOnly ? 3 : 2);
  titleLines.forEach((line, i) => context.fillText(line, 64, titleY + i * (textOnly ? 76 : 49)));
  context.fillStyle = "#536466";
  context.font = `${textOnly ? 30 : 24}px system-ui, sans-serif`;
  const descriptionY = titleY + titleLines.length * (textOnly ? 76 : 49) + 24;
  previewTextLines(context, draft.description, 1072, textOnly ? 3 : 2).forEach((line, i) =>
    context.fillText(line, 64, descriptionY + i * (textOnly ? 40 : 30)),
  );
  signal.throwIfAborted();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(Error("Could not draw this preview. Choose a different image.")),
      "image/png",
    ),
  );
}
