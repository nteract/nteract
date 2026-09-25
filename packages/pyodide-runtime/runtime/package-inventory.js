/** Confirm the shipped wheel closure against the interpreter before tenant use. */
export function includedPackageInventory(wheels, installed) {
  const observed = new Set(installed);
  for (const { name, version } of wheels) {
    const spec = `${name.toLowerCase().replace(/[-_.]+/g, "-")}==${version}`;
    if (!version || !observed.has(spec))
      throw new Error(`Included package inventory mismatch: ${name}`);
  }
  return [...observed].sort();
}
