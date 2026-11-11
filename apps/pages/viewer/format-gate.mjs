// Whether this tab may write a Page whose host refuses its document format.
//
// States:
// - open: the host hasn't refused the Page's format; other gates decide.
// - stopped: the host answered document_format_unsupported (an admission
//   stop on the socket, or discovery's 409). The Page can never save from
//   this build, so its content, title and comments are read-only and nothing
//   is written to the local copy. A person can still read and copy the
//   cached copy, and the owner's Trash and delete actions run from the host
//   record. It never reopens in this session: a newer build opens a new one.
//
// Events:
// - refused `{ code }`: the host refused this Page; only
//   document_format_unsupported stops it.
// - edit: a local write asks whether it may go ahead.
//
// Returns `{ gate, allowed }`, as schemaGateStep does.

export const FORMAT_UNSUPPORTED_CODE = "document_format_unsupported";
export const FORMAT_GATE_INITIAL = Object.freeze({ name: "open" });
const STOPPED = Object.freeze({ name: "stopped" });

export function formatGateStep(gate, event) {
  if (gate?.name !== "open" && gate?.name !== "stopped")
    throw Error(`Unknown format gate state ${gate?.name}`);
  switch (event?.type) {
    case "refused": {
      const next = event.code === FORMAT_UNSUPPORTED_CODE ? STOPPED : gate;
      return { gate: next, allowed: next.name === "open" };
    }
    case "edit":
      return { gate, allowed: gate.name === "open" };
  }
  throw Error(`Unknown format gate event ${event?.type}`);
}
