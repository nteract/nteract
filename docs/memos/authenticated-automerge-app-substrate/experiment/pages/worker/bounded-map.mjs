/**
 * `task` over `items` with at most `limit` running at once, results in item
 * order. Each finished task starts the next, so one slow task holds one slot
 * rather than a whole wave.
 *
 * The first failure stops new tasks. The ones already running settle before
 * the failure is rethrown, so nothing this started outlives the call: a
 * Durable Object request that returns has no checks still running in its
 * context.
 */
export async function boundedMap(items, limit, task) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be at least 1");
  const results = Array.from({ length: items.length });
  let next = 0;
  let failure;
  const lane = async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
  return results;
}
