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

/** Center-crop a cover to fill the social card without stretching it. */
export function previewCoverRect(width, height) {
  const scale = Math.max(1200 / width, 630 / height);
  return {
    x: (1200 - width * scale) / 2,
    y: (630 - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
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
  const textOnly = draft.visual === "text";
  if (!textOnly) {
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
    try {
      signal.throwIfAborted();
      const { x, y, width, height } = previewCoverRect(visual.width, visual.height);
      context.drawImage(visual, x, y, width, height);
    } finally {
      visual.close?.();
    }
    // Keep the image visible above the title while giving white text a
    // predictable dark ground, even on a nearly white cover.
    const shade = context.createLinearGradient(0, 0, 0, 630);
    shade.addColorStop(0, "rgba(0, 0, 0, 0.28)");
    shade.addColorStop(0.35, "rgba(0, 0, 0, 0.30)");
    shade.addColorStop(0.58, "rgba(0, 0, 0, 0.64)");
    shade.addColorStop(1, "rgba(0, 0, 0, 0.86)");
    context.fillStyle = shade;
    context.fillRect(0, 0, 1200, 630);
  }
  context.fillStyle = textOnly ? "#37665c" : "#ffffff";
  context.font = "600 24px system-ui, sans-serif";
  context.fillText(PRODUCT_NAME, 64, 62);
  const titleSize = textOnly ? 62 : 58;
  const titleHeight = textOnly ? 76 : 68;
  const descriptionHeight = textOnly ? 40 : 36;
  context.font = `600 ${titleSize}px system-ui, sans-serif`;
  const titleLines = previewTextLines(context, draft.title, 1072, textOnly ? 3 : 2);
  context.font = `${textOnly ? 30 : 28}px system-ui, sans-serif`;
  const descriptionLines = previewTextLines(context, draft.description, 1072, textOnly ? 3 : 2);
  const titleY = textOnly
    ? 180
    : 566 -
      Math.max(0, titleLines.length - 1) * titleHeight -
      (descriptionLines.length ? 24 + descriptionLines.length * descriptionHeight : 0);
  context.fillStyle = textOnly ? "#172a2b" : "#ffffff";
  context.font = `600 ${titleSize}px system-ui, sans-serif`;
  titleLines.forEach((line, i) => context.fillText(line, 64, titleY + i * titleHeight));
  context.fillStyle = textOnly ? "#536466" : "#ffffff";
  context.font = `${textOnly ? 30 : 28}px system-ui, sans-serif`;
  const descriptionY =
    titleY + Math.max(0, titleLines.length - 1) * titleHeight + 24 + descriptionHeight;
  descriptionLines.forEach((line, i) =>
    context.fillText(line, 64, descriptionY + i * descriptionHeight),
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
