import { readSource, checkSources, validateSourceBatch } from "../model/sources-doc.mjs";
import {
  configuredCatalogRevision,
  checkedModules,
  decodeWidgetImports,
  standardImports,
  WIDGET_IMPORTS,
} from "../shared/widget-imports.mjs";
import { imageAssetKey, persistPageAsset } from "./image-assets.mjs";

export async function declareWidgetImports(env, pageId, doc, op) {
  const pin = configuredCatalogRevision(env);
  if (!pin || op.catalog !== "standard") throw Error("The standard widget catalog is unavailable.");
  if (Object.keys(op).some((k) => !["op", "catalog", "modules", "source_revision"].includes(k)))
    throw Error("Unknown widget import declaration field.");
  const modules = checkedModules(op.modules === undefined ? [] : op.modules).map(
    ({ name, source_id, revision }) => {
      const state = readSource(doc, source_id).history.find((s) => s.revision === revision);
      if (state?.media_type !== "text/javascript")
        throw Error("Choose a retained JavaScript source revision for " + name + ".");
      return { name, source_id, revision, asset_id: state.asset_id };
    },
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      catalog: "standard",
      catalog_revision: pin,
      imports: standardImports,
      modules,
    }),
  );
  const operations = [
    {
      op: "set_source",
      source_id: WIDGET_IMPORTS,
      name: "Widget imports · " + pin.slice(0, 8),
      asset_id: pin,
      source_revision: op.source_revision,
    },
  ];
  // Check the source fence and capacity before writing an immutable asset.
  validateSourceBatch(operations);
  checkSources(doc, operations);
  const { asset } = await persistPageAsset(env.PAGES_ASSETS, {
    pageId,
    bytes,
    expect: { content_type: "application/octet-stream" },
  });
  operations[0].asset_id = asset.asset_id;
  return operations;
}

export async function readWidgetImports(env, pageId, doc) {
  let source;
  try {
    source = readSource(doc, WIDGET_IMPORTS);
  } catch (error) {
    if (error.code !== "source_not_found") throw error;
    return {
      catalog: null,
      available_catalog: "standard",
      available_imports: standardImports,
      source_revision: null,
    };
  }
  const ref = { source_revision: source.source_revision, available_imports: standardImports };
  const object = await env.PAGES_ASSETS.get(imageAssetKey(pageId, source.asset_id));
  if (object && object.size <= 16384 && source.media_type === "application/octet-stream") {
    const bytes = await object.arrayBuffer();
    try {
      return { ...ref, ...decodeWidgetImports(bytes, source.asset_id) };
    } catch {}
  }
  return { ...ref, error: "Invalid widget imports declaration." };
}
