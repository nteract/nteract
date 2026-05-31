import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { SupportedLanguage } from "@/components/editor/languages";
import {
  createNotebookViewModel,
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
  type NotebookShellCapabilities,
  type NotebookViewCell,
  type NotebookViewModel,
} from "@/components/notebook-shell";
import type {
  EnvSyncState,
  PyProjectDeps,
  PyProjectInfo,
  TrustInfo,
  TyposquatWarning,
} from "@/notebook-components/runtime-surface-types";
import { WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";

export type ElementsNotebookScenarioId =
  | "desktop-local-owner"
  | "cloud-public-viewer"
  | "cloud-editor"
  | "cloud-owner"
  | "agent-on-behalf"
  | "runtime-peer"
  | "system-schema"
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
  packageState: ElementsNotebookPackageState;
  trustState: ElementsNotebookTrustState;
  outputState: ElementsNotebookOutputState;
  variables: readonly ElementsNotebookVariable[];
  renderers: readonly ElementsNotebookRenderer[];
}

export interface ElementsNotebookPackageState {
  dependencies: readonly string[];
  requiresPython: string;
  syncState: EnvSyncState;
  pyprojectInfo: PyProjectInfo;
  pyprojectDeps: PyProjectDeps;
}

export interface ElementsNotebookTrustState {
  trustInfo: TrustInfo;
  typosquatWarnings: readonly TyposquatWarning[];
  approvalError: string | null;
}

export interface ElementsNotebookOutputState {
  json: Record<string, unknown>;
  traceback: unknown;
  outputAreaOutputs: readonly JupyterOutput[];
  widgetModels: readonly ElementsNotebookWidgetModel[];
  widgetOutputs: readonly JupyterOutput[];
  mimeFixtures: readonly ElementsNotebookMimeFixture[];
  siftParquetUrl: string;
  siftParquetRows: number;
  siftArrowStreamChunkUrl: string;
  siftArrowStreamManifest: {
    chunks: { url: string }[];
    complete: boolean;
  };
}

export interface ElementsNotebookWidgetModel {
  id: string;
  state: Record<string, unknown>;
}

