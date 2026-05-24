export interface MinimalTextReplacement {
  from: number;
  to: number;
  insert: string;
}

export function minimalTextReplacement(
  current: string,
  next: string,
): MinimalTextReplacement | null {
  if (current === next) return null;

  let from = 0;
  while (
    from < current.length &&
    from < next.length &&
    current.charCodeAt(from) === next.charCodeAt(from)
  ) {
    from += 1;
  }

  let currentTo = current.length;
  let nextTo = next.length;
  while (
    currentTo > from &&
    nextTo > from &&
    current.charCodeAt(currentTo - 1) === next.charCodeAt(nextTo - 1)
  ) {
    currentTo -= 1;
    nextTo -= 1;
  }

  return {
    from,
    to: currentTo,
    insert: next.slice(from, nextTo),
  };
}
