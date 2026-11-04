// Copy one Project (its Pages' titles, Markdown bodies, dataframes and Page
// tree) from one Pages target to another through the public MCP endpoint and
// the asset routes. Two steps with a reviewable JSON bundle in between:
//
//   export: read the Project on the source and write a bundle.
//   import: create the Project and its Pages on the target from the bundle.
//
// Nothing here runs inside the Worker, and comments, sharing and private image
// bytes are not copied. Dataframe bytes are, when the credential can use the
// asset routes (an API key; a Pages OAuth token can't). See "Copying a Project
// to a new target" in DEPLOYMENT.md for usage and credentials.
import { open, readFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isProjectId } from "../shared/routes.mjs";
import { exportMarkdown, parseMarkdown, unsupportedMarkdown } from "../model/richtext.mjs";
import { DATASET_MAX_BYTES } from "../shared/dataset-assets.mjs";

export const BUNDLE_FORMAT = "nteract-pages-project-bundle";
/** Version 2 adds dataframes and their asset bytes. Import reads 1 and 2. */
export const BUNDLE_VERSION = 2;
const BUNDLE_VERSIONS = new Set([1, 2]);
export const STATE_FORMAT = "nteract-pages-project-import-state";
export const STATE_VERSION = 1;
export const DRIVER = "Pages project transfer";
/** edit_page accepts at most this many operations per request. */
export const EDIT_BATCH = 100;
const READ_BUDGET = 262144;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_ID = new RegExp(`^${UUID}$`);
const ASSET_PATH = new RegExp(`/api/pages/${UUID}/assets/[a-f0-9]{64}`, "g");
const ASSET_ID = /^[a-f0-9]{64}$/;
/** A dataframe's read-back line: `[Dataframe: <title>](<src>)` alone on a
 * line. The title is escaped Markdown; the node's own title comes from the
 * outline. */
const DATAFRAME_LINE = new RegExp(
  `^\\[Dataframe(?:: .*)?\\]\\((/api/pages/${UUID}/assets/([a-f0-9]{64}))\\)$`,
);
/** One asset's path: the only shape the client sends its credential to. */
const ASSET_SRC = new RegExp(`^/api/pages/${UUID}/assets/([a-f0-9]{64})$`);
/** A dataframe's src, when it is a same-origin asset path naming `assetId`. */
const assetSrc = (src, assetId) => typeof src === "string" && ASSET_SRC.exec(src)?.[1] === assetId;
/** Asset paths in dataframe-labelled links: dataframes, read back, whether or
 * not the outline lists them (one in a quote or list isn't top level). */
const DATAFRAME_LINKS = new RegExp(
  `\\[Dataframe(?:: [^\\n]*)?\\]\\((/api/pages/${UUID}/assets/[a-f0-9]{64})\\)`,
  "g",
);
/** The most asset bytes one bundle carries. Base64 grows them by a third, and
 * the bundle is one JSON string, which V8 caps near 512 MiB. */
export const MAX_BUNDLE_ASSET_BYTES = 256 * 1024 * 1024;
/** Whether a block's Markdown holds a dataframe's read-back line anywhere:
 * the server refuses a Markdown rewrite of such a block that drops it. */
const HOLDS_DATAFRAME = new RegExp(
  `\\[Dataframe(?:: [^\\n]*)?\\]\\(/api/pages/${UUID}/assets/[a-f0-9]{64}\\)`,
);
// Tool errors that say "try the same request again later". Anything else with
// a body is a definite answer from the server.
const RETRY_LATER = new Set([
  "request_timeout",
  "lifecycle_unsettled",
  "operation_receipt_capacity",
  "pending_operation_capacity",
]);

export class TransferError extends Error {
  constructor(message, { code, uncertain = false, status } = {}) {
    super(message);
    this.name = "TransferError";
    this.code = code;
    // The HTTP status of an asset request that failed, when there was one.
    this.status = status;
    // An uncertain failure may have been applied; only the identical request
    // (same retry_token, idempotency_key and payload) may be sent again.
    this.uncertain = uncertain;
  }
}

/** An https origin, or http on loopback for local fixtures. */
export function checkOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TransferError(`Not a URL: ${value}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new TransferError(`Use an https origin (http only for loopback): ${value}`);
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new TransferError(`Pass only the origin, without a path or credentials: ${value}`);
  return url.origin;
}

/**
 * A stateless MCP client: one JSON-RPC `tools/call` per request. `call`
 * resolves to the tool's result body and throws TransferError otherwise. The
 * token goes only into the Authorization header; no message includes it.
 */
export function pagesClient({
  origin,
  token,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 60_000,
}) {
  const base = checkOrigin(origin);
  if (typeof token !== "string" || !token.trim())
    throw new TransferError(`No credential for ${base}`);
  let sequence = 0;
  async function call(name, args = {}) {
    const where = `${name} on ${base}`;
    let response;
    try {
      response = await fetchImpl(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": DRIVER,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++sequence,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TransferError(`${where}: no response (${error?.name ?? "error"})`, {
        uncertain: true,
      });
    }
    if (response.status === 401 || response.status === 403)
      throw new TransferError(
        `${where}: the credential was refused (HTTP ${response.status}). Check the token for this target.`,
        { code: "unauthorized" },
      );
    if (response.status !== 200)
      throw new TransferError(`${where}: HTTP ${response.status}`, {
        uncertain: response.status >= 500 || response.status === 429,
      });
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new TransferError(`${where}: unreadable response`, { uncertain: true });
    }
    if (envelope?.error)
      throw new TransferError(`${where}: ${envelope.error.message ?? "JSON-RPC error"}`, {
        code: "jsonrpc_error",
      });
    const result = envelope?.result;
    const text = result?.content?.[0]?.text;
    let body = result?.structuredContent;
    if (body === undefined)
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    if (!result?.isError) {
      if (!body || typeof body !== "object")
        throw new TransferError(`${where}: empty result`, { uncertain: true });
      return body;
    }
    // MCP returns plain text when the gateway itself failed, and "Pages request
    // failed" for a server error; neither proves the request didn't run.
    if (!body || typeof body !== "object")
      throw new TransferError(`${where}: ${String(text ?? "failed").slice(0, 300)}`, {
        uncertain: true,
      });
    const uncertain =
      body.retryable === true ||
      RETRY_LATER.has(body.code) ||
      body.error === "Pages request failed";
    throw new TransferError(`${where}: ${body.code ? `${body.code}: ` : ""}${body.error}`, {
      code: body.code,
      uncertain,
    });
  }
  /** An asset request on this target; refusals of the credential get their
   * own code, since only API keys can use the asset routes. */
  async function assetRequest(path, init, what) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        // Never follow a redirect: it would carry the credential elsewhere.
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "X-Pages-Driver": DRIVER,
          ...init.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TransferError(`${what} on ${base}: no response (${error?.name ?? "error"})`, {
        uncertain: true,
      });
    }
    if (response.ok) return response;
    // The server's reason, without echoing anything else from the response.
    let reason = "";
    try {
      const body = await response.json();
      if (typeof body?.error === "string") reason = `: ${body.error.slice(0, 300)}`;
    } catch {}
    throw new TransferError(`${what} on ${base}: HTTP ${response.status}${reason}`, {
      code: response.status === 401 || response.status === 403 ? "unauthorized" : undefined,
      uncertain: response.status >= 500 || response.status === 429,
      status: response.status,
    });
  }
  /** The bytes at a same-origin asset path. Anything else is refused before
   * the request, so the credential never goes to another origin. */
  async function download(path) {
    if (typeof path !== "string" || !ASSET_SRC.test(path))
      throw new TransferError(`Not an asset path: ${String(path).slice(0, 200)}`);
    const response = await assetRequest(path, { method: "GET", headers: {} }, `GET ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  /** Store `bytes` on Page `pageId`. The asset routes address content by its
   * SHA-256, so storing the same bytes again is a no-op that returns the same
   * asset_id. */
  async function upload(pageId, bytes, mediaType) {
    if (!PAGE_ID.test(pageId)) throw new TransferError(`Not a Page ID: ${pageId}`);
    const response = await assetRequest(
      `/api/pages/${pageId}/assets`,
      { method: "POST", headers: { "Content-Type": mediaType }, body: bytes },
      `Upload to Page ${pageId}`,
    );
    return response.json();
  }
  // The server limits a Pages OAuth token (pages_…) to /mcp, by path, before
  // any Page lookup (worker/auth.mjs authenticate). Only other credentials,
  // such as an Anaconda API key, can use the asset routes.
  const assets = !token.trim().startsWith("pages_");
  /** Whether this target's edit_page takes insert_node, from its tool list.
   * The asset routes shipped with it, so a target without it can't hold a
   * dataframe. */
  async function insertsNodes() {
    let response;
    try {
      response = await fetchImpl(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Pages-Driver": DRIVER,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/list" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new TransferError(`tools/list on ${base}: no response (${error?.name ?? "error"})`, {
        uncertain: true,
      });
    }
    if (!response.ok)
      throw new TransferError(`tools/list on ${base}: HTTP ${response.status}`, {
        uncertain: response.status >= 500 || response.status === 429,
      });
    const tools = (await response.json().catch(() => null))?.result?.tools;
    if (!Array.isArray(tools))
      throw new TransferError(`tools/list on ${base}: unreadable response`);
    const editPage = tools.find((tool) => tool?.name === "edit_page");
    const variants = editPage?.inputSchema?.properties?.operations?.items?.oneOf ?? [];
    return variants.some((variant) => variant?.properties?.op?.const === "insert_node");
  }
  return { origin: base, assets, call, download, upload, insertsNodes };
}

/** The lowercase hex SHA-256 of `bytes`: an asset's id. */
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Retry an uncertain failure with the identical request; anything else throws. */
async function withRetries(work, { attempts = 3, sleep = defaultSleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof TransferError) || !error.uncertain || attempt >= attempts) throw error;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Export

/** Every row of a listing, following next_cursor. Listing is not a snapshot,
 * so rows are deduplicated by page_id. */
export async function listAll(client, args, options) {
  const rows = new Map();
  let cursor;
  do {
    const page = await withRetries(
      () => client.call("list_pages", { ...args, limit: 100, ...(cursor && { cursor }) }),
      options,
    );
    for (const row of page.pages ?? []) rows.set(row.page_id, row);
    cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
  } while (cursor);
  return [...rows.values()];
}

const comparePosition = (a, b) => {
  const left = a.position ?? null,
    right = b.position ?? null;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left < right ? -1 : 1;
  }
  return a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0;
};

