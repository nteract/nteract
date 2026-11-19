// What a CSV header must hold for a Page to read the file: column names a
// table, a chart and a module view can tell apart. The CSV parser accepts any
// header, so csv-arrow.mjs checks the names it parsed, and the Sources preview
// (source-preview-store.mjs) checks the names it read, with this one rule.
import { MAX_COLUMN_NAME } from "@nteract/output-frame/column-set";

const shown = (name) => (name.length > 40 ? `${name.slice(0, 40)}…` : name);

/** Why a file with these header `names` can't be read, as the end of a
 * sentence, or null when every name is present, unique and at most
 * MAX_COLUMN_NAME characters. */
export function csvHeaderProblem(names) {
  const seen = new Set();
  for (const name of names) {
    if (name === "") return "a column has no name.";
    if (name.length > MAX_COLUMN_NAME)
      return `the column ${shown(name)} has a name longer than ${MAX_COLUMN_NAME} characters.`;
    if (seen.has(name)) return `two columns are named ${shown(name)}.`;
    seen.add(name);
  }
  return null;
}
