import createDOMPurify from "dompurify";
import { mount, type MountOptions } from "pele";

const purifier = createDOMPurify(window);
const styleProperties = new Set([
  "color",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "rx",
  "ry",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-anchor",
  "direction",
  "dominant-baseline",
  "alignment-baseline",
  "paint-order",
  "max-width",
  "width",
  "height",
]);
const localReference = /^url\(\s*['"]?#[\w-]+['"]?\s*\)$/i;

// DOMPurify removes active SVG/HTML. Restrict CSS as well: SVG generated from a
// notebook must not load resources or position content over the surrounding app.
purifier.addHook("uponSanitizeAttribute", (_node, attribute) => {
  if (attribute.attrName === "style") {
    const style = document.createElement("span").style;
    style.cssText = attribute.attrValue;
    for (const property of Array.from(style)) {
      const value = style.getPropertyValue(property);
      if (
        (!styleProperties.has(property) && !/^--_[a-z]+$/.test(property)) ||
        /url\s*\(|\\|@/i.test(value)
      )
        style.removeProperty(property);
    }
    attribute.attrValue = style.cssText;
  } else if (
    [
      "fill",
      "stroke",
      "filter",
      "clip-path",
      "mask",
      "marker-start",
      "marker-mid",
      "marker-end",
      "cursor",
    ].includes(attribute.attrName)
  ) {
    if (/\\|url\s*\(/i.test(attribute.attrValue) && !localReference.test(attribute.attrValue)) {
      attribute.keepAttr = false;
    }
  }
});

export function sanitizeMermaidSvg(svg: string): DocumentFragment {
  return purifier.sanitize(svg, {
    USE_PROFILES: { svg: true },
    RETURN_DOM_FRAGMENT: true,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      "style",
      "foreignObject",
      "a",
      "image",
      "use",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
    ],
    FORBID_ATTR: ["href", "xlink:href"],
  });
}

export function mountMermaid(
  element: HTMLElement,
  source: string,
  id: string,
  callbacks: Pick<MountOptions, "onRender" | "onError">,
) {
  return mount(element, source, {
    ...callbacks,
    idPrefix: `nteract-mermaid-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    autoDirection: false,
    links: false,
    images: false,
    limit: 50_000,
    maxEdges: 500,
    outputLimit: 1_000_000,
    sanitize: sanitizeMermaidSvg,
    zoom: "auto",
  });
}
