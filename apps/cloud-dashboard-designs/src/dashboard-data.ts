export type NotebookAccess = "owner" | "editor" | "viewer";
export type NotebookShareState = "private" | "shared" | "published";
export type NotebookComputeState = "ready" | "available" | "detached" | "none";

export interface NotebookFixture {
  id: string;
  title: string | null;
  project: string;
  owner: string;
  access: NotebookAccess;
  updatedLabel: string;
  createdLabel: string;
  minutesAgo: number;
  shareState: NotebookShareState;
  computeState: NotebookComputeState;
  summary: string;
  tags: readonly string[];
}

const primaryNotebooks = [
  {
    id: "nb-8d3a90f7",
    title: "Revenue forecast model",
    project: "Planning",
    owner: "kyle",
    access: "owner",
    updatedLabel: "4 min ago",
    createdLabel: "Jun 8",
    minutesAgo: 4,
    shareState: "published",
    computeState: "ready",
    summary: "Quarterly plan with scenario cells and a published preview.",
    tags: ["forecast", "published", "python"],
  },
  {
    id: "nb-c5a22bd1",
    title: "Hello",
    project: "Scratch",
    owner: "kyle",
    access: "owner",
    updatedLabel: "18 min ago",
    createdLabel: "Jun 8",
    minutesAgo: 18,
    shareState: "private",
    computeState: "detached",
    summary: "Small room used to validate hosted toolbar attachment.",
    tags: ["scratch"],
  },
  {
    id: "nb-b7e8112a",
    title: "Runtime peer smoke matrix",
    project: "Smoke tests",
    owner: "kyle",
    access: "owner",
    updatedLabel: "42 min ago",
    createdLabel: "Jun 8",
    minutesAgo: 42,
    shareState: "private",
    computeState: "available",
    summary: "Runtime peer attach, execute, and output replay checks.",
    tags: ["smoke", "runtime"],
  },
  {
    id: "nb-996c322e",
    title: "Changelog render pass",
    project: "Docs",
    owner: "marina",
    access: "editor",
    updatedLabel: "1 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 72,
    shareState: "shared",
    computeState: "none",
    summary: "Editorial notebook for release-note screenshots.",
    tags: ["docs", "shared"],
  },
  {
    id: "nb-a6fc6e14",
    title: null,
    project: "Smoke tests",
    owner: "kyle",
    access: "owner",
    updatedLabel: "1 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 86,
    shareState: "private",
    computeState: "none",
    summary: "Untitled room from toolbar attach smoke 2026-06-08T19:26:35.312Z.",
    tags: ["untitled", "smoke"],
  },
  {
    id: "nb-625f8b09",
    title: "Hosted auth edge cases",
    project: "Cloud",
    owner: "kyle",
    access: "owner",
    updatedLabel: "2 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 121,
    shareState: "shared",
    computeState: "detached",
    summary: "OIDC renewal, app-session bootstrap, and anonymous viewer checks.",
    tags: ["cloud", "auth"],
  },
  {
    id: "nb-c01050f2",
    title: "Package rail fixtures",
    project: "Notebook UI",
    owner: "avery",
    access: "editor",
    updatedLabel: "2 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 143,
    shareState: "private",
    computeState: "available",
    summary: "Read-only package metadata and environment source snapshots.",
    tags: ["packages", "rail"],
  },
  {
    id: "nb-19d94df8",
    title: null,
    project: "Smoke tests",
    owner: "kyle",
    access: "owner",
    updatedLabel: "3 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 186,
    shareState: "private",
    computeState: "none",
    summary: "Untitled room from toolbar attach smoke 2026-06-08T19:24:05.778Z.",
    tags: ["untitled", "smoke"],
  },
  {
    id: "nb-75ae6ab1",
    title: "Output renderer regression set",
    project: "Renderer",
    owner: "kyle",
    access: "owner",
    updatedLabel: "4 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 248,
    shareState: "private",
    computeState: "ready",
    summary: "Matplotlib, Vega, Plotly, image, and widget output fixtures.",
    tags: ["outputs", "renderer"],
  },
  {
    id: "nb-03ac865b",
    title: "Launch notes review",
    project: "Docs",
    owner: "marina",
    access: "viewer",
    updatedLabel: "5 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 301,
    shareState: "published",
    computeState: "none",
    summary: "Published read-only notebook for launch-note review.",
    tags: ["docs", "published"],
  },
  {
    id: "nb-0af52320",
    title: null,
    project: "Scratch",
    owner: "kyle",
    access: "owner",
    updatedLabel: "6 hr ago",
    createdLabel: "Jun 8",
    minutesAgo: 384,
    shareState: "private",
    computeState: "detached",
    summary: "Untitled notebook created from a blank hosted room.",
    tags: ["untitled", "scratch"],
  },
  {
    id: "nb-f3d42ba9",
    title: "Model diagnostics",
    project: "Planning",
    owner: "sam",
    access: "editor",
    updatedLabel: "Yesterday",
    createdLabel: "Jun 7",
    minutesAgo: 1180,
    shareState: "shared",
    computeState: "ready",
    summary: "Forecast residuals and data-quality diagnostics.",
    tags: ["forecast", "shared"],
  },
  {
    id: "nb-f19d8f3a",
    title: "Notebook shell parity",
    project: "Notebook UI",
    owner: "kyle",
    access: "owner",
    updatedLabel: "Yesterday",
    createdLabel: "Jun 7",
    minutesAgo: 1320,
    shareState: "private",
    computeState: "available",
    summary: "Cloud shell adapter checks against the shared notebook surface.",
    tags: ["shell", "cloud"],
  },
  {
    id: "nb-473e02ab",
    title: "Public preview metadata",
    project: "Cloud",
    owner: "kyle",
    access: "owner",
    updatedLabel: "Yesterday",
    createdLabel: "Jun 7",
    minutesAgo: 1396,
    shareState: "published",
    computeState: "detached",
    summary: "Revision-safe share cards and preview image behavior.",
    tags: ["sharing", "published"],
  },
  {
    id: "nb-5d7cdd11",
    title: "Automerge sync notebook",
    project: "Notebook UI",
    owner: "noor",
    access: "viewer",
    updatedLabel: "Yesterday",
    createdLabel: "Jun 7",
    minutesAgo: 1504,
    shareState: "shared",
    computeState: "none",
    summary: "Shared read-only fixture for document convergence demos.",
    tags: ["sync", "viewer"],
  },
  {
    id: "nb-8acfb668",
    title: null,
    project: "Smoke tests",
    owner: "kyle",
    access: "owner",
    updatedLabel: "Yesterday",
    createdLabel: "Jun 7",
    minutesAgo: 1658,
    shareState: "private",
    computeState: "none",
    summary: "Untitled room from hosted source-room smoke.",
    tags: ["untitled", "smoke"],
  },
  {
    id: "nb-3a780bde",
    title: "Kernel interrupt behavior",
    project: "Runtime",
    owner: "kyle",
    access: "owner",
    updatedLabel: "2 days ago",
    createdLabel: "Jun 6",
    minutesAgo: 2500,
    shareState: "private",
    computeState: "ready",
    summary: "Long-running cells, interrupt controls, and terminal state ordering.",
    tags: ["runtime", "kernel"],
  },
  {
    id: "nb-13cfe552",
    title: "Widget replay audit",
    project: "Renderer",
    owner: "kyle",
    access: "owner",
    updatedLabel: "2 days ago",
    createdLabel: "Jun 6",
    minutesAgo: 2875,
    shareState: "private",
    computeState: "available",
    summary: "ipywidgets replay and comm-state projection checks.",
    tags: ["widgets", "renderer"],
  },
  {
    id: "nb-555d2a77",
    title: "Customer notebook import",
    project: "Imports",
    owner: "taylor",
    access: "editor",
    updatedLabel: "3 days ago",
    createdLabel: "Jun 5",
    minutesAgo: 4380,
    shareState: "shared",
    computeState: "none",
    summary: "Imported notebook with markdown-heavy cells and attachments.",
    tags: ["imports", "shared"],
  },
  {
    id: "nb-6b077ab3",
    title: "Notebook title migration",
    project: "Cloud",
    owner: "kyle",
    access: "owner",
    updatedLabel: "3 days ago",
    createdLabel: "Jun 5",
    minutesAgo: 4621,
    shareState: "private",
    computeState: "detached",
    summary: "Catalog title update behavior for legacy untitled rooms.",
    tags: ["cloud", "titles"],
  },
  {
    id: "nb-a97dd6c4",
    title: null,
    project: "Smoke tests",
    owner: "kyle",
    access: "owner",
    updatedLabel: "4 days ago",
    createdLabel: "Jun 4",
    minutesAgo: 5820,
    shareState: "private",
    computeState: "none",
    summary: "Untitled room from access-request route smoke.",
    tags: ["untitled", "smoke"],
  },
  {
    id: "nb-0d4ef381",
    title: "Scenario table cleanup",
    project: "Planning",
    owner: "sam",
    access: "viewer",
    updatedLabel: "5 days ago",
    createdLabel: "Jun 3",
    minutesAgo: 7365,
    shareState: "published",
    computeState: "none",
    summary: "Published scenario-table cleanup readout.",
    tags: ["forecast", "published"],
  },
  {
    id: "nb-f066c929",
    title: "Renderer memory profile",
    project: "Renderer",
    owner: "kyle",
    access: "owner",
    updatedLabel: "Last week",
    createdLabel: "Jun 2",
    minutesAgo: 10440,
    shareState: "private",
    computeState: "available",
    summary: "Arrow-heavy output profile and isolated frame memory capture.",
    tags: ["outputs", "profile"],
  },
  {
    id: "nb-dbc111ef",
    title: null,
    project: "Scratch",
    owner: "kyle",
    access: "owner",
    updatedLabel: "Last week",
    createdLabel: "Jun 1",
    minutesAgo: 12150,
    shareState: "private",
    computeState: "none",
    summary: "Untitled scratch room kept to exercise dense dashboard states.",
    tags: ["untitled", "scratch"],
  },
] as const satisfies readonly NotebookFixture[];

