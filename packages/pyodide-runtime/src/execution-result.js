// Guest output is data, never a document patch or a blob-reference authority.
// Construct fresh records rather than forwarding arbitrary guest properties.
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value) {
  if (typeof value !== "string") throw new Error("Expected Python output text");
  return value;
}
function bundle(value) {
  if (!record(value) || Object.keys(value).length > 64)
    throw new Error("Invalid Python MIME bundle");
  const entries = Object.entries(value);
  for (const [mime] of entries) {
    if (mime.length > 256 || !/^[\w.+-]+\/[\w.+-]+$/.test(mime))
      throw new Error("Invalid output MIME type");
    if (
      (mime.startsWith("application/vnd.nteract.") &&
        mime !== "application/vnd.nteract.traceback+json") ||
      mime === "application/vnd.jupyter.widget-view+json"
    ) {
      throw new Error("Runtime-owned output references are not supported by Preview Python");
    }
  }
  return Object.fromEntries(entries);
}
function metadata(value) {
  if (value === undefined) return {};
  if (!record(value)) throw new Error("Invalid Python output metadata");
  return value;
}
export function validateExecutionResult(value, executionId, provenance) {
  if (
    !record(value) ||
    value.execution_id !== executionId ||
    (provenance &&
      (value.cell_id !== provenance.cellId || value.source_hash !== provenance.sourceHash)) ||
    typeof value.success !== "boolean" ||
    !Number.isSafeInteger(value.execution_count) ||
    value.execution_count < 1 ||
    !Array.isArray(value.outputs) ||
    value.outputs.length > 1001
  ) {
    throw new Error("Invalid Python execution result");
  }
  const outputs = value.outputs.map((output) => {
    if (!record(output)) throw new Error("Invalid Python output");
    switch (output.output_type) {
      case "stream":
        if (output.name !== "stdout" && output.name !== "stderr")
          throw new Error("Invalid stream name");
        return { output_type: "stream", name: output.name, text: text(output.text) };
      case "error":
        if (!Array.isArray(output.traceback)) throw new Error("Invalid Python traceback");
        return {
          output_type: "error",
          ename: text(output.ename),
          evalue: text(output.evalue),
          traceback: output.traceback.map(text),
        };
      case "clear_output":
        if (typeof output.wait !== "boolean") throw new Error("Invalid clear_output wait flag");
        return { output_type: "clear_output", wait: output.wait };
      case "display_data":
      case "update_display_data":
      case "execute_result": {
        const result = {
          output_type: output.output_type,
          data: bundle(output.data),
          metadata: metadata(output.metadata),
        };
        if (output.output_type === "execute_result") result.execution_count = value.execution_count;
        if (output.transient?.display_id !== undefined)
          result.transient = { display_id: text(output.transient.display_id) };
        if (output.output_type === "update_display_data" && !result.transient?.display_id)
          throw new Error("Display update needs a display ID");
        return result;
      }
      default:
        throw new Error("Unsupported Python output type");
    }
  });
  return {
    execution_id: executionId,
    ...(provenance ? { cell_id: provenance.cellId, source_hash: provenance.sourceHash } : {}),
    execution_count: value.execution_count,
    success: value.success,
    outputs,
  };
}