/**
 * Rows in tree order: the home Page first, then each root's subtree depth
 * first, siblings by position. A row whose parent isn't in the listing (not
 * expected in a Project) becomes a root and is reported.
 */
export function treeOrder(rows, homePageId) {
  const byId = new Map(rows.map((row) => [row.page_id, row]));
  if (!byId.has(homePageId))
    throw new TransferError(`The Project's home Page ${homePageId} is not in its listing`);
  const children = new Map();
  const roots = [];
  const warnings = [];
  for (const row of rows) {
    const parent = row.parent_id ?? null;
    if (parent !== null && !byId.has(parent)) {
      warnings.push(
        `"${row.title}" (${row.page_id}) has a parent outside the Project; kept at the top level`,
      );
      roots.push(row);
    } else if (parent === null) roots.push(row);
    else children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  roots.sort((a, b) =>
    a.page_id === homePageId ? -1 : b.page_id === homePageId ? 1 : comparePosition(a, b),
  );
  const ordered = [];
  const seen = new Set();
  const visit = (row, parentId) => {
    if (seen.has(row.page_id)) return;
    seen.add(row.page_id);
    ordered.push({ row, parent_source_id: parentId });
    for (const child of (children.get(row.page_id) ?? []).sort(comparePosition))
      visit(child, row.page_id);
  };
  for (const root of roots) visit(root, null);
  const lost = rows.filter((row) => !seen.has(row.page_id));
  if (lost.length)
    throw new TransferError(
      `Parent cycle in the listing: ${lost.map((row) => row.page_id).join(", ")}`,
    );
  return { ordered, warnings };
}

/**
 * Every block's Markdown, the outline's node types and the comment count, all
 * at one revision. An oversized explicit read falls back to the unbounded
 * read_page({page_id}); the outline then comes from include_content:false
 * pages pinned to that read's heads.
 */
export async function readWholePage(client, pageId, options) {
  const call = (args) => withRetries(() => client.call("read_page", args), options);
  for (let attempt = 0; attempt < 3; attempt++) {
    let read, blocks, comments;
    try {
      read = await call({ page_id: pageId, comments: "summary", max_bytes: READ_BUDGET });
      blocks = read.blocks;
      comments = read.comments;
    } catch (error) {
      if (error.code !== "read_budget_exceeded") throw error;
      read = await call({ page_id: pageId });
      blocks = read.blocks;
      comments = read.comments;
      read.outline = { entries: [], next_offset: 0 };
    }
    const entries = [...(read.outline?.entries ?? [])];
    let next = read.outline?.next_offset ?? null;
    try {
      while (next !== null) {
        const more = await call({
          page_id: pageId,
          include_content: false,
          outline_offset: next,
          outline_limit: 100,
          expected_heads: read.heads,
          max_bytes: READ_BUDGET,
        });
        if (!more.outline?.entries?.length)
          throw new TransferError(`read_page on ${pageId}: an outline entry exceeds the budget`);
        entries.push(...more.outline.entries);
        next = more.outline.next_offset ?? null;
      }
    } catch (error) {
      // Someone edited the Page between reads; start again at one revision.
      if (error.code === "read_revision_changed") continue;
      throw error;
    }
    return {
      title: read.title,
      heads: read.heads,
      blocks: (blocks ?? []).map((block) => ({
        markdown: block.markdown ?? "",
        kind: block.kind,
      })),
      types: entries.map((entry) => entry.type),
      // Dataframes on this Page, from the outline's typed fields. One naming
      // another Page's asset reads as readable:false, with no attrs.
      dataframes: entries
        .filter(
          (entry) =>
            entry.type === "dataframe" &&
            ASSET_ID.test(entry.attrs?.asset_id ?? "") &&
            assetSrc(entry.attrs.src, entry.attrs.asset_id),
        )
        .map(({ attrs }) => ({
          asset_id: attrs.asset_id,
          src: attrs.src,
          media_type: attrs.media_type,
          ...(typeof attrs.title === "string" && { title: attrs.title }),
        })),
      comment_threads: Array.isArray(comments) ? comments.length : 0,
    };
  }
  throw new TransferError(`read_page on ${pageId}: the Page kept changing while it was read`);
}

/**
 * Outline types for a node Pages keeps as its Markdown source. Current servers
 * report `pages-opaque`; a source deployed before the node registry reports
 * `raw`. Drop `raw` once no source can be that old.
 */
const PRESERVED_TYPES = new Set(["pages-opaque", "raw"]);

/** A bundle entry for one source Page. */
function bundlePage(row, parentSourceId, read, homePageId) {
  const blocks = read.blocks.length ? read.blocks.map((block) => block.markdown) : [""];
  const markdown = blocks.join("\n\n");
  const dataframes = read.dataframes ?? [];
  const dataframeSources = new Set(dataframes.map((frame) => frame.src));
  // Dataframe lines the outline didn't list (inside a quote or list): they
  // import as links, and are reported with the dataframes not copied.
  const links = [...markdown.matchAll(DATAFRAME_LINKS)].map((match) => match[1]);
  const linked = new Set(links);
  // A src with more dataframe lines than the outline has nodes for it: the
  // extra ones (a copy in a quote, say) import as links, so report them,
  // once per src.
  const listed = (path) => dataframes.filter((frame) => frame.src === path).length;
  const unlisted = [...linked].filter(
    (path) => links.filter((link) => link === path).length > listed(path),
  );
  return {
    source_page_id: row.page_id,
    parent_source_id: parentSourceId,
    position: row.position ?? null,
    home: row.page_id === homePageId,
    title: read.title ?? row.title,
    markdown,
    // Block boundaries matter only when there are several. A source that
    // stores preserved blocks exports each one's source as its own block.
    ...(blocks.length > 1 && { blocks }),
    preserved_markdown:
      read.types.some((type) => PRESERVED_TYPES.has(type)) ||
      read.blocks.some((block) => block.kind && block.kind !== "markdown"),
    private_images: [...new Set(markdown.match(ASSET_PATH) ?? [])].filter(
      (path) => !dataframeSources.has(path) && !linked.has(path),
    ),
    ...(dataframes.length && { dataframes }),
    ...(unlisted.length && { unlisted_dataframes: unlisted }),
    comment_threads: read.comment_threads,
  };
}

/** Each distinct dataframe asset in `pages`, downloaded and checked against
 * its id. A Pages OAuth token can't use the asset routes, so with one
 * `assets` stays empty, a warning says why, and those dataframes stay as
 * links. Any other refusal fails the export. */
async function exportAssets(client, pages, { log, ...options }) {
  const wanted = new Map();
  for (const page of pages)
    for (const frame of page.dataframes ?? [])
      if (!wanted.has(frame.asset_id)) wanted.set(frame.asset_id, frame);
  const assets = {};
  const warnings = [];
  if (wanted.size && !client.assets) {
    warnings.push(
      `A Pages OAuth token can't read assets, so ${wanted.size} dataframe asset(s) were not exported; they import as links. Export with an Anaconda API key to copy them.`,
    );
    return { assets, warnings };
  }
  let total = 0;
  for (const [assetId, frame] of wanted) {
    let bytes;
    try {
      bytes = await withRetries(() => client.download(frame.src), options);
    } catch (error) {
      // The node names an asset its Page no longer stores: nothing to copy,
      // and the dataframe imports as a link, reported with the rest.
      if (error.status !== 404) throw error;
      warnings.push(`${frame.src} is missing on the source; that dataframe imports as a link.`);
      continue;
    }
    total += bytes.length;
    if (total > MAX_BUNDLE_ASSET_BYTES)
      throw new TransferError(
        `The Project's dataframes are larger than one bundle carries (${MAX_BUNDLE_ASSET_BYTES} bytes)`,
      );
    if ((await sha256(bytes)) !== assetId)
      throw new TransferError(`The bytes at ${frame.src} don't match asset ${assetId}`);
    assets[assetId] = {
      media_type: frame.media_type,
      size: bytes.length,
      data: Buffer.from(bytes).toString("base64"),
    };
    log(`downloaded dataframe ${frame.title ?? assetId} (${bytes.length} bytes)`);
  }
  return { assets, warnings };
}

export async function exportProject(
  client,
  { projectId, now = Date.now, uuid = () => crypto.randomUUID(), log = () => {}, ...options },
) {
  if (!isProjectId(projectId)) throw new TransferError(`Not a Project ID: ${projectId}`);
  const project = await withRetries(
    () => client.call("get_project", { project_id: projectId }),
    options,
  );
  const rows = await listAll(client, { project_id: projectId }, options);
  const { ordered, warnings } = treeOrder(rows, project.home_page_id);
  const pages = [];
  for (const [index, { row, parent_source_id }] of ordered.entries()) {
    const read = await readWholePage(client, row.page_id, options);
    pages.push(bundlePage(row, parent_source_id, read, project.home_page_id));
    log(`read ${index + 1}/${ordered.length} ${read.title ?? row.title}`);
  }
  const exported = await exportAssets(client, pages, { log, ...options });
  warnings.push(...exported.warnings);
  const bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    bundle_id: uuid(),
    source: {
      origin: client.origin,
      project_id: projectId,
      home_page_id: project.home_page_id,
    },
    exported_at: new Date(now()).toISOString(),
    project: { title: project.title, description: project.description ?? "" },
    pages,
    assets: exported.assets,
  };
  return { bundle, report: bundleReport(bundle, warnings) };
}

