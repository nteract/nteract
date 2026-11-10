import { scheduledTasks } from "../shared/schedule.mjs";
import { runAuthMaintenance } from "./auth-maintenance.mjs";
import { runUsageMaintenance } from "./usage-store.mjs";

const SCHEDULED_TASKS = {
  usage: (env) => runUsageMaintenance(env),
  auth: (env) => runAuthMaintenance(env),
};

/**
 * Each task runs even when another fails. A failure logs the task and error
 * name only, then the handler rejects so celld retries the occurrence; both
 * tasks are safe to rerun.
 */
export async function runScheduled(controller, env, tasks = SCHEDULED_TASKS) {
  const selected = scheduledTasks(controller?.cron);
  const failed = [];
  for (const [name, run] of Object.entries(tasks)) {
    if (!selected[name]) continue;
    try {
      await run(env);
    } catch (error) {
      failed.push(name);
      console.warn(
        JSON.stringify({
          event: "pages.scheduled_task_failed",
          task: name,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }
  if (failed.length) throw new Error(`Scheduled maintenance failed: ${failed.join(",")}`);
}
