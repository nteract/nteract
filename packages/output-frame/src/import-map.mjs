// The frame's one import map, built at mount (runtime.mjs): the view's
// libraries from the mount payload (payload.mjs checkLibraries), then each
// name the view binds, its imports and data/ files, as a blob URL. A bound
// name never replaces a library: the view's own code must not stand in for a
// module the page names as a library. `integrity`, the library modules' sha256
// values from the payload, makes the browser refuse a library module whose
// bytes differ.
export function frameImportMap(libraries, bound, integrity) {
  const imports = { ...libraries };
  for (const [name, url] of bound) {
    if (Object.hasOwn(imports, name)) throw Error("A bound import shadows a library: " + name);
    imports[name] = url;
  }
  return integrity ? { imports, integrity: { ...integrity } } : { imports };
}
