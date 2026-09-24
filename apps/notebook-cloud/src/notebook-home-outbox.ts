import type { Env } from "./cloudflare-types.ts";
import { ensureCatalogSchema } from "./storage.ts";
import { cloudLog } from "./observability.ts";

/**
 * Notifications contain no notebook data. The recipient refetches through the
 * catalog API, which rechecks current access. A conditional acknowledgement
 * keeps a concurrent write pending; duplicate notifications are harmless.
 */
export async function drainNotebookHomeOutbox(env: Env): Promise<void> {
  if (!env.DB || !env.NOTEBOOK_HOME) return;
  try {
    await ensureCatalogSchema(env);
    const pending = await env.DB.prepare(
      `SELECT principal, change_id FROM notebook_home_outbox WHERE queued_at <= unixepoch() ORDER BY queued_at, principal LIMIT 100`,
    ).all<{ principal: string; change_id: string }>();
    const rows = pending.results ?? [];
    for (let index = 0; index < rows.length; index += 20) {
      await Promise.all(
        rows.slice(index, index + 20).map(async (row) => {
          try {
            const namespace = env.NOTEBOOK_HOME!;
            const response = await namespace.get(namespace.idFromName(row.principal)).fetch(
              new Request("https://notebook-home.internal/notify", {
                method: "POST",
                signal: AbortSignal.timeout(5_000),
              }),
            );
            if (!response.ok) throw new Error(`notification returned ${response.status}`);
            await env
              .DB!.prepare(`DELETE FROM notebook_home_outbox WHERE principal = ? AND change_id = ?`)
              .bind(row.principal, row.change_id)
              .run();
          } catch (error) {
            // Back off this version so one unavailable recipient cannot starve
            // the remainder of a bounded batch on every drain.
            await env
              .DB!.prepare(
                `UPDATE notebook_home_outbox SET queued_at = unixepoch() + 30 WHERE principal = ? AND change_id = ?`,
              )
              .bind(row.principal, row.change_id)
              .run();
            cloudLog("warn", "notebook_home.delivery_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
  } catch (error) {
    cloudLog("warn", "notebook_home.outbox_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
