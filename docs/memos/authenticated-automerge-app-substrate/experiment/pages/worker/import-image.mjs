import { HttpError, errorResponse } from "./auth.mjs";
import { validPageId } from "./registration.mjs";
import { persistImageAsset, privateImageResponse, readImageBody } from "./image-assets.mjs";

export const IMAGE_IMPORT_TIMEOUT_MS = 20_000;
const fileFields = new Set(["download_url", "file_id", "mime_type", "file_name"]);
const boundedText = (value, max) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  // Reject control characters in externally supplied file metadata.
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(value);

function fileDownloadUrl(file) {
  if (
    !file ||
    typeof file !== "object" ||
    Array.isArray(file) ||
    Object.keys(file).some((key) => !fileFields.has(key)) ||
    !boundedText(file.download_url, 8192) ||
    !boundedText(file.file_id, 256) ||
    (file.mime_type !== undefined && !boundedText(file.mime_type, 127)) ||
    (file.file_name !== undefined && !boundedText(file.file_name, 512))
  )
    throw new HttpError(400, "Use a ChatGPT file attachment with download_url and file_id");
  let url;
  try {
    url = new URL(file.download_url);
  } catch {
    throw new HttpError(400, "Invalid image download URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.oaiusercontent.com" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    url.hash ||
    /[\\#\s]/.test(file.download_url)
  )
    throw new HttpError(400, "Use a file attachment from ChatGPT's supported image host");
  return url;
}

function cancelBody(response) {
  void response?.body?.cancel().catch(() => {});
}

async function downloadImage(request, url) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new HttpError(504, "Image download timed out")),
    IMAGE_IMPORT_TIMEOUT_MS,
  );
  const cancel = () => controller.abort(new HttpError(408, "Image import canceled"));
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      (async () => {
        // Never forward the caller's cookie, OAuth token, or provider headers.
        const response = await fetch(url.href, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
          headers: { Accept: "image/png, image/jpeg, image/webp, application/octet-stream" },
        });
        if (controller.signal.aborted) {
          cancelBody(response);
          controller.signal.throwIfAborted();
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          cancelBody(response);
          throw new HttpError(400, "Image download redirects are not supported");
        }
        if (!response.ok) {
          cancelBody(response);
          throw new HttpError(502, "Image could not be downloaded");
        }
        const bytes = await readImageBody(response, { signal: controller.signal });
        return { bytes, contentType: response.headers.get("content-type") };
      })(),
      aborted,
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof HttpError) throw error;
    // Fetch/stream exceptions can contain signed URLs. Keep them out of logs/results.
    throw new HttpError(502, "Image could not be downloaded");
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
    request.signal.removeEventListener("abort", cancel);
  }
}

/** Called only by authenticated MCP dispatch. The callback rechecks grant and Page write access. */
export async function handleImportPageImage(request, env, { pageId, file, authorize }) {
  try {
    if (!validPageId(pageId)) throw new HttpError(400, "Invalid page_id");
    const url = fileDownloadUrl(file);
    const access = await authorize(true);
    if (!access.ok) return privateImageResponse(access);
    if (!env.PAGES_ASSETS) throw new HttpError(503, "Image storage is unavailable");
    const { bytes, contentType } = await downloadImage(request, url);
    const { asset, duplicate } = await persistImageAsset(env.PAGES_ASSETS, {
      pageId,
      bytes,
      contentTypes: [contentType, file.mime_type],
    });
    const current = await authorize(true);
    if (!current.ok) return privateImageResponse(current);
    const { url: asset_url, ...metadata } = asset;
    return privateImageResponse(
      Response.json({ page_id: pageId, ...metadata, asset_url }, { status: duplicate ? 200 : 201 }),
    );
  } catch (error) {
    return privateImageResponse(errorResponse(error, "import-page-image"));
  }
}
