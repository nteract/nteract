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
// stay meaningful. Add an entry module here as the split grows.

import { readFileSync } from "node:fs";

const VIEWER_MODULE_FILES = [
  "index.tsx",
  "notebook-viewer.tsx",
  "home-view.tsx",
  "notebook-list-view.tsx",
  "oidc-callback-view.tsx",
  "cloud-notebook-dashboard-view.tsx",
  "cloud-presence-status.tsx",
  "cloud-notebook-title.tsx",
  "cloud-auth-controls.tsx",
  "use-cloud-auth.ts",
  "use-cloud-workstations.ts",
  "use-cloud-shell-capabilities.ts",
  "cloud-viewer-config.ts",
  "cloud-viewer-types.ts",
] as const;

function moduleText(name: string): string {
  return readFileSync(new URL(`../viewer/${name}`, import.meta.url), "utf8");
}

export const viewerModuleTexts: ReadonlyArray<{ name: string; text: string }> =
  VIEWER_MODULE_FILES.map((name) => ({ name, text: moduleText(name) }));

export const viewerCorpus: string = viewerModuleTexts
  .map((entry) => `/* ===== ${entry.name} ===== */\n${entry.text}`)
  .join("\n\n");

export function viewerFileContaining(token: string): string {
  const entry = viewerModuleTexts.find((candidate) => candidate.text.includes(token));
  if (!entry) {
    throw new Error(`No viewer module contains token: ${token}`);
  }
  return entry.text;
}

export function viewerFunctionSource(name: string): string {
  const file = viewerFileContaining(`function ${name}`);
  const start = file.indexOf(`function ${name}`);
  const nextFunction = file.slice(start + 1).search(/\n(?:export\s+)?function /);
  return file.slice(start, nextFunction === -1 ? undefined : start + 1 + nextFunction);
}
