// The host's view libraries: the bare names a view's modules import from the
// library catalog every build carries (scripts/library-catalog.mjs).
export const standardImports = Object.freeze([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "d3",
  "@observablehq/plot",
  "@nteract/sift/parquet",
]);
export const catalogDigest = /^[a-f0-9]{64}$/;
