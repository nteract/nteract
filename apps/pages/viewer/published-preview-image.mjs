import { imageAssetUrl, IMAGE_MAX_BYTES } from "../shared/image-assets.mjs";
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

/** Cover the whole 1200×630 card, centred. The canvas crops the overflow. */
export function previewFillRect(width, height) {
  const scale = Math.max(1200 / width, 630 / height);
  return {
    x: (1200 - width * scale) / 2,
    y: (630 - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
}

/** The card has only this many visual pixels. Keep private sources within
 * that budget, including tall images whose DOM capture would exceed uploads. */
export function previewSourceSize(width, height) {
  const scale = Math.min(1, 1152 / width, 390 / height);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** Capture rounds dimensions down. Leave a little headroom above one pixel
 * for thin visuals; the retained raster is bounded separately afterward. */
export function previewCaptureScale(width, height) {
  return Math.max(1.1 / width, 1.1 / height, Math.min(2, 1152 / width, 390 / height));
}

const pngBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(Error("Could not draw this preview. Choose a different image.")),
      "image/png",
    ),
  );

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
  // Only an uploaded cover may fill the card; every other visual keeps its caption.
  const fill = draft.visual === "upload" && draft.layout === "fill";
  let sourceFile;
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
      const choice = visuals.find((item) => item.id === draft.visual);
      const node = previewVisualNode(choice);
      if (!node) throw Error("That visual changed. Reopen Link preview to choose it again.");
      let captured;
      if (node.tagName === "IMG") {
        // Read image pixels directly: a wide image may display at a fraction
        // of a CSS pixel high, which cannot survive a DOM/SVG capture.
        const response = await fetch(node.currentSrc || node.src, {
          signal,
          credentials: "same-origin",
        });
        if (!response.ok) throw Error("Could not load this image. Choose it again or try another.");
        captured = await createImageBitmap(await response.blob());
      } else {
        const { domToCanvas } = await import("modern-screenshot");
        const bounds = node.getBoundingClientRect();
        const width = Math.max(1, bounds.width);
        const height = Math.max(1, bounds.height);
        captured = await domToCanvas(node, {
          backgroundColor: "#ffffff",
          width,
          height,
          scale: previewCaptureScale(width, height),
        });
      }
      // Normalize the capture's actual dimensions too: DOM layout and capture
      // rounding can differ. Compose and retain this same bounded raster.
      try {
        signal.throwIfAborted();
        visual = document.createElement("canvas");
        const size = previewSourceSize(captured.width, captured.height);
        visual.width = size.width;
        visual.height = size.height;
        visual.getContext("2d").drawImage(captured, 0, 0, size.width, size.height);
      } finally {
        captured.close?.();
      }
      // Preserve the exact uncaptioned raster used below. On approval it is
      // uploaded privately, just like an uploaded cover, for later text edits.
      sourceFile = new File([await pngBlob(visual)], `${choice.label.slice(0, 1000)}.png`, {
        type: "image/png",
      });
      if (sourceFile.size > IMAGE_MAX_BYTES)
        throw Error("Could not fit this visual into a preview. Choose a smaller visual.");
    }
    try {
      signal.throwIfAborted();
      const { x, y, width, height } = (fill ? previewFillRect : previewCoverRect)(
        visual.width,
        visual.height,
      );
      context.drawImage(visual, x, y, width, height);
    } finally {
      visual.close?.();
    }
  }
  // A filled card is the author's finished design. The title and description
  // still reach the page metadata and image alt text.
  if (fill) return finish(canvas, signal, sourceFile);
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
  return finish(canvas, signal, sourceFile);
}

async function finish(canvas, signal, sourceFile) {
  signal.throwIfAborted();
  const blob = await pngBlob(canvas);
  signal.throwIfAborted();
  return { blob, sourceFile };
}