export interface ElementsNotebookMimeFixture {
  label: string;
  data: Record<string, unknown>;
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
    source:
      "features = orders.assign(month=orders.date.dt.month)\nmodel.fit(features[columns], target)\npredictions = model.predict(features_holdout)",
    executionId: "execution-model-run",
    executionCount: 15,
    outputs: [
      {
        output_id: "output-model-run-stream",
        output_type: "stream",
        name: "stdout",
        text: "training fold=01 mae=8.91\nvalidating fold=02 mae=8.42",
      },
      {
        output_id: "output-model-run-result",
        output_type: "execute_result",
        execution_count: 15,
        data: {
          "text/plain": "MAE=8.42  MAPE=6.8%  Backtest=16 weeks",
        },
        metadata: {},
      },
    ],
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

const packageDependencies = ["pandas>=2", "polars", "plotly", "scikit-learn"];
const packageRequiresPython = ">=3.13";

const notebookMetadata = {
  runt: {
    uv: {
      dependencies: packageDependencies,
      "requires-python": packageRequiresPython,
    },
    pixi: {
      dependencies: ["numpy", "pandas"],
      pypi_dependencies: ["altair", "great-tables"],
      channels: ["conda-forge"],
      python: packageRequiresPython,
    },
    deno: {
      permissions: ["net", "read"],
      flexible_npm_imports: true,
    },
  },
};

const viewModel = createNotebookViewModel(notebookCells, {
  resolveLanguage: resolveElementsNotebookLanguage,
  metadata: notebookMetadata,
});

const packageState: ElementsNotebookPackageState = {
  dependencies: packageDependencies,
  requiresPython: packageRequiresPython,
  syncState: { status: "dirty", added: ["altair"], removed: [] },
  pyprojectInfo: {
    path: "/Users/kyle/notebooks/pyproject.toml",
    relative_path: "pyproject.toml",
    project_name: "mathnet",
    has_dependencies: true,
    dependency_count: 4,
    has_dev_dependencies: true,
    requires_python: ">=3.13",
    has_venv: true,
  },
  pyprojectDeps: {
    path: "/Users/kyle/notebooks/pyproject.toml",
    relative_path: "pyproject.toml",
    project_name: "mathnet",
    dependencies: ["pandas>=2", "polars", "plotly", "scikit-learn"],
    dev_dependencies: ["pytest", "ruff"],
    requires_python: ">=3.13",
    index_url: null,
  },
};

const trustState: ElementsNotebookTrustState = {
  trustInfo: {
    status: "untrusted",
    uv_dependencies: ["pandas>=2", "reqeusts[security]>=2.0"],
    approved_uv_dependencies: ["pandas>=2"],
    conda_dependencies: ["python=3.13", "scikit-learn"],
    approved_conda_dependencies: [],
    conda_channels: ["conda-forge"],
    approved_conda_channels: ["conda-forge"],
    pixi_dependencies: ["numpy"],
    approved_pixi_dependencies: [],
    pixi_pypi_dependencies: ["polars"],
    approved_pixi_pypi_dependencies: [],
    pixi_channels: ["conda-forge"],
    approved_pixi_channels: ["conda-forge"],
  },
  typosquatWarnings: [
    {
      package: "reqeusts",
      similar_to: "requests",
      distance: 2,
    },
  ],
  approvalError: "Typosquat check completed with one warning. Review before trusting.",
};

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

const jsonOutputFixture = {
  run: {
    id: "forecast-042",
    status: "complete",
    metrics: {
      mae: 8.42,
      mape: 0.068,
      backtestWeeks: 16,
    },
  },
  artifacts: ["forecast.parquet", "diagnostics.json"],
};

const modelCodeCell = getElementsNotebookPrimaryCodeCell();
const [modelFeatureLine, modelFitLine, modelPredictLine] = modelCodeCell.source.split("\n");
const tracebackOutputFixture = {
  ename: "ValueError",
  evalue: "feature matrix contains null values",
  language: modelCodeCell.language ?? "python",
  text: `ValueError: feature matrix contains null values
  at cell ${modelCodeCell.id} line 3`,
  execution: {
    execution_id: modelCodeCell.executionId ?? "execution-model-run",
    cell_id: modelCodeCell.id,
    execution_count: modelCodeCell.executionCount,
  },
  frames: [
    {
      filename: `cell://${modelCodeCell.id}`,
      lineno: 3,
      name: "<module>",
      execution_id: modelCodeCell.executionId ?? "execution-model-run",
      cell_id: modelCodeCell.id,
      execution_count: modelCodeCell.executionCount,
      lines: [
        { lineno: 1, source: modelFeatureLine ?? "" },
        { lineno: 2, source: modelFitLine ?? "" },
        { lineno: 3, source: modelPredictLine ?? "", highlight: true },
      ],
    },
    {
      filename: "/workspace/forecasting/model.py",
      lineno: 88,
      name: "predict",
      library: true,
      lines: [
        { lineno: 86, source: "def predict(self, frame):" },
        { lineno: 87, source: "    if frame.isna().any().any():" },
        {
          lineno: 88,
          source: "        raise ValueError('feature matrix contains null values')",
          highlight: true,
        },
      ],
    },
  ],
};

const outputWidgetModels: readonly ElementsNotebookWidgetModel[] = [
  {
    id: "output-widget-summary",
    state: {
      _model_name: "HTMLModel",
      _model_module: "@jupyter-widgets/controls",
      value: "<strong>Widget output</strong> <span>rendered through OutputArea</span>",
    },
  },
  {
    id: "output-widget-threshold",
    state: {
      _model_name: "IntSliderModel",
      _model_module: "@jupyter-widgets/controls",
      description: "threshold",
      value: 42,
      min: 0,
      max: 100,
      step: 1,
      readout: true,
      orientation: "horizontal",
      disabled: false,
    },
  },
  {
    id: "output-widget-progress-style",
    state: {
      _model_name: "ProgressStyleModel",
      _model_module: "@jupyter-widgets/controls",
      bar_color: "#10b981",
    },
  },
  {
    id: "output-widget-progress",
    state: {
      _model_name: "IntProgressModel",
      _model_module: "@jupyter-widgets/controls",
      description: "complete",
      value: 68,
      min: 0,
      max: 100,
      bar_style: "success",
      orientation: "horizontal",
      style: "IPY_MODEL_output-widget-progress-style",
    },
  },
  {
    id: "output-widget-panel",
    state: {
      _model_name: "VBoxModel",
      _model_module: "@jupyter-widgets/controls",
      children: [
        "IPY_MODEL_output-widget-summary",
        "IPY_MODEL_output-widget-threshold",
        "IPY_MODEL_output-widget-progress",
      ],
      box_style: "success",
    },
  },
];

const siftParquetUrl =
  "https://huggingface.co/datasets/mstz/heart_failure/resolve/refs%2Fconvert%2Fparquet/death/train/0000.parquet";
const siftParquetRows = 8;
const siftArrowStreamChunkUrl = "/fixtures/sift-polars-utf8view.arrow";
const siftArrowStreamManifest = {
  chunks: [{ url: siftArrowStreamChunkUrl }],
  complete: true,
};

const outputState: ElementsNotebookOutputState = {
  json: jsonOutputFixture,
  traceback: tracebackOutputFixture,
  outputAreaOutputs: [
    ...(modelCodeCell.outputs.length > 0
      ? modelCodeCell.outputs
      : [
          {
            output_id: "output-area-stream",
            output_type: "stream",
            name: "stdout",
            text: "training fold=01 mae=8.91\nvalidating fold=02 mae=8.42\n",
          } satisfies JupyterOutput,
        ]),
    {
      output_id: "output-area-html",
      output_type: "display_data",
      data: {
        "text/html": "<strong>unsafe HTML fixture</strong>",
        "text/plain": "unsafe HTML fixture",
      },
      metadata: {},
    },
    {
      output_id: "output-area-parquet",
      output_type: "display_data",
      data: {
        "application/vnd.apache.parquet": {
          url: siftParquetUrl,
          rows: siftParquetRows,
        },
        "text/plain": "heart_failure parquet fixture",
      },
      metadata: {},
    },
  ],
  widgetModels: outputWidgetModels,
  widgetOutputs: [
    {
      output_id: "output-area-widget-view",
      output_type: "display_data",
      data: {
        [WIDGET_VIEW_MIME]: { model_id: "output-widget-panel" },
        "text/plain": "VBox(children=(HTML(), IntSlider(), IntProgress()))",
      },
      metadata: {},
    },
  ],
  mimeFixtures: [
    {
      label: "Rich traceback beats text",
      data: {
        "text/plain": "ValueError: feature matrix contains null values",
        "application/vnd.nteract.traceback+json": tracebackOutputFixture,
      },
    },
    {
      label: "HTML requires isolation",
      data: {
        "text/html": "<table><tr><td>8.42</td></tr></table>",
        "text/plain": "MAE 8.42",
      },
    },
    {
      label: "Preview-only text is skipped",
      data: {
        "text/llm+plain": "internal model preview",
        "text/plain": "visible fallback",
      },
    },
    {
      label: "Widget view selects widget MIME",
      data: {
        [WIDGET_VIEW_MIME]: { model_id: "output-widget-panel" },
        "text/plain": "VBox(children=...)",
      },
    },
    {
      label: "Arrow stream manifest selects Sift",
      data: {
        "application/vnd.nteract.arrow-stream-manifest+json": siftArrowStreamManifest,
        "text/plain": "Arrow stream manifest",
      },
    },
    {
      label: "Structured JSON stays inspectable",
      data: {
        "application/json": jsonOutputFixture,
        "text/plain": JSON.stringify(jsonOutputFixture),
      },
    },
  ],
  siftParquetUrl,
  siftParquetRows,
  siftArrowStreamChunkUrl,
  siftArrowStreamManifest,
};

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
      canEditStructure: true,
      canRequestEdit: false,
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
      runtime: {
        canWriteRuntimeState: true,
        connected: true,
        source: "local",
        actorLabel: "local:kyle/runtime:python",
        identityLabel: "Kyle",
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
      canEditStructure: false,
      canRequestEdit: false,
      canExecute: false,
      canToggleCode: true,
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
      runtime: {
        canWriteRuntimeState: false,
        connected: false,
        source: "cloud",
        actorLabel: null,
        identityLabel: null,
      },
    },
  }),
  "cloud-editor": createScenario({
    id: "cloud-editor",
    title: "Cloud editor",
    eyebrow: "hosted fixture",
    summary:
      "Authenticated cloud editor access where markdown can change but code cells, structure, packages, sharing, and execution stay gated.",
    runtimeLabel: "Cloud notebook · runtime detached",
    packageSummary: "visible · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "editor",
        source: "cloud",
        isPublic: false,
        actorLabel: "cloud:morgan",
        identityLabel: "Morgan",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: false,
        connected: false,
        source: "cloud",
        actorLabel: null,
        identityLabel: null,
      },
    },
  }),
  "cloud-owner": createScenario({
    id: "cloud-owner",
    title: "Cloud owner",
    eyebrow: "hosted fixture",
    summary:
      "Authenticated cloud owner access with markdown and code-cell source edits plus sharing, while structure, packages, and execution remain host-gated.",
    runtimeLabel: "Cloud notebook · runtime detached",
    packageSummary: "visible · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: false,
      canRequestEdit: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
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
      runtime: {
        canWriteRuntimeState: false,
        connected: false,
        source: "cloud",
        actorLabel: null,
        identityLabel: null,
      },
    },
  }),
  "agent-on-behalf": createScenario({
    id: "agent-on-behalf",
    title: "Agent on behalf",
    eyebrow: "agency fixture",
    summary:
      "An authenticated agent actor working through the cloud shell on behalf of a notebook owner.",
    runtimeLabel: "Cloud notebook - agent session active",
    packageSummary: "visible - 8 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: false,
      canRequestEdit: false,
      canExecute: true,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "editor",
        source: "cloud",
        isPublic: false,
        actorLabel: "agent:codex/on-behalf-of:kyle",
        identityLabel: "Kyle",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: false,
        connected: false,
        source: "cloud",
        actorLabel: null,
        identityLabel: null,
      },
    },
  }),
  "runtime-peer": createScenario({
    id: "runtime-peer",
    title: "Runtime peer",
    eyebrow: "runtime fixture",
    summary:
      "A runtime operator authors execution and output state without becoming a notebook editor.",
    runtimeLabel: "JupyterHub runtime · connected",
    packageSummary: "visible · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: false,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "viewer",
        source: "cloud",
        isPublic: false,
        actorLabel: "user:anaconda:alice/runtime:jupyterhub",
        identityLabel: "Alice",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: true,
        connected: true,
        source: "cloud",
        actorLabel: "user:anaconda:alice/runtime:jupyterhub",
        identityLabel: "Alice",
      },
    },
  }),
  "system-schema": createScenario({
    id: "system-schema",
    title: "System schema actor",
    eyebrow: "system fixture",
    summary:
      "Schema and system-authored changes remain attributable without appearing as human collaborators.",
    runtimeLabel: "System · schema seed",
    packageSummary: "not applicable",
    capabilities: {
      canRead: true,
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: false,
      canExecute: false,
      canToggleCode: false,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "viewer",
        source: "fixture",
        isPublic: false,
        actorLabel: "system/schema:notebook:v5",
        identityLabel: null,
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: false,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: false,
        connected: false,
        source: "fixture",
        actorLabel: null,
        identityLabel: null,
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
      canEditStructure: true,
      canRequestEdit: false,
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
      runtime: {
        canWriteRuntimeState: false,
        connected: false,
        source: "fixture",
        actorLabel: null,
        identityLabel: null,
      },
    },
  }),
};

export function getElementsNotebookScenario(id: ElementsNotebookScenarioId) {
  return elementsNotebookScenarios[id];
}

export function getElementsNotebookPrimaryCodeCell(
  cells: readonly NotebookViewCell[] = notebookCells,
) {
  const cell =
    cells.find((item) => item.id === "cell-model-code") ??
    cells.find((item) => item.cellType === "code");
  if (!cell) {
    throw new Error("Elements notebook scenario needs at least one code cell.");
  }
  return cell;
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
  const projectedCapabilities: NotebookShellCapabilities = {
    ...capabilities,
    access: {
      ...capabilities.access,
      actor:
        capabilities.access.actor ??
        notebookActorProjectionFromAccess(capabilities.access, capabilities.auth),
    },
    runtime: {
      ...capabilities.runtime,
      actor:
        capabilities.runtime.actor ??
        notebookActorProjectionFromRuntime(capabilities.runtime, capabilities.auth),
    },
  };

  return {
    id,
    title,
    eyebrow,
    summary,
    capabilities: projectedCapabilities,
    cells: notebookCells,
    viewModel,
    runtimeLabel,
    packageSummary,
    packageState,
    trustState,
    outputState,
    variables,
    renderers,
  };
}