/** What a reviewer needs to know before importing. */
export function bundleReport(bundle, warnings = []) {
  const origin = checkOrigin(bundle.source.origin);
  const known = new Map(bundle.pages.map((page) => [page.source_page_id, page.source_page_id]));
  const unresolved = [];
  for (const page of bundle.pages)
    for (const url of rewriteLinks(page.markdown, {
      sourceOrigin: origin,
      targetOrigin: origin,
      pages: known,
      projects: new Map([[bundle.source.project_id, bundle.source.project_id]]),
    }).unresolved)
      unresolved.push({ title: page.title, source_page_id: page.source_page_id, url });
  return {
    pages: bundle.pages.length,
    preserved_markdown: bundle.pages.filter((page) => page.preserved_markdown).map(pageRef),
    private_images: bundle.pages
      .filter((page) => page.private_images.length)
      .map((page) => ({ ...pageRef(page), assets: page.private_images })),
    ...dataframeReport(bundle),
    comment_threads: bundle.pages.reduce((sum, page) => sum + page.comment_threads, 0),
    unresolved_links: unresolved,
    warnings,
  };
}
const pageRef = (page) => ({ title: page.title, source_page_id: page.source_page_id });
/** Dataframes the bundle carries bytes for, and ones it doesn't (they import
 * as links to the source's asset). */
function dataframeReport(bundle) {
  const held = (frame) => Object.hasOwn(bundle.assets ?? {}, frame.asset_id);
  const missing = (page) => [
    ...new Set([
      ...(page.dataframes ?? []).filter((frame) => !held(frame)).map((frame) => frame.src),
      ...(page.unlisted_dataframes ?? []),
    ]),
  ];
  return {
    dataframes: bundle.pages.reduce(
      (sum, page) => sum + (page.dataframes ?? []).filter(held).length,
      0,
    ),
    dataframes_not_copied: bundle.pages
      .filter((page) => missing(page).length)
      .map((page) => ({ ...pageRef(page), assets: missing(page) })),
  };
}

// ---------------------------------------------------------------------------
// Bundle checks, placement and links

