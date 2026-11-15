import { imageAssetUrl } from "../shared/image-assets.mjs";
import { PRODUCT_NAME } from "../shared/product.mjs";

/** Only visual nodes, never the editor chrome, comments, or full document. */
export function previewVisuals(root = document) {
  return [
    ...root.querySelectorAll(
      '.rich-editor img, .rich-editor .pages-chart[data-chart-status="rendered"] .pages-chart-canvas, .rich-editor .wordgard-diagram-canvas',
    ),
  ]
    .filter((node) => previewVisualNode({ node })?.getBoundingClientRect().width > 0)
    .map((node, index) => ({
      id: String(index),
      node,
      label:
        node.tagName === "IMG"
          ? node.alt || `Image ${index + 1}`
          : node.closest(".pages-chart")
            ? node.closest(".pages-chart").getAttribute("aria-label") || `Chart ${index + 1}`
            : `Diagram ${index + 1}`,
    }));
}

/** Charts replace their SVG when their data, theme, or width changes. Keep
 * the content container as the selection and resolve its current artwork. */
export function previewVisualNode(choice) {
  const node = choice?.node;
  if (!node?.isConnected) return null;
  if (node.tagName === "IMG") return node;
  return node.querySelector(
    node.matches(".wordgard-diagram-canvas") ? ":scope > svg" : "svg, canvas",
  );
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

/** Fit the entire visual above the caption, preserving axes and edge labels. */
export function previewCoverRect(width, height) {
  const scale = Math.min(1152 / width, 390 / height);
  return {
    x: (1200 - width * scale) / 2,
    y: 24 + (390 - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
}

/** Rasterize once, then show and upload the same bytes. No generated content,
 * remote model call, or live-document update can change the approved image. */
export async function renderPublishedPreview(draft, visuals, signal, pageId) {
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
  context.fillStyle = draft.visual === "text" ? background : "#f7f8f5";
  context.fillRect(0, 0, 1200, 630);
  const textOnly = draft.visual === "text";
  if (!textOnly) {
    let visual;
    if (draft.visual === "upload") {
      let source = draft.file;
      if (!source && draft.cover && pageId) {
        const response = await fetch(imageAssetUrl(pageId, draft.cover.asset_id), {
          signal,
          credentials: "same-origin",
        });
        if (!response.ok) throw Error("Could not load the cover. Try again or replace it.");
        source = await response.blob();
        signal.throwIfAborted();
      }
      if (!source) throw Error("Choose a cover image first.");
      visual = await createImageBitmap(source);
    } else {
      const node = previewVisualNode(visuals.find((item) => item.id === draft.visual));
      if (!node) throw Error("That visual changed. Reopen Link preview to choose it again.");
      const { domToCanvas } = await import("modern-screenshot");
      visual = await domToCanvas(node, { backgroundColor: "#ffffff", scale: 2 });
    }
    try {
      signal.throwIfAborted();
      const { x, y, width, height } = previewCoverRect(visual.width, visual.height);
      context.drawImage(visual, x, y, width, height);
    } finally {
      visual.close?.();
    }
  }
  // A separate caption keeps text readable without tinting or covering data.
  if (!textOnly) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 438, 1200, 192);
  }
  const titleSize = textOnly ? 62 : 42;
  const titleHeight = textOnly ? 76 : 52;
  context.font = `600 ${titleSize}px system-ui, sans-serif`;
  const titleLines = previewTextLines(context, draft.title, 1072, textOnly ? 3 : 2);
  const titleY = textOnly ? 180 : 492;
  context.fillStyle = "#172a2b";
  titleLines.forEach((line, i) => context.fillText(line, 64, titleY + i * titleHeight));
  const captionY = titleY + Math.max(0, titleLines.length - 1) * titleHeight + 48;
  context.fillStyle = "#536466";
  context.font = "28px system-ui, sans-serif";
  const byline = draft.author?.trim() ? `by ${draft.author.trim()}` : "";
  if (byline) {
    previewTextLines(context, byline, 920, 1).forEach((line) =>
      context.fillText(line, 64, captionY),
    );
  }
  // Long descriptions belong in the card's metadata. Text-only cards have
  // room for an excerpt; visual cards keep the artwork and byline prominent.
  if (textOnly || !byline) {
    const descriptionY = captionY + (byline ? 44 : 0);
    const lines = previewTextLines(context, draft.description, 920, textOnly ? 3 : 1);
    lines.forEach((line, i) => context.fillText(line, 64, descriptionY + i * 40));
  }
  context.fillStyle = "#37665c";
  context.font = "500 22px system-ui, sans-serif";
  context.fillText(PRODUCT_NAME, textOnly ? 64 : 1060, textOnly ? 62 : 600);
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