const generatedSmokeNotebooks: NotebookFixture[] = Array.from({ length: 76 }, (_, index) => {
  const sequence = index + 1;
  const title =
    sequence % 4 === 0
      ? null
      : sequence % 5 === 0
        ? `Renderer smoke ${String(sequence).padStart(2, "0")}`
        : `Toolbar attach smoke 2026-06-${String((sequence % 9) + 1).padStart(2, "0")}T${String(
            9 + (sequence % 10),
          ).padStart(2, "0")}:${String((sequence * 7) % 60).padStart(2, "0")}:05.778Z`;
  const project =
    sequence % 6 === 0
      ? "Renderer"
      : sequence % 5 === 0
        ? "Runtime"
        : sequence % 4 === 0
          ? "Scratch"
          : "Smoke tests";
  const shareState: NotebookShareState = sequence % 17 === 0 ? "published" : "private";
  const computeState: NotebookComputeState =
    sequence % 11 === 0 ? "available" : sequence % 7 === 0 ? "detached" : "none";
  return {
    id: `nb-smoke-${String(sequence).padStart(3, "0")}`,
    title,
    project,
    owner: "kyle",
    access: sequence % 13 === 0 ? "editor" : "owner",
    updatedLabel: sequence < 18 ? "Last week" : `${Math.floor(sequence / 8) + 1} weeks ago`,
    createdLabel: "May 2026",
    minutesAgo: 13200 + sequence * 97,
    shareState,
    computeState,
    summary: title
      ? "Generated smoke notebook kept to exercise dense hosted dashboard states."
      : "Untitled generated smoke room kept to exercise cleanup and rename flows.",
    tags: title ? ["smoke", "generated"] : ["untitled", "smoke", "generated"],
  };
});