export function validateBundle(bundle) {
  const fail = (message) => {
    throw new TransferError(`Invalid bundle: ${message}`);
  };
  if (bundle?.format !== BUNDLE_FORMAT) fail(`format must be ${BUNDLE_FORMAT}`);
  if (!BUNDLE_VERSIONS.has(bundle.version)) fail(`unsupported version ${bundle.version}`);
  if (bundle.assets !== undefined) {
    if (!bundle.assets || typeof bundle.assets !== "object" || Array.isArray(bundle.assets))
      fail("assets must be an object keyed by asset_id");
    for (const [assetId, asset] of Object.entries(bundle.assets)) {
      if (!ASSET_ID.test(assetId)) fail(`assets: ${assetId} is not an asset_id`);
      if (typeof asset?.media_type !== "string" || typeof asset.data !== "string")
        fail(`assets.${assetId} needs media_type and base64 data`);
    }
  }
  if (typeof bundle.bundle_id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(bundle.bundle_id))
    fail("bundle_id must be 8–64 letters, digits or hyphens");
  checkOrigin(bundle.source?.origin);
  if (!isProjectId(bundle.source.project_id)) fail("source.project_id is not a Project ID");
  if (typeof bundle.project?.title !== "string" || !bundle.project.title.trim())
    fail("project.title is required");
  if (bundle.project.description != null && typeof bundle.project.description !== "string")
    fail("project.description must be a string");
  if (!Array.isArray(bundle.pages) || !bundle.pages.length) fail("pages must be a nonempty array");
  const seen = new Set();
  const homes = bundle.pages.filter((page) => page.home === true);
  if (homes.length !== 1) fail("exactly one Page must have home: true");
  if (homes[0].parent_source_id !== null) fail("the home Page must have parent_source_id null");
  for (const [index, page] of bundle.pages.entries()) {
    const at = `pages[${index}]`;
    if (typeof page.source_page_id !== "string" || !PAGE_ID.test(page.source_page_id))
      fail(`${at}.source_page_id is not a Page ID`);
    if (seen.has(page.source_page_id)) fail(`${at} repeats ${page.source_page_id}`);
    if (page.parent_source_id !== null && !seen.has(page.parent_source_id))
      fail(`${at}.parent_source_id must name an earlier Page (parents come before children)`);
    if (typeof page.title !== "string") fail(`${at}.title must be a string`);
    if (typeof page.markdown !== "string") fail(`${at}.markdown must be a string`);
    if (
      page.unlisted_dataframes !== undefined &&
      (!Array.isArray(page.unlisted_dataframes) ||
        page.unlisted_dataframes.some((path) => typeof path !== "string" || !ASSET_SRC.test(path)))
    )
      fail(`${at}.unlisted_dataframes must be asset paths`);
    if (page.dataframes !== undefined) {
      if (!Array.isArray(page.dataframes)) fail(`${at}.dataframes must be an array`);
      for (const frame of page.dataframes)
        if (
          !ASSET_ID.test(frame?.asset_id ?? "") ||
          !assetSrc(frame.src, frame.asset_id) ||
          typeof frame.media_type !== "string" ||
          (frame.title !== undefined && typeof frame.title !== "string")
        )
          fail(
            `${at}.dataframes entries need asset_id, a src naming it (/api/pages/<id>/assets/<asset_id>), media_type and an optional title`,
          );
        else if (
          Object.hasOwn(bundle.assets ?? {}, frame.asset_id) &&
          bundle.assets[frame.asset_id].media_type !== frame.media_type
        )
          fail(`${at}: dataframe ${frame.asset_id} and its asset disagree on media_type`);
    }
    if (page.blocks !== undefined) {
      if (
        !Array.isArray(page.blocks) ||
        !page.blocks.length ||
        page.blocks.some((block) => typeof block !== "string")
      )
        fail(`${at}.blocks must be a nonempty array of strings`);
      if (page.blocks.join("\n\n") !== page.markdown)
        fail(
          `${at}: markdown and blocks disagree. Edit both, or delete blocks to import markdown as one block`,
        );
    }
    seen.add(page.source_page_id);
  }
  return bundle;
}

// A Page10 target refuses Markdown it can't represent (math and HTML) with
// unsupported_markdown. Such a block is written as the literal text it reads
// as, which is how the target itself converts a preserved block.
const importable = (markdown) =>
  unsupportedMarkdown(markdown) ? exportMarkdown(parseMarkdown(markdown)) : markdown;
const pageBlocks = (page) => (page.blocks ?? [page.markdown]).map(importable);

/**
 * A Page body as the units the target writes: `{ markdown }` for a stretch of
 * Markdown and `{ dataframe }` for a dataframe the bundle has bytes for. A
 * dataframe's read-back line becomes a unit only on a line of its own,
 * between blank lines and outside a code fence; anywhere else (in a quote or
 * list, say) it stays Markdown, and so a link.
 *
 * Each dataframe unit becomes its own block on the target, so a dataframe
 * that sat inside a block splits it there.
 */
export function bodyUnits(blocks, page, assets = {}) {
  // Frames by src, in outline order. Two dataframes can show one asset under
  // different titles; each standalone line takes the next one.
  const frames = new Map();
  for (const frame of page.dataframes ?? [])
    if (Object.hasOwn(assets, frame.asset_id))
      frames.set(frame.src, [...(frames.get(frame.src) ?? []), frame]);
  const taken = new Map();
  const next = (src) => {
    const queue = frames.get(src);
    if (!queue) return undefined;
    const index = taken.get(src) ?? 0;
    taken.set(src, index + 1);
    // More lines than the outline listed: reuse the last one's attrs.
    return queue[Math.min(index, queue.length - 1)];
  };
  const units = [];
  for (const markdown of blocks) {
    const lines = markdown.split("\n");
    let chunk = [];
    let fence = null;
    const flush = () => {
      const text = chunk.join("\n").replace(/^\n+|\n+$/g, "");
      if (text) units.push({ markdown: text });
      chunk = [];
    };
    for (const [index, line] of lines.entries()) {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length)))
        fence = fence === null ? marker : null;
      const src = fence === null ? DATAFRAME_LINE.exec(line)?.[1] : undefined;
      const alone = !lines[index - 1]?.trim() && !lines[index + 1]?.trim();
      const frame = src && alone ? next(src) : undefined;
      if (frame) {
        flush();
        units.push({ dataframe: frame });
      } else chunk.push(line);
    }
    flush();
  }
  return units.length ? units : [{ markdown: "" }];
}

/** The edit_page operations that make a Page with `blocks` hold `units`, in
 * order. The first existing block with no dataframe takes the first Markdown
 * unit; units before it are put first; every other block is deleted; the
 * rest append. A block holding a dataframe is never rewritten (the server
 * refuses to drop one), so a rerun over a body an earlier run wrote,
 * dataframes first, converges instead of being refused. */
export function bodyOperations(blocks, units) {
  const write = (unit, after) =>
    unit.dataframe
      ? {
          op: "insert_node",
          node: {
            type: "dataframe",
            attrs: {
              asset_id: unit.dataframe.asset_id,
              media_type: unit.dataframe.media_type,
              ...(unit.dataframe.title !== undefined && { title: unit.dataframe.title }),
            },
          },
          ...(after !== undefined && { after_block_id: after }),
        }
      : {
          op: "insert_markdown",
          markdown: unit.markdown,
          ...(after !== undefined && { after_block_id: after }),
        };
  const first = units.findIndex((unit) => unit.markdown !== undefined);
  const target = blocks.find((block) => !HOLDS_DATAFRAME.test(block.markdown ?? ""));
  const operations = [];
  if (first === -1 || !target) {
    for (const unit of units) operations.push(write(unit));
    for (const block of blocks) operations.push({ op: "delete_block", block_id: block.id });
    return operations;
  }
  // Each goes first, so the leading units go in reverse.
  for (const unit of units.slice(0, first).reverse()) operations.push(write(unit, null));
  operations.push({
    op: "replace_block_markdown",
    block_id: target.id,
    markdown: units[first].markdown,
  });
  for (const block of blocks)
    if (block !== target) operations.push({ op: "delete_block", block_id: block.id });
  for (const unit of units.slice(first + 1)) operations.push(write(unit));
  return operations;
}

/**
 * Where a source Page goes on the target. On Page10 a Project is its home Page
 * (a root Page carrying the Project), and project_id alone means "under the
 * home Page". So the source home becomes the target home, filled in rather
 * than created, and every Page that sat at the source Project's top level is
 * created under it by parent_id. This is the one place that knows; change it
 * here when location semantics change.
 */
