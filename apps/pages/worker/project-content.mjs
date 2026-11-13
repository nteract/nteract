import { HttpError } from "./auth.mjs";
import { requirePageIdArgument, requireSpaceIdArgument } from "./spaces.mjs";
import { validPageId } from "./registration.mjs";
import { readResponseJson, untilAborted } from "./tool-deadline.mjs";

// Placement and sharing tools have different meanings for project_id.
export const PROJECT_CONTENT_OPERATIONS = new Set([
  "read_page",
  "read_page_changes",
  "edit_page",
  "list_page_comments",
  "manage_page_comment",
  "read_page_presence",
  "report_page_progress",
  "create_page_asset_upload",
  "reply_page_comment",
]);

export function contentSelector(args) {
  if (Object.hasOwn(args, "page_id") === Object.hasOwn(args, "project_id"))
    throw new HttpError(400, "Supply exactly one of page_id or project_id", "invalid_arguments");
  if (Object.hasOwn(args, "project_id")) return requireSpaceIdArgument(args.project_id);
  requirePageIdArgument(args.page_id);
  return null;
}

/** Resolve only identity. The existing Page policy still admits every operation.
 * No caller credentials reach these host-only mapping reads or claim invitations. */
export async function resolveProjectContent(env, args, signal) {
  const projectId = args.project_id;
  const read = async (binding, id, path, body) => {
    const response = await untilAborted(
      binding.getByName(id).fetch(
        new Request(`https://pages.internal${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        { signal },
      ),
      signal,
    );
    if (!response.ok)
      throw new HttpError(
        response.status >= 500 ? 503 : 404,
        "Project content unavailable",
        response.status >= 500 ? "shared_page_unavailable" : "project_not_found",
      );
    return readResponseJson(response, signal);
  };
  const mapping = await read(env.PROJECTS, projectId, "/internal/space/content", {
    space_id: projectId,
  });
  if (typeof mapping.owner !== "string" || !mapping.owner || !validPageId(mapping.page_id))
    throw new HttpError(404, "Project content unavailable", "project_not_found");
  await read(env.CATALOGS, mapping.owner, "/internal/location", {
    project_content: projectId,
    page_id: mapping.page_id,
  });
  await read(env.PAGES, mapping.page_id, "/internal/content-target", {
    page_id: mapping.page_id,
    owner: mapping.owner,
  });
  // Fingerprints serialize argument order. Replace the selector in place so
  // switching aliases preserves the exact physical Page request and receipt.
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) =>
      key === "project_id" ? ["page_id", mapping.page_id] : [key, value],
    ),
  );
}
