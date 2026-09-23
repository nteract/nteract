/** Discovery traffic must not postpone the next idle-session sweep. */
export async function ensureHousekeepingAlarm(storage, now = Date.now()) {
  if ((await storage.getAlarm()) === null) await storage.setAlarm(now + 60_000);
}