export function targetPlacement(page, { homeSourceId, targetHomeId, pageIds }) {
  if (page.source_page_id === homeSourceId) return { home: true };
  if (page.parent_source_id === null || page.parent_source_id === homeSourceId)
    return { parent_id: targetHomeId };
  const parent = pageIds.get(page.parent_source_id);
  if (!parent)
    throw new TransferError(
      `"${page.title}" needs its parent ${page.parent_source_id} created first`,
    );
  return { parent_id: parent };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Where a link token can start. Each token is consumed whole before scanning
// resumes, so a URL nested inside another is never matched on its own: a
// Markdown link destination `](...)`, an autolink `<...>`, or a bare URL that
// starts a line or follows whitespace, ( [ or a quote.
const TOKEN_START = /\]\(|<(?=https?:\/\/)|(?<=^|[\s(["'])https?:\/\//gm;
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y;
const BARE_URL = /https?:\/\/[^\s<>\]"']+/y;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/**
 * The link destination starting at `start` (just after `](`), read the
 * CommonMark way: `<...>` on one line, or a run without spaces or control
 * characters in which parentheses balance and a backslash escapes ASCII
 * punctuation. `end` is where the destination stops. `url` is null when the
 * span isn't a valid destination (unbalanced parentheses, an unclosed `<`);
 * the span is still consumed so nothing inside it is matched on its own.
 */
export function readDestination(text, start) {
  if (text[start] === "<") {
    for (let i = start + 1; i < text.length; i++) {
      const char = text[i];
      if (char === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) i++;
      else if (char === ">") return { url: text.slice(start + 1, i), angle: true, end: i + 1 };
      else if (char === "<" || char === "\n") return { url: null, end: i };
    }
    return { url: null, end: text.length };
  }
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) i++;
    else if (char <= " " || char === "\x7f") break;
    else if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  return { url: depth === 0 && i > start ? text.slice(start, i) : null, angle: false, end: i };
}
const TRAILING = new Set([".", ",", ";", ":", "!", "?"]);
const count = (text, char) => text.split(char).length - 1;

/** A bare URL without the sentence punctuation or unbalanced `)` after it. */
function splitTrailing(token) {
  let end = token.length;
  for (;;) {
    const last = token[end - 1];
    if (TRAILING.has(last)) end--;
    else if (last === ")" && count(token.slice(0, end), "(") < count(token.slice(0, end), ")"))
      end--;
    else break;
  }
  return [token.slice(0, end), token.slice(end)];
}

/**
 * Point source links at the target. A link is rewritten only when the whole
 * token is a source URL: `/p/<id>`, `/?page=<id>`, `/project/<id>` or
 * `/s/<id>` on the source origin, followed by nothing or by a path, query or
 * fragment, which is kept. The legacy `?page=` form keeps its other query
 * parameters. A root-relative `/p/<id>` is a link only as a Markdown link
 * destination. Links to Pages or Projects outside the maps are left alone and
 * returned in `unresolved`. `sourceOrigin` must be normalized by checkOrigin.
 */
export function rewriteLinks(
  markdown,
  { sourceOrigin, targetOrigin, pages, projects = new Map() },
) {
  const origin = escapeRegExp(sourceOrigin);
  const absolute = new RegExp(
    `^${origin}(?:/p/(${UUID})([/?#].*)?|/\\?page=(${UUID})(&[^#]*)?(#.*)?|/(?:project|s)/((?:prj|sp)_${UUID})([/?#].*)?)$`,
    "s",
  );
  const relative = new RegExp(`^/p/(${UUID})([/?#].*)?$`, "s");
  const unresolved = [];
  let rewritten = 0;
  // The rewritten URL, or null to leave the token as it is.
  const rewriteUrl = (url, allowRelative) => {
    const near = allowRelative ? relative.exec(url) : null;
    if (near) {
      const target = pages.get(near[1]);
      if (!target) return (unresolved.push(url), null);
      rewritten++;
      return `/p/${target}${near[2] ?? ""}`;
    }
    const match = absolute.exec(url);
    if (!match) return null;
    const [, page, pageRest, legacy, legacyQuery, legacyFragment, project, projectRest] = match;
    const id = page ?? legacy;
    const target = id ? pages.get(id) : projects.get(project);
    if (!target) return (unresolved.push(url), null);
    rewritten++;
    if (page) return `${targetOrigin}/p/${target}${pageRest ?? ""}`;
    if (legacy)
      return `${targetOrigin}/p/${target}${legacyQuery ? `?${legacyQuery.slice(1)}` : ""}${legacyFragment ?? ""}`;
    return `${targetOrigin}/project/${target}${projectRest ?? ""}`;
  };
  let result = "";
  let copied = 0;
  const starts = new RegExp(TOKEN_START.source, TOKEN_START.flags);
  for (let found = starts.exec(markdown); found; found = starts.exec(markdown)) {
    const at = found.index;
    let end, replacement;
    if (found[0] === "](") {
      const destination = readDestination(markdown, at + 2);
      end = destination.end;
      const next = destination.url === null ? null : rewriteUrl(destination.url, true);
      if (next !== null) replacement = `](${destination.angle ? `<${next}>` : next}`;
    } else if (found[0] === "<") {
      AUTOLINK.lastIndex = at;
      const autolink = AUTOLINK.exec(markdown);
      if (!autolink) {
        starts.lastIndex = at + 1;
        continue;
      }
      end = AUTOLINK.lastIndex;
      const next = rewriteUrl(autolink[1], false);
      if (next !== null) replacement = `<${next}>`;
    } else {
      BARE_URL.lastIndex = at;
      const [token] = BARE_URL.exec(markdown);
      end = BARE_URL.lastIndex;
      const [url, tail] = splitTrailing(token);
      const next = rewriteUrl(url, false);
      if (next !== null) replacement = `${next}${tail}`;
    }
    if (replacement !== undefined) {
      result += markdown.slice(copied, at) + replacement;
      copied = end;
    }
    starts.lastIndex = Math.max(end, at + 1);
  }
  result += markdown.slice(copied);
  return { markdown: result, rewritten, unresolved };
}

// ---------------------------------------------------------------------------
// Import

/** A stable idempotency-key nonce for one step of one bundle. */
async function nonce(bundleId, ...parts) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([bundleId, ...parts].join("\n")),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

export function freshState(bundle, targetOrigin) {
  return {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    bundle_id: bundle.bundle_id,
    target_origin: targetOrigin,
    catalog: null,
    project: null,
    pages: {},
    bodies: {},
    pending: null,
    reconciliation_required: null,
  };
}

/** An in-memory state store; the CLI uses a file. */
export function memoryStore(initial = null) {
  let value = initial && structuredClone(initial);
  return {
    load: async () => value && structuredClone(value),
    save: async (state) => {
      value = structuredClone(state);
    },
    peek: () => value,
  };
}

/** The plan without network calls: where each Page lands and what's flagged. */
export function planImport(bundle) {
  validateBundle(bundle);
  const home = bundle.pages.find((page) => page.home);
  const titles = new Map(bundle.pages.map((page) => [page.source_page_id, page.title]));
  const symbolic = new Map(bundle.pages.map((page) => [page.source_page_id, page.source_page_id]));
  return bundle.pages.map((page) => {
    const placement = targetPlacement(page, {
      homeSourceId: home.source_page_id,
      targetHomeId: home.source_page_id,
      pageIds: symbolic,
    });
    return {
      title: page.title,
      source_page_id: page.source_page_id,
      action: placement.home ? "fill the target Project's home Page" : "create",
      under: placement.home ? null : titles.get(placement.parent_id),
    };
  });
}

/** How far the target's created_at may trail a create's local requested_at
 * and still count as made by it: room for clock skew between this machine and
 * the target, nothing more. */
export const ADOPT_CLOCK_SKEW_MS = 2 * 60_000;

function reconciliationMessage(record) {
  return (
    `The retry window for ${record.operation} "${record.args.title}" (${record.step}, key ` +
    `${record.idempotency_key}, first sent ${record.requested_at}) expired before its outcome ` +
    "was known, so it may have been applied. No more writes until it is resolved. Rerun with " +
    "--reconcile to list candidates on the target, then --adopt ID to record the one it made, " +
    "or --accept-missing to create it again."
  );
}

/** Projects with `title` on the target. */
async function projectsTitled(client, title, options) {
  const entries = [];
  let cursor;
  do {
    const listed = await withRetries(
      () => client.call("list_projects", { limit: 100, ...(cursor && { cursor }) }),
      options,
    );
    entries.push(...(listed.projects ?? []).filter((entry) => entry.title === title));
    cursor = typeof listed.next_cursor === "string" ? listed.next_cursor : undefined;
  } while (cursor);
  const projects = [];
  for (const entry of entries)
    projects.push(
      await withRetries(
        () => client.call("get_project", { project_id: entry.project_id }),
        options,
      ),
    );
  return projects;
}

const createdAfter = (createdAt, record) =>
  Date.parse(createdAt) >= Date.parse(record.requested_at) - ADOPT_CLOCK_SKEW_MS;

/**
 * What an expired create might have made: Pages with its title under its
 * parent that no other bundle Page maps to, or Projects with its title. A
 * candidate is only a lead. Uniqueness isn't provenance: a same-title Page may
 * be unrelated, so nothing is adopted without an explicit --adopt.
 */
export async function reconciliationCandidates(client, state, record, options) {
  const oldestFirst = (candidates) =>
    candidates.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return oldestFirst(await candidatesFor(client, state, record, options));
}
async function candidatesFor(client, state, record, options) {
  const { title } = record.args;
  if (record.step === "project")
    return (await projectsTitled(client, title, options)).map((project) => ({
      project_id: project.project_id,
      title: project.title,
      created_at: project.created_at ?? null,
      created_after_request: project.created_at ? createdAfter(project.created_at, record) : false,
      url: `${client.origin}/project/${project.project_id}`,
    }));
  const mapped = new Set(Object.values(state.pages));
  const rows = await listAll(client, { parent_id: record.args.parent_id }, options);
  return rows
    .filter(
      (row) =>
        row.title === title &&
        (row.parent_id ?? null) === record.args.parent_id &&
        !mapped.has(row.page_id),
    )
    .map((row) => ({
      page_id: row.page_id,
      title: row.title,
      created_at: row.created_at ?? null,
      created_after_request: row.created_at ? createdAfter(row.created_at, record) : false,
      url: `${client.origin}/p/${row.page_id}`,
    }));
}

/**
 * Check that `id` is what the expired create made before recording it: under
 * the recorded parent (Pages), with the recorded title, not already mapped,
 * and created no earlier than the create was first sent.
 */
export async function adoptCreate(client, state, record, id, options) {
  const refuse = (reason) => {
    throw new TransferError(`Refusing to adopt ${id}: ${reason}`, { code: "adopt_refused" });
  };
  if (!record.requested_at) refuse("the record has no requested_at to check it against");
  const { title } = record.args;
  if (record.step === "project") {
    if (!isProjectId(id)) refuse("the expired create was a Project; pass a Project ID");
    const project = await withRetries(
      () => client.call("get_project", { project_id: id }),
      options,
    );
    if (project.title !== title) refuse(`its title is "${project.title}", not "${title}"`);
    if (!project.created_at || !createdAfter(project.created_at, record))
      refuse(
        `it was created at ${project.created_at}, before the create was sent at ${record.requested_at}`,
      );
    return { project_id: project.project_id, home_page_id: project.home_page_id };
  }
  if (!PAGE_ID.test(id)) refuse("the expired create was a Page; pass a Page ID");
  if (Object.values(state.pages).includes(id)) refuse("another bundle Page already maps to it");
  const rows = await listAll(client, { parent_id: record.args.parent_id }, options);
  const row = rows.find((entry) => entry.page_id === id);
  if (!row || (row.parent_id ?? null) !== record.args.parent_id)
    refuse(`it is not under the recorded parent ${record.args.parent_id}`);
  if (row.title !== title) refuse(`its title is "${row.title}", not "${title}"`);
  if (!row.created_at || !createdAfter(row.created_at, record))
    refuse(
      `it was created at ${row.created_at}, before the create was sent at ${record.requested_at}`,
    );
  return { page_id: id };
}

export async function importBundle(
  client,
  bundle,
  {
    store,
    now = Date.now,
    log = () => {},
    allowExistingTitle = false,
    reconcile = false,
    adopt = null,
    acceptMissing = false,
    ...options
  },
) {
  if ([reconcile, adopt !== null, acceptMissing].filter(Boolean).length > 1)
    throw new TransferError("Choose one of --reconcile, --adopt or --accept-missing");
  validateBundle(bundle);
  // Compare normalized origins: case, a trailing slash or an explicit default
  // port must not let a bundle write back into its own source.
  const sourceOrigin = checkOrigin(bundle.source.origin);
  if (checkOrigin(client.origin) === sourceOrigin)
    throw new TransferError("The target is the bundle's source; import into a different target");
  const home = bundle.pages.find((page) => page.home);
  let state = (await store.load()) ?? freshState(bundle, client.origin);
  if (state.format !== STATE_FORMAT || state.version !== STATE_VERSION)
    throw new TransferError("The state file is not an import state");
  if (state.bundle_id !== bundle.bundle_id)
    throw new TransferError("The state file belongs to a different bundle");
  if (state.target_origin !== client.origin)
    throw new TransferError(`The state file belongs to ${state.target_origin}`);
  const save = () => store.save(state);
  const counts = { created: 0, edits: 0, links_rewritten: 0, dataframes: 0 };
  const assets = bundle.assets ?? {};
  // Each asset's bytes, checked against its id once, before any write.
  const bytes = new Map();
  for (const [assetId, asset] of Object.entries(assets)) {
    const decoded = new Uint8Array(Buffer.from(asset.data, "base64"));
    if (decoded.length > DATASET_MAX_BYTES)
      throw new TransferError(`Asset ${assetId} is larger than the asset routes accept`);
    if ((await sha256(decoded)) !== assetId)
      throw new TransferError(`Invalid bundle: the data for asset ${assetId} doesn't match its id`);
    bytes.set(assetId, decoded);
  }
  if (bytes.size && !client.assets)
    throw new TransferError(
      "This bundle carries dataframe bytes, and a Pages OAuth token can't store assets. Import with an Anaconda API key, or delete the bundle's assets to import those dataframes as links.",
      { code: "assets_unauthorized" },
    );
  // An older target has no insert_node (or asset routes): find out before the
  // first write, not after the Project and its Pages exist.
  if (bytes.size && !(await withRetries(() => client.insertsNodes(), options)))
    throw new TransferError(
      `${client.origin} doesn't take dataframes (its edit_page has no insert_node). Import into a current target, or delete the bundle's assets to import those dataframes as links.`,
      { code: "dataframes_unsupported" },
    );
  const warnings = [];

  // One request at a time. Its exact arguments are saved before sending, so a
  // rerun after an uncertain failure replays the same token, key and payload.
  // requested_at is when the request was first sent; a replay keeps it.
  const send = async (
    step,
    operation,
    args,
    commit,
    requestedAt = new Date(now()).toISOString(),
  ) => {
    state.pending = { step, operation, args, requested_at: requestedAt };
    await save();
    let result;
    try {
      result = await withRetries(() => client.call(operation, args), options);
    } catch (error) {
      // The window of an uncertain create closed: the create may have been
      // applied, and nothing can replay it now. Record it and refuse further
      // writes until --reconcile finds it or --accept-missing sends it again.
      // A body edit needs no record: the next run rereads the Page and writes
      // the whole body again, which converges whether or not it applied.
      if (error.code === "retry_expired" && (step === "project" || step.startsWith("page:"))) {
        state.pending = null;
        state.reconciliation_required = {
          step,
          operation,
          idempotency_key: args.idempotency_key,
          args,
          requested_at: requestedAt,
          recorded_at: new Date(now()).toISOString(),
        };
        await save();
        throw new TransferError(reconciliationMessage(state.reconciliation_required), {
          code: "reconciliation_required",
        });
      }
      if (!error.uncertain) {
        state.pending = null;
        await save();
      }
      throw error;
    }
    commit(result);
    state.pending = null;
    await save();
    return result;
  };
  const commitFor = (step) => (result) => {
    if (step === "project") {
      state.project = { project_id: result.project_id, home_page_id: result.home_page_id };
      state.pages[home.source_page_id] = result.home_page_id;
    } else if (step.startsWith("page:")) {
      state.pages[step.slice(5)] = result.page_id;
      counts.created++;
    } else if (step.startsWith("body:")) {
      counts.edits++;
      for (const warning of result.warnings ?? [])
        warnings.push(`${step.slice(5)}: ${warning.code ?? "warning"}`);
    }
  };

  if (state.reconciliation_required) {
    const record = state.reconciliation_required;
    if (acceptMissing) {
      log(`--accept-missing: sending ${record.operation} for ${record.step} again`);
      state.reconciliation_required = null;
      await save();
    } else if (reconcile) {
      // Listing only: the operator picks, or rejects, a candidate.
      return {
        reconciliation: {
          record: { ...record, args: { ...record.args, retry_token: undefined } },
          candidates: await reconciliationCandidates(client, state, record, options),
        },
      };
    } else if (adopt !== null) {
      const found = await adoptCreate(client, state, record, adopt, options);
      if (record.step === "project") {
        state.project = found;
        state.pages[home.source_page_id] = found.home_page_id;
      } else state.pages[record.step.slice(5)] = found.page_id;
      log(`adopted ${adopt} for ${record.step}`);
      state.reconciliation_required = null;
      await save();
    } else
      throw new TransferError(reconciliationMessage(record), { code: "reconciliation_required" });
  } else if (reconcile || adopt !== null)
    throw new TransferError("Nothing to reconcile: the state file has no expired create");

  if (state.pending) {
    const { step, operation, args, requested_at } = state.pending;
    log(`resuming ${operation} for ${step}`);
    try {
      await send(step, operation, args, commitFor(step), requested_at);
    } catch (error) {
      // An expired body edit: the body pass below rereads the Page and writes
      // the whole body again, which converges whether or not it applied.
      if (!(error.code === "retry_expired" && step.startsWith("body:"))) throw error;
      log(`the retry window for ${step} expired; rewriting that body from a fresh read`);
    }
  }

  // Catalog retry authority for creates. Keys are its prefix plus a nonce from
  // (bundle_id, source_page_id). A new window is safe once nothing is pending.
  const unmapped = bundle.pages.some((page) => !state.pages[page.source_page_id]);
  if (unmapped && (!state.catalog || Date.parse(state.catalog.retry_until) - 60_000 <= now())) {
    const authority = await withRetries(() => client.call("list_pages", { limit: 1 }), options);
    state.catalog = {
      retry_token: authority.retry_token,
      retry_key_prefix: authority.retry_key_prefix,
      retry_until: authority.retry_until,
    };
    await save();
  }

  if (!state.project) {
    if (!allowExistingTitle) {
      const existing = [];
      let cursor;
      do {
        const listed = await withRetries(
          () => client.call("list_projects", { limit: 100, ...(cursor && { cursor }) }),
          options,
        );
        existing.push(...(listed.projects ?? []));
        cursor = typeof listed.next_cursor === "string" ? listed.next_cursor : undefined;
      } while (cursor);
      const clash = existing.find((entry) => entry.title === bundle.project.title);
      if (clash)
        throw new TransferError(
          `The target already has a Project titled "${bundle.project.title}" (${clash.project_id}). ` +
            "If it came from an earlier import whose state file is lost, delete it or pass --allow-existing-title.",
        );
    }
    const args = {
      title: bundle.project.title,
      ...(bundle.project.description && { description: bundle.project.description }),
      idempotency_key: state.catalog.retry_key_prefix + (await nonce(bundle.bundle_id, "project")),
      retry_token: state.catalog.retry_token,
    };
    await send("project", "create_project", args, commitFor("project"));
    log(`created Project ${state.project.project_id}`);
  }

  const pageIds = () => new Map(Object.entries(state.pages));
  for (const page of bundle.pages) {
    if (state.pages[page.source_page_id]) continue;
    const placement = targetPlacement(page, {
      homeSourceId: home.source_page_id,
      targetHomeId: state.project.home_page_id,
      pageIds: pageIds(),
    });
    const args = {
      title: page.title,
      markdown: pageBlocks(page)[0],
      parent_id: placement.parent_id,
      idempotency_key:
        state.catalog.retry_key_prefix +
        (await nonce(bundle.bundle_id, "page", page.source_page_id)),
      retry_token: state.catalog.retry_token,
    };
    const step = `page:${page.source_page_id}`;
    await send(step, "create_page", args, commitFor(step));
    log(`created ${Object.keys(state.pages).length}/${bundle.pages.length} ${page.title}`);
  }

  // Second pass, after every Page exists: bodies that need more than the first
  // block, link rewrites, and the home Page.
  const ids = pageIds();
  const projects = new Map([[bundle.source.project_id, state.project.project_id]]);
  const unresolved = [];
  for (const page of bundle.pages) {
    const blocks = pageBlocks(page);
    const rewrites = blocks.map((markdown) =>
      rewriteLinks(markdown, {
        sourceOrigin,
        targetOrigin: client.origin,
        pages: ids,
        projects,
      }),
    );
    for (const { unresolved: urls } of rewrites)
      for (const url of urls)
        unresolved.push({ title: page.title, source_page_id: page.source_page_id, url });
    if (state.bodies[page.source_page_id] === "done") continue;
    const units = bodyUnits(
      rewrites.map((rewrite) => rewrite.markdown),
      page,
      assets,
    );
    const frames = units.filter((unit) => unit.dataframe);
    const rewritten = rewrites.reduce((sum, rewrite) => sum + rewrite.rewritten, 0);
    if (!page.home && blocks.length === 1 && rewritten === 0 && !frames.length) {
      state.bodies[page.source_page_id] = "done";
      await save();
      continue;
    }
    const targetId = state.pages[page.source_page_id];
    // Store each dataframe's bytes on the target Page before the body names
    // them. A rerun stores them again, which changes nothing.
    for (const assetId of new Set(frames.map((unit) => unit.dataframe.asset_id))) {
      const stored = await withRetries(
        () => client.upload(targetId, bytes.get(assetId), assets[assetId].media_type),
        options,
      );
      if (stored.asset_id !== assetId)
        throw new TransferError(`The target stored asset ${assetId} as ${stored.asset_id}`);
    }
    await writeBody(page, targetId, units);
    counts.dataframes += frames.length;
    counts.links_rewritten += rewritten;
    state.bodies[page.source_page_id] = "done";
    await save();
    log(`wrote ${page.home ? "home Page" : "body"} ${page.title}`);
  }

  async function readForEdit(pageId) {
    const call = (args) => withRetries(() => client.call("read_page", args), options);
    try {
      return await call({ page_id: pageId, comments: "none", max_bytes: READ_BUDGET });
    } catch (error) {
      if (error.code !== "read_budget_exceeded") throw error;
      return call({ page_id: pageId });
    }
  }

  // Make the target Page hold exactly `units` (bodyOperations). Batches past
  // EDIT_BATCH read again for fresh heads; deletes come before appends, so
  // order holds.
  async function writeBody(page, pageId, units) {
    let read = await readForEdit(pageId);
    const operations = [];
    if (page.home && read.title !== page.title)
      operations.push({ op: "set_title", title: page.title });
    operations.push(...bodyOperations(read.blocks ?? [], units));
    for (let batch = 0; batch * EDIT_BATCH < operations.length; batch++) {
      if (batch > 0) read = await readForEdit(pageId);
      const args = {
        page_id: pageId,
        base_heads: read.heads,
        idempotency_key:
          read.retry_key_prefix +
          (await nonce(bundle.bundle_id, "body", page.source_page_id, String(batch))),
        retry_token: read.retry_token,
        operations: operations.slice(batch * EDIT_BATCH, (batch + 1) * EDIT_BATCH),
      };
      const step = `body:${page.source_page_id}`;
      await send(step, "edit_page", args, commitFor(step));
    }
  }

  const verification = await verifyImport(client, bundle, state, options);
  return {
    project_id: state.project.project_id,
    home_page_id: state.project.home_page_id,
    url: `${client.origin}/project/${state.project.project_id}`,
    home_page_url: `${client.origin}/p/${state.project.home_page_id}`,
    pages: bundle.pages.length,
    ...counts,
    unresolved_links: unresolved,
    preserved_markdown: bundle.pages.filter((page) => page.preserved_markdown).map(pageRef),
    private_images: bundle.pages
      .filter((page) => page.private_images?.length)
      .map((page) => ({ ...pageRef(page), assets: page.private_images })),
    dataframes_not_copied: dataframeReport(bundle).dataframes_not_copied,
    comment_threads_not_migrated: bundle.pages.reduce(
      (sum, page) => sum + (page.comment_threads ?? 0),
      0,
    ),
    warnings,
    verification,
  };
}

/** Every Page is in the target Project, under the expected parent, in order. */
export async function verifyImport(client, bundle, state, options) {
  const rows = await listAll(client, { project_id: state.project.project_id }, options);
  const byId = new Map(rows.map((row) => [row.page_id, row]));
  const home = bundle.pages.find((page) => page.home);
  const pageIds = new Map(Object.entries(state.pages));
  const problems = [];
  const expectedOrder = new Map();
  for (const page of bundle.pages) {
    const id = state.pages[page.source_page_id];
    const row = byId.get(id);
    if (!row) {
      problems.push(`"${page.title}" (${id}) is not listed in the target Project`);
      continue;
    }
    const placement = targetPlacement(page, {
      homeSourceId: home.source_page_id,
      targetHomeId: state.project.home_page_id,
      pageIds,
    });
    if (placement.home) {
      if (row.home !== true) problems.push(`"${page.title}" is not the target home Page`);
      continue;
    }
    if ((row.parent_id ?? null) !== placement.parent_id)
      problems.push(
        `"${page.title}" is under ${row.parent_id ?? "the top level"}, expected ${placement.parent_id}`,
      );
    expectedOrder.set(placement.parent_id, [...(expectedOrder.get(placement.parent_id) ?? []), id]);
  }
  for (const [parent, expected] of expectedOrder) {
    const wanted = new Set(expected);
    const actual = rows
      .filter((row) => row.parent_id === parent && wanted.has(row.page_id))
      .sort(comparePosition)
      .map((row) => row.page_id);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      problems.push(`Sibling order under ${parent} differs from the source`);
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// CLI

/** A token from NAME or the file named by NAME_FILE; never both. */
export async function readToken(env, name) {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (direct && file) throw new TransferError(`Set ${name} or ${name}_FILE, not both`);
  if (file) {
    const path = file.replace(/^~(?=\/)/, env.HOME ?? "~");
    const value = (await readFile(path, "utf8")).trim();
    if (!value) throw new TransferError(`${name}_FILE names an empty file`);
    return value;
  }
  if (!direct)
    throw new TransferError(`Set ${name} (or ${name}_FILE) to an API key for this target`);
  return direct;
}

/** Write through a temporary file so a crash never leaves half a JSON file. */
async function writeAtomic(path, text, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", mode);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function fileStore(path) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    // Holds retry tokens: user-only.
    save: (state) => writeAtomic(path, JSON.stringify(state, null, 2) + "\n", 0o600),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new TransferError(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (["dry-run", "allow-existing-title", "reconcile", "accept-missing"].includes(name))
      flags[name] = true;
    else if (i + 1 < rest.length) flags[name] = rest[++i];
    else throw new TransferError(`--${name} needs a value`);
  }
  return { command, flags };
}

const USAGE = `Usage:
  project-transfer.mjs export --source ORIGIN --project PROJECT_ID --out BUNDLE.json
  project-transfer.mjs import --target ORIGIN --bundle BUNDLE.json [--state STATE.json]
      [--allow-existing-title] [--reconcile | --adopt ID | --accept-missing]
  project-transfer.mjs import --bundle BUNDLE.json --dry-run

Credentials: PAGES_SOURCE_TOKEN or PAGES_SOURCE_TOKEN_FILE for export,
PAGES_TARGET_TOKEN or PAGES_TARGET_TOKEN_FILE for import.`;

function printReport(lines, report) {
  for (const line of lines) console.log(line);
  if (report.unresolved_links?.length) {
    console.log("Links left pointing at the source (their Pages are not in the bundle):");
    for (const link of report.unresolved_links) console.log(`  ${link.title}: ${link.url}`);
  }
  if (report.preserved_markdown?.length) {
    console.log("Preserved Markdown, carried verbatim; check these render as intended:");
    for (const page of report.preserved_markdown) console.log(`  ${page.title}`);
  }
  if (report.private_images?.length) {
    console.log("Private images, not copied (their references point at source assets):");
    for (const page of report.private_images)
      console.log(`  ${page.title}: ${page.assets.length} image(s)`);
  }
  if (report.dataframes_not_copied?.length) {
    console.log("Dataframes not copied (they import as links to source assets):");
    for (const page of report.dataframes_not_copied)
      console.log(`  ${page.title}: ${page.assets.length} dataframe(s)`);
  }
  for (const warning of report.warnings ?? []) console.log(`Warning: ${warning}`);
}

export async function main(argv, env = process.env) {
  const { command, flags } = parseArgs(argv);
  const log = (line) => console.error(line);
  if (command === "export") {
    if (!flags.source || !flags.project || !flags.out) throw new TransferError(USAGE);
    const client = pagesClient({
      origin: flags.source,
      token: await readToken(env, "PAGES_SOURCE_TOKEN"),
    });
    const { bundle, report } = await exportProject(client, { projectId: flags.project, log });
    await writeAtomic(flags.out, JSON.stringify(bundle, null, 2) + "\n", 0o644);
    printReport(
      [
        `Exported "${bundle.project.title}": ${report.pages} Pages and ${report.dataframes} dataframe(s) to ${flags.out}`,
        `Bundle ${bundle.bundle_id} from ${bundle.source.origin} at ${bundle.exported_at}`,
        `Comments are not exported (${report.comment_threads} thread(s) stay on the source).`,
      ],
      report,
    );
    return 0;
  }
  if (command === "import") {
    if (!flags.bundle) throw new TransferError(USAGE);
    const bundle = JSON.parse(await readFile(flags.bundle, "utf8"));
    if (flags["dry-run"]) {
      for (const step of planImport(bundle))
        console.log(
          step.under === null
            ? `${step.title}: ${step.action}`
            : `${step.title}: ${step.action} under "${step.under}"`,
        );
      printReport([], bundleReport(bundle));
      return 0;
    }
    if (!flags.target) throw new TransferError(USAGE);
    const client = pagesClient({
      origin: flags.target,
      token: await readToken(env, "PAGES_TARGET_TOKEN"),
    });
    const report = await importBundle(client, bundle, {
      store: fileStore(flags.state ?? `${flags.bundle}.state.json`),
      allowExistingTitle: flags["allow-existing-title"] === true,
      reconcile: flags.reconcile === true,
      adopt: flags.adopt ?? null,
      acceptMissing: flags["accept-missing"] === true,
      log,
    });
    if (report.reconciliation) {
      const { record, candidates } = report.reconciliation;
      console.log(reconciliationMessage(record));
      if (!candidates.length)
        console.log("No candidates on the target. If none was made, rerun with --accept-missing.");
      for (const candidate of candidates)
        console.log(
          `  ${candidate.page_id ?? candidate.project_id}  "${candidate.title}"  created ${candidate.created_at}` +
            `${candidate.created_after_request ? "" : " (before the create was sent)"}  ${candidate.url}`,
        );
      console.log("Nothing was written. Open each candidate before choosing --adopt ID.");
      return 1;
    }
    printReport(
      [
        `Imported "${bundle.project.title}" into ${report.url}`,
        `Home Page: ${report.home_page_url}`,
        `${report.pages} Pages: ${report.created} created this run, ${report.edits} edit(s), ${report.links_rewritten} link(s) rewritten, ${report.dataframes} dataframe(s) written`,
        `Comments are not migrated (${report.comment_threads_not_migrated} thread(s) stay on the source).`,
        report.verification.ok
          ? "Verified: every Page is listed under its expected parent, in source order."
          : `Verification found problems:\n  ${report.verification.problems.join("\n  ")}`,
      ],
      report,
    );
    return report.verification.ok ? 0 : 1;
  }
  throw new TransferError(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof TransferError ? error.message : error);
      if (error?.uncertain)
        console.error("The last request may have been applied. Rerun the same command to resume.");
      process.exitCode = 1;
    },
  );
}
