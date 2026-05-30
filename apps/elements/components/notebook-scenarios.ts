import type { SupportedLanguage } from "@/components/editor/languages";
import {
  createNotebookViewModel,
  type NotebookShellCapabilities,
  type NotebookViewCell,
  type NotebookViewModel,
} from "@/components/notebook-shell";

export type ElementsNotebookScenarioId =
  | "desktop-local-owner"
  | "cloud-public-viewer"
  | "cloud-editor"
  | "runtime-unavailable";

export interface ElementsNotebookScenario {
  id: ElementsNotebookScenarioId;
  title: string;
  eyebrow: string;
  summary: string;
  capabilities: NotebookShellCapabilities;
  cells: readonly NotebookViewCell[];
  viewModel: NotebookViewModel;
  runtimeLabel: string;
  packageSummary: string;
  dependencies: readonly string[];
  variables: readonly ElementsNotebookVariable[];
  renderers: readonly ElementsNotebookRenderer[];
}

export interface ElementsNotebookVariable {
  name: string;
  type: string;
  value: string;
}

export interface ElementsNotebookRenderer {
  name: string;
  state: string;
}

const supportedLanguages = new Set<SupportedLanguage>([
  "python",
  "ipython",
  "markdown",
  "sql",
  "html",
  "javascript",
  "typescript",
  "json",
  "yaml",
  "toml",
  "plain",
]);

const notebookCells: readonly NotebookViewCell[] = [
  {
    id: "cell-load-data",
    cellType: "markdown",
    language: "markdown",
    source: "# Load data\n\nImport the order history and make dates explicit.",
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
  },
  {
    id: "cell-load-code",
    cellType: "code",
    language: "python",
    source: "orders = pandas.read_csv('orders.csv', parse_dates=['date'])",
    executionId: "execution-load-data",
    executionCount: 12,
    outputs: [
      {
        output_id: "output-load-data",
        output_type: "stream",
        name: "stdout",
        text: "loaded 2,148 orders\n",
      },
    ],
    metadata: {},
  },
  {
    id: "cell-clean-columns",
    cellType: "markdown",
    language: "markdown",
    source: "## Clean columns\n\nNormalize status values before joining lookup tables.",
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
  },
  {
    id: "cell-clean-code",
    cellType: "code",
    language: "python",
    source: "orders = clean_columns(orders)",
    executionId: "execution-clean-columns",
    executionCount: 13,
    outputs: [],
    metadata: {},
  },
  {
    id: "cell-explore-shape",
    cellType: "markdown",
    language: "markdown",
    source: "# Explore shape\n\nCheck the model-ready feature table.",
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
  },
  {
    id: "cell-shape-output",
    cellType: "code",
    language: "python",
    source: "features.shape",
    executionId: "execution-feature-shape",
    executionCount: 14,
    outputs: [
      {
        output_id: "output-feature-shape",
        output_type: "execute_result",
        execution_count: 14,
        data: {
          "text/plain": "(2148, 32)",
        },
        metadata: {},
      },
    ],
    metadata: {},
  },
  {
    id: "cell-model-run",
    cellType: "markdown",
    language: "markdown",
    source: "# Model run\n\nTrain the weekly backtest model.",
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
  },
  {
    id: "cell-model-code",
    cellType: "code",
    language: "python",
    source: "model.fit(features[columns], target)",
    executionId: "execution-model-run",
    executionCount: null,
    outputs: [],
    metadata: {},
  },
  {
    id: "cell-findings",
    cellType: "markdown",
    language: "markdown",
    source: "## Findings\n\nSummarize the backtest before export.",
    executionId: null,
    executionCount: null,
    outputs: [],
    metadata: {},
  },
];

const viewModel = createNotebookViewModel(notebookCells, {
  resolveLanguage: resolveElementsNotebookLanguage,
});

const dependencies = ["pandas>=2", "polars", "plotly", "scikit-learn"] as const;

