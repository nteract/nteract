import { allowsNotebookWrite, isConnectionScope } from "runtimed";

/**
 * Whether a connection may write notebook-owned documents (NotebookDoc,
 * CommentsDoc, Bokeh session documents). `null` is an unscoped local
 * connection, which belongs to the notebook's owner.
 */
export function connectionScopeAllowsNotebookWrite(scope: string | null): boolean {
  return scope === null || (isConnectionScope(scope) && allowsNotebookWrite(scope));
}
