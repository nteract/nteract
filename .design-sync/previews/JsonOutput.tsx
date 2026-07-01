import { JsonOutput } from "nteract-elements";

// A typical kernel result: a nested API/response object. Exercises objects,
// arrays, strings, numbers, and booleans in the tree view.
const response = {
  id: "run_4f3a9c21",
  status: "completed",
  model: "claude-opus-4",
  usage: { input_tokens: 812, output_tokens: 143, total_tokens: 955 },
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "Rows written: 1,284" },
    },
  ],
  metadata: { cached: false, latency_ms: 412, region: "us-west-2", retries: 0 },
};

export function ApiResponse() {
  return <JsonOutput data={response} />;
}

// Collapsed past depth 1, with type annotations shown next to each value —
// how you'd inspect a large payload without expanding everything.
export function CollapsedWithTypes() {
  return <JsonOutput data={response} collapsed={1} displayDataTypes />;
}
