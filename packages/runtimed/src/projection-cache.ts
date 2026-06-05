export function getBoundedCacheValue<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const cached = cache.get(key);
  if (cached === undefined) return undefined;

  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

export function setBoundedCacheValue<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

export function stableCacheKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}