export const notebooks = [
  ...primaryNotebooks,
  ...generatedSmokeNotebooks,
] satisfies readonly NotebookFixture[];

export const sortedNotebooks = [...notebooks].sort(
  (left, right) => left.minutesAgo - right.minutesAgo,
);

export const pinnedNotebookIds = [
  "nb-8d3a90f7",
  "nb-75ae6ab1",
  "nb-f19d8f3a",
  "nb-473e02ab",
] as const;

export const projectNames = Array.from(
  new Set(sortedNotebooks.map((notebook) => notebook.project)),
);

export const workstationFacts = {
  defaultName: "Lab workstation",
  status: "Available",
  detail: "Host-owned compute target. Notebook execution controls stay inside an opened notebook.",
  facts: ["8 CPU", "31 GiB RAM", "Python 3.12"],
};

export const sharingFacts = {
  published: sortedNotebooks.filter((notebook) => notebook.shareState === "published").length,
  shared: sortedNotebooks.filter((notebook) => notebook.shareState === "shared").length,
  private: sortedNotebooks.filter((notebook) => notebook.shareState === "private").length,
};

export const dashboardCounts = {
  visible: sortedNotebooks.length,
  titled: sortedNotebooks.filter((notebook) => Boolean(notebook.title?.trim())).length,
  untitled: sortedNotebooks.filter((notebook) => !notebook.title?.trim()).length,
  owned: sortedNotebooks.filter((notebook) => notebook.access === "owner").length,
  editable: sortedNotebooks.filter(
    (notebook) => notebook.access === "owner" || notebook.access === "editor",
  ).length,
  published: sharingFacts.published,
};

export function displayTitle(notebook: NotebookFixture): string {
  return notebook.title?.trim() || "Untitled notebook";
}

export function shortId(notebook: NotebookFixture): string {
  return `${notebook.id.slice(0, 7)}...${notebook.id.slice(-3)}`;
}

export function shareLabel(notebook: NotebookFixture): string {
  if (notebook.shareState === "published") {
    return "published";
  }
  if (notebook.shareState === "shared") {
    return "shared";
  }
  return "private";
}

export function accessLabel(notebook: NotebookFixture): string {
  if (notebook.access === "owner") {
    return "owner";
  }
  if (notebook.access === "editor") {
    return "editor";
  }
  return "viewer";
}

export function computeLabel(notebook: NotebookFixture): string {
  if (notebook.computeState === "ready") {
    return "compute ready";
  }
  if (notebook.computeState === "available") {
    return "workstation available";
  }
  if (notebook.computeState === "detached") {
    return "Python / detached";
  }
  return "no compute";
}

export function notebooksForProject(project: string): NotebookFixture[] {
  return sortedNotebooks.filter((notebook) => notebook.project === project);
}

export function notebooksForActivityBucket(
  bucket: "today" | "yesterday" | "earlier",
): NotebookFixture[] {
  if (bucket === "today") {
    return sortedNotebooks.filter((notebook) => notebook.minutesAgo < 720);
  }
  if (bucket === "yesterday") {
    return sortedNotebooks.filter(
      (notebook) => notebook.minutesAgo >= 720 && notebook.minutesAgo < 2200,
    );
  }
  return sortedNotebooks.filter((notebook) => notebook.minutesAgo >= 2200);
}
