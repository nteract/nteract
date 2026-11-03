// The writes and listings behind the New Project and Move to… dialogs.
// Each write takes the retry_token and a v1_ idempotency_key built from it, so
// a retry with the same `attempt` replays the receipt instead of writing again.
import { retryKey } from "../model/retry-key.mjs";
import { listAllPages } from "./page-list.mjs";
import { listProjectPages } from "./projects.mjs";

/** A write's error, carrying the attempt a retry should replay. */
function attemptError(error, attempt) {
  const failure = error instanceof Error ? error : new Error(String(error));
  failure.attempt = attempt;
  return failure;
}

async function prepare(call, operation, attempt) {
  if (attempt) return attempt;
  const listed = await call(operation, { limit: 1 });
  return { retry_token: listed.retry_token, idempotency_key: await retryKey(listed.retry_token) };
}

/** create_project, the same path agents use. Returns its receipt. */
export async function createProject(call, { title, description }, attempt = null) {
  const keyed = await prepare(call, "list_projects", attempt);
  try {
    return await call("create_project", {
      title: title.trim(),
      ...(description?.trim() ? { description: description.trim() } : {}),
      ...keyed,
    });
  } catch (error) {
    throw attemptError(error, keyed);
  }
}

/** move_page's arguments for a destination: a parent Page, a Project's top
 * level, or Your items (`target` null). */
export function moveArguments(pageId, { target, parent_id }) {
  if (parent_id) return { page_id: pageId, parent_id };
  return { page_id: pageId, project_id: target ?? null };
}

/** move_page. Returns its receipt. */
export async function movePage(call, pageId, form, attempt = null) {
  const keyed = await prepare(call, "list_pages", attempt);
  try {
    return await call("move_page", { ...moveArguments(pageId, form), ...keyed });
  } catch (error) {
    throw attemptError(error, keyed);
  }
}

/** Destinations for the picker: Your items, then each Project this account
 * owns. list_projects lists only owned Projects in this build. `current`
 * (`{ project_id, title }`), the Page's own Project, is added when the list
 * doesn't have it yet, so the picker never shows Your items while the form
 * holds a Project ID. */
export function moveDestinations(projects, current = null) {
  const listed = projects.map((project) => ({
    target: project.project_id,
    title: project.title || "Untitled",
  }));
  if (current?.project_id && !listed.some((row) => row.target === current.project_id))
    listed.unshift({ target: current.project_id, title: current.title || "This Project" });
  return [{ target: null, title: "Your items" }, ...listed];
}

/**
 * Pages a moved Page could go under at a destination: owned, not a Project's
 * home Page (the top level stands for it), and not the moved Page or one of
 * its sub-pages. Rows are `{ page_id, title, depth }` in tree order.
 */
export function parentChoices(pages, movingId) {
  const owned = pages.filter((page) => !page.shared && !page.home);
  const ids = new Set(owned.map((page) => page.page_id));
  const children = new Map();
  for (const page of owned) {
    const parent = page.parent_id && ids.has(page.parent_id) ? page.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(page);
  }
  const order = (a, b) =>
    (a.position ?? "") === (b.position ?? "")
      ? (a.title || "").localeCompare(b.title || "")
      : (a.position ?? "") < (b.position ?? "")
        ? -1
        : 1;
  const rows = [];
  const visit = (parent, depth) => {
    for (const page of (children.get(parent) ?? []).sort(order)) {
      // The moved Page and its subtree can't hold it.
      if (page.page_id === movingId) continue;
      rows.push({ page_id: page.page_id, title: page.title || "Untitled", depth });
      if (depth < 8) visit(page.page_id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** The Pages at a destination, as parent choices. */
export async function loadParentChoices(call, target, movingId) {
  const pages =
    target === null
      ? ((await listAllPages(call)).pages ?? []).filter((page) => !page.project_id)
      : await listProjectPages(call, target);
  return parentChoices(pages, movingId);
}
