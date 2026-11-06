// Cron triggers for the Pages Worker, in UTC and the Cloudflare cron dialect
// that celld reads. build.mjs writes CRONS into wrangler.json; the Worker's
// scheduled() handler picks its tasks with scheduledTasks().

/** Daily usage rollup and purge (worker/usage-store.mjs). */
export const USAGE_CRON = "5 0 * * *";
/** Hourly auth sweep (worker/auth-maintenance.mjs). */
export const AUTH_CRON = "35 * * * *";
export const CRONS = Object.freeze([USAGE_CRON, AUTH_CRON]);

/**
 * The auth sweep runs on every occurrence. Usage maintenance runs on every
 * occurrence except the hourly auth cron, so an unnamed or unknown trigger
 * still gets the daily rollup.
 */
export function scheduledTasks(cron) {
  return { usage: cron !== AUTH_CRON, auth: true };
}