const variables: readonly ElementsNotebookVariable[] = [
  { name: "orders", type: "DataFrame", value: "2,148 rows x 18 columns" },
  { name: "features", type: "DataFrame", value: "2,148 rows x 32 columns" },
  { name: "model", type: "Pipeline", value: "StandardScaler -> Ridge" },
  { name: "mae", type: "float", value: "8.42" },
];

const renderers: readonly ElementsNotebookRenderer[] = [
  { name: "text/html", state: "isolated" },
  { name: "application/vnd.apache.arrow.file", state: "sift" },
  { name: "image/png", state: "inline" },
];

export const elementsNotebookScenarios: Record<
  ElementsNotebookScenarioId,
  ElementsNotebookScenario
> = {
  "desktop-local-owner": createScenario({
    id: "desktop-local-owner",
    title: "Desktop local owner",
    eyebrow: "local fixture",
    summary:
      "Local desktop editing with packages and execution available, backed by inert catalog callbacks.",
    runtimeLabel: "Python · local runtime ready",
    packageSummary: "uv:inline · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canExecute: true,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: true,
      canManageSharing: false,
      access: {
        level: "owner",
        source: "local",
        isPublic: false,
        actorLabel: "local:kyle",
        identityLabel: "Kyle",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: false,
        needsAttention: false,
      },
    },
  }),
  "cloud-public-viewer": createScenario({
    id: "cloud-public-viewer",
    title: "Cloud public viewer",
    eyebrow: "hosted fixture",
    summary:
      "Published read-only access with outline, outputs, and packages visible but no editing or execution.",
    runtimeLabel: "Published artifact · no kernel",
    packageSummary: "read-only · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: false,
      canEditCells: false,
      canExecute: false,
      canToggleCode: false,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "viewer",
        source: "cloud",
        isPublic: true,
        actorLabel: "public viewer",
        identityLabel: null,
      },
      auth: {
        canSignIn: true,
        canUseAuthenticatedIdentity: false,
        needsAttention: false,
      },
    },
  }),
  "cloud-editor": createScenario({
    id: "cloud-editor",
    title: "Cloud editor",
    eyebrow: "hosted fixture",
    summary:
      "Authenticated cloud editing where the shell can edit cells and share, while execution still waits for a runtime.",
    runtimeLabel: "Cloud notebook · runtime detached",
    packageSummary: "managed · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: true,
      canManageSharing: true,
      access: {
        level: "owner",
        source: "cloud",
        isPublic: false,
        actorLabel: "cloud:kyle",
        identityLabel: "Kyle",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
    },
  }),
  "runtime-unavailable": createScenario({
    id: "runtime-unavailable",
    title: "Runtime unavailable",
    eyebrow: "runtime fixture",
    summary:
      "Readable notebook state with package metadata present but execution and package mutation disabled.",
    runtimeLabel: "Python · runtime unavailable",
    packageSummary: "blocked · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "editor",
        source: "fixture",
        isPublic: false,
        actorLabel: "fixture editor",
        identityLabel: "Elements fixture",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: false,
        needsAttention: true,
      },
    },
  }),
};

export function getElementsNotebookScenario(id: ElementsNotebookScenarioId) {
  return elementsNotebookScenarios[id];
}

export function resolveElementsNotebookLanguage(
  language: string | null | undefined,
): SupportedLanguage | null {
  if (!language) return null;
  return supportedLanguages.has(language as SupportedLanguage)
    ? (language as SupportedLanguage)
    : "plain";
}

function createScenario({
  id,
  title,
  eyebrow,
  summary,
  runtimeLabel,
  packageSummary,
  capabilities,
}: {
  id: ElementsNotebookScenarioId;
  title: string;
  eyebrow: string;
  summary: string;
  runtimeLabel: string;
  packageSummary: string;
  capabilities: NotebookShellCapabilities;
}): ElementsNotebookScenario {
  return {
    id,
    title,
    eyebrow,
    summary,
    capabilities,
    cells: notebookCells,
    viewModel,
    runtimeLabel,
    packageSummary,
    dependencies,
    variables,
    renderers,
  };
}
