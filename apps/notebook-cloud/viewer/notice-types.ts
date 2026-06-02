// Shared notice state types for the cloud viewer. Both index.tsx (which owns
// the React state) and notices.tsx (which renders it) depend on these, so they
// live here to keep a single canonical definition and avoid drift.

export type CloudAuthRenewalState =
  | { kind: "idle"; message: null }
  | { kind: "refreshing"; message: string }
  | { kind: "failed"; message: string };

export type ViewerStatus =
  | { kind: "loading"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready"; message: string }
  | { kind: "error"; message: string };
