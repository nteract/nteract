/** Discovery traffic must not postpone the next idle-session sweep. */
export async function ensureHousekeepingAlarm(storage, now = Date.now()) {
  if ((await storage.getAlarm()) === null) await storage.setAlarm(now + 60_000);
}

/** Keep cleanup failures observable without rejecting a scheduled sweep. */
export async function runHousekeepingAlarm(storage, pool, now = Date.now(), resolver) {
  // Scheduling failures still propagate: there is no confirmed future sweep.
  await storage.setAlarm(now + 60_000);
  try {
    await pool.expire();
  } catch (error) {
    console.warn("[preview-python] Session cleanup failed; capacity remains reserved", error);
  }
  if (resolver) {
    try {
      await resolver.expireClosedSessions?.();
      await resolver.recover();
    } catch {
      // The resolver logs unconfirmed planner cleanup itself; a later sweep retries.
    }
  }
}
