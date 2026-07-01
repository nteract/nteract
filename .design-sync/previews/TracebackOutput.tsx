import { TracebackOutput } from "nteract-elements";

// The structured `application/vnd.nteract.traceback+json` payload (not the raw
// ANSI string): TracebackOutput renders frames with source context, dims
// library frames, and highlights the failing line. This is the nteract-owned
// view — richer than the classic ANSI dump.
const keyError = {
  ename: "KeyError",
  evalue: "'region'",
  language: "python",
  frames: [
    {
      filename: "<ipython-input-7>",
      lineno: 3,
      name: "<module>",
      lines: [
        { lineno: 1, source: 'df = pd.read_csv("sales.csv")' },
        { lineno: 2, source: "totals = {}" },
        { lineno: 3, source: 'totals["revenue"] = df["region"].sum()', highlight: true },
      ],
    },
    {
      filename: "/opt/env/lib/python3.12/site-packages/pandas/core/frame.py",
      lineno: 4102,
      name: "__getitem__",
      library: true,
      lines: [
        { lineno: 4100, source: "        if self.columns.nlevels > 1:" },
        { lineno: 4101, source: "            return self._getitem_multilevel(key)" },
        { lineno: 4102, source: "        indexer = self.columns.get_loc(key)", highlight: true },
      ],
    },
  ],
};

export function PandasKeyError() {
  return <TracebackOutput data={keyError} />;
}
