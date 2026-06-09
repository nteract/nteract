// Shared source-text guardrail corpus for the cloud viewer entry.
//
// The cloud viewer entry is split into focused modules (route views, leaf
// components, hooks, config) instead of one large viewer/index.tsx. These
// guardrail tests assert that the entry routes notebook chrome through the
// shared shell and does not reintroduce bespoke cell/toolbar/presence surfaces.
// They follow the code instead of pinning index.tsx: an assertion checks that a
// pattern exists (or stays absent) across the decomposed entry modules below,
// regardless of which one currently owns it.
//
// This is an explicit allowlist of the entry surface, not the whole viewer dir.
// Sibling modules that own a separate concern (notices.tsx, sharing-controls.tsx)
// are read directly by the tests instead, so the corpus's absence-assertions
// (e.g. "CloudSharingControls is not redefined in the entry") stay meaningful.
// Add an entry module here as the split grows; files that do not exist yet are
// skipped, so the list can lead the split.

import { existsSync, readFileSync } from "node:fs";

const VIEWER_MODULE_FILES = [
  "index.tsx",
  "notebook-viewer.tsx",
  "home-view.tsx",
  "oidc-callback-view.tsx",
  "notebook-list-view.tsx",
  "cloud-notebook-dashboard-view.tsx",
  "cloud-presence-status.tsx",
  "cloud-notebook-title.tsx",
  "cloud-auth-controls.tsx",
  "use-cloud-auth.ts",
  "use-cloud-workstations.ts",
  "cloud-viewer-config.ts",
  "cloud-viewer-types.ts",
] as const;

function moduleText(name: string): string {
  const url = new URL(`../viewer/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
}

export const viewerModuleTexts: ReadonlyArray<{ name: string; text: string }> =
  VIEWER_MODULE_FILES.map((name) => ({ name, text: moduleText(name) })).filter(
    (entry) => entry.text.length > 0,
  );

// The viewer entry plus every module it delegates to, concatenated with file
// markers. Use for presence/absence assertions that should hold across the
// decomposed entry modules.
export const viewerCorpus: string = viewerModuleTexts
  .map((entry) => `/* ===== ${entry.name} ===== */\n${entry.text}`)
  .join("\n\n");

// The single viewer module that currently owns a symbol. Use for assertions
// that slice a component body, where mixing modules would be meaningless.
export function viewerFileContaining(token: string): string {
  const entry = viewerModuleTexts.find((candidate) => candidate.text.includes(token));
  if (!entry) {
    throw new Error(`No viewer module contains token: ${token}`);
  }
  return entry.text;
}

// Body of a top-level function declaration, from `function <name>` to the next
// top-level `function ` in the same module (or end of file). Survives the
// component moving into its own module.
export function viewerFunctionSource(name: string): string {
  const file = viewerFileContaining(`function ${name}`);
  const start = file.indexOf(`function ${name}`);
  const nextFunction = file.indexOf("\nfunction ", start + 1);
  return file.slice(start, nextFunction === -1 ? undefined : nextFunction);
}
