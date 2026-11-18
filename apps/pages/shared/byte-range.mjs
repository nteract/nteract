// RFC 9110 single byte ranges. An immutable Page asset has one representation.
export function byteRange(header, size) {
  const parts = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!parts || !size || (!parts[1] && !parts[2])) return null;
  const start = parts[1] ? Number(parts[1]) : Math.max(0, size - Number(parts[2]));
  const end = parts[1] && parts[2] ? Math.min(Number(parts[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end
    ? { offset: start, length: end - start + 1 }
    : null;
}
