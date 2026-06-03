import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { SupportedLanguage } from "@/components/editor/languages";
import {
  createNotebookEnvironmentSurface,
  type NotebookEnvironmentSurface,
  type NotebookPackageSyncStatus,
  type NotebookTrustStatus,
} from "@/components/environment";
import {
  createNotebookViewModel,
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
  type NotebookActorProjection,
  type NotebookNoticeTone,
  type NotebookShellCapabilities,
  type NotebookViewCell,
  type NotebookViewModel,
} from "@/components/notebook";
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
  | "desktop-read-only"
  | "desktop-remote-room"
  | "cloud-viewer"
  | "cloud-public-viewer"
  | "cloud-editor"
  | "cloud-owner"
  | "agent-on-behalf"
  | "credential-attention"
  | "multi-operator"
  | "mixed-idp-room"
  | "runtime-peer"
  | "system-schema"
  | "runtime-unavailable"
  | "untrusted-dependencies";

export interface ElementsNotebookScenario {
  id: ElementsNotebookScenarioId;
  title: string;
  eyebrow: string;
  summary: string;
  sourceFacts: readonly ElementsNotebookSourceFact[];
  hostBoundaries: readonly ElementsNotebookHostBoundary[];
  capabilities: NotebookShellCapabilities;
  environment: NotebookEnvironmentSurface;
  cells: readonly NotebookViewCell[];
  viewModel: NotebookViewModel;
  runtimeLabel: string;
  packageSummary: string;
  packageState: ElementsNotebookPackageState;
  trustState: ElementsNotebookTrustState;
  outputState: ElementsNotebookOutputState;
  notices: readonly ElementsNotebookNotice[];
  variables: readonly ElementsNotebookVariable[];
  renderers: readonly ElementsNotebookRenderer[];
}

export interface ElementsNotebookSourceFact {
  label: string;
  value: string;
}

export interface ElementsNotebookHostBoundary {
  surface: string;
  sharedSurface: string;
  hostAuthority: string;
}

export interface ElementsNotebookNotice {
  tone: NotebookNoticeTone;
  title: string;
  body: string;
  details: string;
  actionLabel: string | null;
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

const desktopOwnerActor = actorProjection({
  actorLabel: "local:kyle/desktop:app",
  principalId: "local:kyle",
  principalLabel: "Kyle",
  provider: "local",
  namespace: "kyle",
  operatorId: "desktop:app",
  operatorKind: "desktop",
  operatorLabel: "Desktop",
  scope: "owner",
});

const desktopRuntimeActor = actorProjection({
  actorLabel: "local:kyle/runtime:python",
  principalId: "local:kyle",
  principalLabel: "Kyle",
  provider: "local",
  namespace: "kyle",
  operatorId: "runtime:python",
  operatorKind: "runtime",
  operatorLabel: "Python",
  scope: "runtime_peer",
});

const desktopReadOnlyActor = actorProjection({
  actorLabel: "local:kyle/desktop:readonly-file",
  principalId: "local:kyle",
  principalLabel: "Kyle",
  provider: "local",
  namespace: "kyle",
  operatorId: "desktop:readonly-file",
  operatorKind: "desktop",
  operatorLabel: "Desktop",
  scope: "viewer",
});

const desktopRemoteActor = actorProjection({
  actorLabel: "user:anaconda:kyle/desktop:app",
  principalId: "user:anaconda:kyle",
  principalLabel: "Kyle",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "desktop:app",
  operatorKind: "desktop",
  operatorLabel: "Desktop",
  scope: "editor",
});

const publicViewerActor = actorProjection({
  actorLabel: "anonymous:public/browser:viewer",
  principalId: "anonymous:public",
  principalLabel: "Public viewer",
  provider: "anonymous",
  namespace: "public",
  operatorId: "browser:viewer",
  operatorKind: "browser",
  operatorLabel: "Browser",
  scope: "viewer",
});

const cloudViewerActor = actorProjection({
  actorLabel: "user:anaconda:riley/browser:cloud",
  principalId: "user:anaconda:riley",
  principalLabel: "Riley",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "browser:cloud",
  operatorKind: "browser",
  operatorLabel: "Browser",
  scope: "viewer",
});

const cloudEditorActor = actorProjection({
  actorLabel: "user:anaconda:morgan/browser:cloud",
  principalId: "user:anaconda:morgan",
  principalLabel: "Morgan",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "browser:cloud",
  operatorKind: "browser",
  operatorLabel: "Browser",
  scope: "editor",
});

const cloudOwnerActor = actorProjection({
  actorLabel: "user:anaconda:kyle/browser:cloud",
  principalId: "user:anaconda:kyle",
  principalLabel: "Kyle",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "browser:cloud",
  operatorKind: "browser",
  operatorLabel: "Browser",
  scope: "owner",
});

const cloudExpiredActor = actorProjection({
  actorLabel: "user:anaconda:kyle/browser:cloud",
  principalId: "user:anaconda:kyle",
  principalLabel: "Kyle",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "browser:cloud",
  operatorKind: "browser",
  operatorLabel: "Browser",
  scope: "viewer",
});

const codexAgentActor = actorProjection({
  actorLabel: "user:anaconda:kyle/agent:codex:s1",
  principalId: "user:anaconda:kyle",
  principalLabel: "Kyle",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "agent:codex:s1",
  operatorKind: "agent",
  operatorLabel: "Codex",
  scope: "editor",
});

const jupyterHubRuntimeActor = actorProjection({
  actorLabel: "user:anaconda:alice/runtime:jupyterhub",
  principalId: "user:anaconda:alice",
  principalLabel: "Alice",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "runtime:jupyterhub",
  operatorKind: "runtime",
  operatorLabel: "JupyterHub",
  scope: "runtime_peer",
});

const kyleDesktopOperatorActor = actorProjection({
  actorLabel: "user:anaconda:kyle/desktop:app",
  principalId: "user:anaconda:kyle",
  principalLabel: "Kyle",
  provider: "anaconda",
  namespace: "anaconda",
  operatorId: "desktop:app",
  operatorKind: "desktop",
  operatorLabel: "Desktop",
  scope: "editor",
});

const mixedIdpActor = actorProjection({
  actorLabel: "hub:anaconda:avery/browser:cloud",
  principalId: "hub:anaconda:avery",
  principalLabel: "Avery",
  provider: "jupyterhub",
  namespace: "anaconda",
  operatorId: "browser:cloud",
  operatorKind: "browser",
  operatorLabel: "Browser",
  scope: "editor",
});

const systemSchemaActor = actorProjection({
  actorLabel: "system/schema:notebook:v5",
  principalId: "system",
  principalLabel: "System",
  operatorId: "schema:notebook:v5",
  operatorKind: "system",
  operatorLabel: "Notebook schema",
  scope: "viewer",
});

const elementsFixtureActor = actorProjection({
  actorLabel: "local:elements/browser:preview",
  principalId: "local:elements",
  principalLabel: "Elements fixture",
  provider: "local",
  namespace: "elements",
  operatorId: "browser:preview",
  operatorKind: "browser",
  operatorLabel: "Browser",
  scope: "editor",
});

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
        actorLabel: desktopOwnerActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopOwnerActor,
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: true,
        connected: true,
        source: "local",
        actorLabel: desktopRuntimeActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopRuntimeActor,
      },
    },
  }),
  "desktop-read-only": createScenario({
    id: "desktop-read-only",
    title: "Desktop read-only",
    eyebrow: "local fixture",
    summary:
      "A local file that can be opened and inspected while filesystem/host permissions disable writes.",
    runtimeLabel: "Python · local runtime detached",
    runtimeStatus: "detached",
    packageSummary: "read-only · 4 packages",
    syncLabel: "Local file is read only",
    syncStatus: "unavailable",
    trustLabel: "Trust state preserved",
    trustStatus: "trusted",
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
        source: "local",
        isPublic: false,
        actorLabel: desktopReadOnlyActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopReadOnlyActor,
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: false,
        connected: true,
        source: "local",
        actorLabel: desktopRuntimeActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopRuntimeActor,
      },
    },
  }),
  "desktop-remote-room": createScenario({
    id: "desktop-remote-room",
    title: "Desktop remote room",
    eyebrow: "remote fixture",
    summary:
      "Desktop renders a hosted notebook through the same shell while a local daemon uses a remote credential.",
    runtimeLabel: "Remote room · local daemon bridge",
    runtimeStatus: "detached",
    packageSummary: "visible · 4 packages",
    syncLabel: "Remote sync connected",
    syncStatus: "synced",
    trustLabel: "Trust managed by room",
    trustStatus: "trusted",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: false,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "editor",
        source: "cloud",
        isPublic: false,
        actorLabel: desktopRemoteActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopRemoteActor,
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: false,
        connected: true,
        source: "local",
        actorLabel: desktopRuntimeActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopRuntimeActor,
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
        actorLabel: publicViewerActor.actorLabel,
        identityLabel: null,
        actor: publicViewerActor,
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
  "cloud-viewer": createScenario({
    id: "cloud-viewer",
    title: "Cloud viewer",
    eyebrow: "hosted fixture",
    summary:
      "Authenticated viewer access where the notebook stays live and readable while edit access can be requested.",
    runtimeLabel: "Cloud notebook · runtime detached",
    packageSummary: "visible · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "viewer",
        source: "cloud",
        isPublic: false,
        actorLabel: cloudViewerActor.actorLabel,
        identityLabel: "Riley",
        actor: cloudViewerActor,
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
  "cloud-editor": createScenario({
    id: "cloud-editor",
    title: "Cloud editor",
    eyebrow: "hosted fixture",
    summary:
      "Authenticated cloud editor access where notebook content and cell structure can change while sharing, packages, and execution stay gated.",
    runtimeLabel: "Cloud notebook · runtime detached",
    packageSummary: "visible · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: true,
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
        actorLabel: cloudEditorActor.actorLabel,
        identityLabel: "Morgan",
        actor: cloudEditorActor,
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
      "Authenticated cloud owner access with notebook edits, cell structure, and sharing while packages and execution remain host-gated.",
    runtimeLabel: "Cloud notebook · runtime detached",
    packageSummary: "visible · 4 packages",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: true,
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
        actorLabel: cloudOwnerActor.actorLabel,
        identityLabel: "Kyle",
        actor: cloudOwnerActor,
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
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "editor",
        source: "cloud",
        isPublic: false,
        actorLabel: codexAgentActor.actorLabel,
        identityLabel: "Kyle",
        actor: codexAgentActor,
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
  "credential-attention": createScenario({
    id: "credential-attention",
    title: "Credential attention",
    eyebrow: "auth fixture",
    summary:
      "An expired hosted credential keeps the notebook readable but routes edit affordances to sign-in attention.",
    runtimeLabel: "Cloud notebook · credential expired",
    runtimeStatus: "unavailable",
    packageSummary: "read-only · 4 packages",
    syncLabel: "Reconnect required",
    syncStatus: "unavailable",
    trustLabel: "Trust state not required",
    trustStatus: "not_required",
    capabilities: {
      canRead: true,
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: true,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "viewer",
        source: "cloud",
        isPublic: false,
        actorLabel: cloudExpiredActor.actorLabel,
        identityLabel: "Kyle",
        actor: { ...cloudExpiredActor, status: "attention" },
      },
      auth: {
        canSignIn: true,
        canUseAuthenticatedIdentity: false,
        needsAttention: true,
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
  "multi-operator": createScenario({
    id: "multi-operator",
    title: "One principal, multiple operators",
    eyebrow: "identity fixture",
    summary:
      "A single user appears through desktop editing and a runtime operator without collapsing their attribution.",
    runtimeLabel: "JupyterHub runtime · connected",
    runtimeStatus: "ready",
    packageSummary: "visible · 4 packages",
    syncLabel: "Remote sync connected",
    syncStatus: "synced",
    trustLabel: "Trusted by Kyle",
    trustStatus: "trusted",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: false,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "editor",
        source: "cloud",
        isPublic: false,
        actorLabel: kyleDesktopOperatorActor.actorLabel,
        identityLabel: "Kyle",
        actor: kyleDesktopOperatorActor,
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
        actorLabel: jupyterHubRuntimeActor.actorLabel,
        identityLabel: "Kyle",
        actor: {
          ...jupyterHubRuntimeActor,
          principal: {
            ...jupyterHubRuntimeActor.principal,
            id: "user:anaconda:kyle",
            label: "Kyle",
          },
          actorLabel: "user:anaconda:kyle/runtime:jupyterhub",
        },
      },
    },
  }),
  "mixed-idp-room": createScenario({
    id: "mixed-idp-room",
    title: "Mixed IdP room",
    eyebrow: "identity fixture",
    summary:
      "A hosted room can display a JupyterHub principal beside Anaconda users through the same projection.",
    runtimeLabel: "Cloud notebook · runtime detached",
    runtimeStatus: "detached",
    packageSummary: "visible · 4 packages",
    syncLabel: "Remote sync connected",
    syncStatus: "synced",
    trustLabel: "Trust state not required",
    trustStatus: "not_required",
    capabilities: {
      canRead: true,
      canEditMarkdown: true,
      canEditCells: false,
      canEditStructure: false,
      canRequestEdit: false,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: {
        level: "editor",
        source: "cloud",
        isPublic: false,
        actorLabel: mixedIdpActor.actorLabel,
        identityLabel: "Avery",
        actor: mixedIdpActor,
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
        actorLabel: jupyterHubRuntimeActor.actorLabel,
        identityLabel: "Alice",
        actor: jupyterHubRuntimeActor,
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
        actorLabel: jupyterHubRuntimeActor.actorLabel,
        identityLabel: "Alice",
        actor: jupyterHubRuntimeActor,
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
        actorLabel: systemSchemaActor.actorLabel,
        identityLabel: null,
        actor: systemSchemaActor,
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
        actorLabel: elementsFixtureActor.actorLabel,
        identityLabel: "Elements fixture",
        actor: elementsFixtureActor,
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
  "untrusted-dependencies": createScenario({
    id: "untrusted-dependencies",
    title: "Untrusted dependencies",
    eyebrow: "trust fixture",
    summary:
      "Package metadata is visible, but dependency trust requires review before mutation or execution.",
    runtimeLabel: "Python · blocked by trust",
    runtimeStatus: "error",
    packageSummary: "uv:inline · 4 packages",
    syncLabel: "Package metadata has pending changes",
    syncStatus: "dirty",
    trustLabel: "Untrusted dependencies",
    trustStatus: "untrusted",
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
        level: "owner",
        source: "local",
        isPublic: false,
        actorLabel: desktopOwnerActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopOwnerActor,
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        canWriteRuntimeState: false,
        connected: true,
        source: "local",
        actorLabel: desktopRuntimeActor.actorLabel,
        identityLabel: "Kyle",
        actor: desktopRuntimeActor,
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
  runtimeStatus = null,
  packageSummary,
  packageSourceLabel = packageState.pyprojectInfo.relative_path,
  syncLabel = packageSyncLabel(packageState.syncState.status),
  syncStatus = notebookPackageSyncStatus(packageState.syncState.status),
  trustLabel = trustStatusLabel(trustState.trustInfo.status),
  trustStatus = notebookTrustStatus(trustState.trustInfo.status),
  capabilities,
}: {
  id: ElementsNotebookScenarioId;
  title: string;
  eyebrow: string;
  summary: string;
  runtimeLabel: string;
  runtimeStatus?: NotebookEnvironmentSurface["runtime"]["status"] | null;
  packageSummary: string;
  packageSourceLabel?: string | null;
  syncLabel?: string | null;
  syncStatus?: NotebookPackageSyncStatus | null;
  trustLabel?: string | null;
  trustStatus?: NotebookTrustStatus | null;
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
  const environment = createNotebookEnvironmentSurface({
    capabilities: projectedCapabilities,
    packages: viewModel.packages,
    runtimeLabel,
    runtimeStatus,
    packageSourceLabel,
    syncLabel,
    syncStatus,
    trustLabel,
    trustStatus,
  });

  return {
    id,
    title,
    eyebrow,
    summary,
    sourceFacts: scenarioSourceFacts(projectedCapabilities, {
      packageSummary,
      runtimeLabel,
      syncLabel,
      trustLabel,
    }),
    hostBoundaries: scenarioHostBoundaries(projectedCapabilities),
    capabilities: projectedCapabilities,
    environment,
    cells: notebookCells,
    viewModel,
    runtimeLabel,
    packageSummary,
    packageState,
    trustState,
    outputState,
    notices: scenarioNotices(projectedCapabilities, {
      runtimeLabel,
      syncLabel,
      trustLabel,
      trustStatus,
    }),
    variables,
    renderers,
  };
}

function scenarioSourceFacts(
  capabilities: NotebookShellCapabilities,
  {
    packageSummary,
    runtimeLabel,
    syncLabel,
    trustLabel,
  }: {
    packageSummary: string;
    runtimeLabel: string;
    syncLabel: string | null;
    trustLabel: string | null;
  },
): readonly ElementsNotebookSourceFact[] {
  const accessActor =
    capabilities.access.actor?.principal.label ??
    capabilities.access.identityLabel ??
    capabilities.access.actorLabel ??
    "no actor";
  const runtimeActor =
    capabilities.runtime.actor?.operator.label ??
    capabilities.runtime.identityLabel ??
    capabilities.runtime.actorLabel ??
    "no runtime actor";
  const mutationFacts = [
    capabilities.canEditMarkdown ? "markdown" : null,
    capabilities.canEditCells ? "cell source" : null,
    capabilities.canEditStructure ? "structure" : null,
    capabilities.canExecute ? "execute" : null,
    capabilities.canManagePackages ? "packages" : null,
    capabilities.canManageSharing ? "sharing" : null,
  ].filter((fact): fact is string => Boolean(fact));

  return [
    {
      label: "Access authority",
      value: `${capabilities.access.source}:${capabilities.access.level} for ${accessActor}`,
    },
    {
      label: "Interaction mode",
      value: capabilities.interaction
        ? `${capabilities.interaction.selectedMode} selected, ${capabilities.interaction.activeMode} active`
        : mutationFacts.length
          ? "editable from capabilities"
          : "view-only from capabilities",
    },
    {
      label: "Runtime authority",
      value: `${capabilities.runtime.source}, ${
        capabilities.runtime.connected ? "connected" : "detached"
      }, actor ${runtimeActor}`,
    },
    {
      label: "Environment facts",
      value: [runtimeLabel, packageSummary, syncLabel, trustLabel].filter(Boolean).join(" / "),
    },
    {
      label: "Mutable affordances",
      value: mutationFacts.length ? mutationFacts.join(", ") : "none",
    },
  ];
}

function scenarioHostBoundaries(
  capabilities: NotebookShellCapabilities,
): readonly ElementsNotebookHostBoundary[] {
  const accessAuthority = hostAuthorityLabel(capabilities.access.source);
  const runtimeAuthority = hostAuthorityLabel(capabilities.runtime.source);

  return [
    {
      surface: "Notebook rendering",
      sharedSurface: "NotebookDocumentShell, NotebookDocumentRail, NotebookView",
      hostAuthority: `${accessAuthority} supplies document bytes, access, and routing facts.`,
    },
    {
      surface: "Notebook writes",
      sharedSurface: "NotebookShellCapabilities plus shared mutation callbacks",
      hostAuthority: `${accessAuthority} still enforces markdown, source, structure, sharing, and package authority.`,
    },
    {
      surface: "Runtime and outputs",
      sharedSurface: "NotebookEnvironmentSurface, runtime actor projection, output frames",
      hostAuthority: `${runtimeAuthority} owns runtime lifecycle, runtime-state authorship, and output/blob authority.`,
    },
    {
      surface: "Identity display",
      sharedSurface: "NotebookActorProjection and NotebookToolbarIdentity",
      hostAuthority:
        "Host adapters enrich durable actor labels with structured principal/operator profile facts.",
    },
    {
      surface: "Host notices",
      sharedSurface: "NotebookNotice in the shared shell notice slot",
      hostAuthority:
        "Host adapters decide notice policy, diagnostics, and actions; the shell owns placement.",
    },
  ];
}

function scenarioNotices(
  capabilities: NotebookShellCapabilities,
  {
    runtimeLabel,
    syncLabel,
    trustLabel,
    trustStatus,
  }: {
    runtimeLabel: string;
    syncLabel: string | null;
    trustLabel: string | null;
    trustStatus: NotebookTrustStatus | null;
  },
): readonly ElementsNotebookNotice[] {
  const notices: ElementsNotebookNotice[] = [];

  if (capabilities.auth.needsAttention) {
    notices.push({
      tone: "warning",
      title: "Authentication needs attention",
      body: "The notebook remains readable while the host refreshes or replaces credentials.",
      details: `${hostAuthorityLabel(capabilities.access.source)} owns sign-in, token renewal, and reset actions.`,
      actionLabel: capabilities.auth.canSignIn ? "Sign in" : null,
    });
  }

  if (!capabilities.runtime.connected) {
    notices.push({
      tone: capabilities.canExecute ? "warning" : "info",
      title: "Runtime detached",
      body: "Notebook content, outputs, and package facts are rendered from the document projection.",
      details: `${runtimeLabel}. Runtime lifecycle remains a host adapter responsibility.`,
      actionLabel: capabilities.canExecute ? "Reconnect runtime" : null,
    });
  }

  if (trustStatus === "untrusted") {
    notices.push({
      tone: "warning",
      title: "Dependency trust requires review",
      body: "Package details stay visible, but execution and package mutation remain disabled.",
      details: trustLabel ?? "Untrusted dependencies",
      actionLabel: capabilities.canManagePackages ? "Review trust" : null,
    });
  }

  if (capabilities.canRead && !capabilities.canEditMarkdown && !capabilities.canEditCells) {
    notices.push({
      tone: "info",
      title: "Read-only notebook",
      body: "The shared notebook surface renders the same document projection without mutation affordances.",
      details: syncLabel ?? `${capabilities.access.source}:${capabilities.access.level}`,
      actionLabel: capabilities.canRequestEdit ? "Request edit" : null,
    });
  }

  if (capabilities.canManageSharing) {
    notices.push({
      tone: "success",
      title: "Owner controls available",
      body: "Sharing actions are available because the host confirmed owner access.",
      details: "ACL mutation stays with the hosted room authority.",
      actionLabel: "Manage sharing",
    });
  }

  return notices;
}

function hostAuthorityLabel(source: NotebookShellCapabilities["access"]["source"]): string {
  switch (source) {
    case "cloud":
      return "Hosted room and ACL service";
    case "local":
      return "Desktop daemon and local filesystem";
    case "fixture":
      return "Elements fixture host";
    default:
      return "Host adapter";
  }
}

function actorProjection({
  actorLabel,
  principalId,
  principalLabel,
  provider,
  namespace,
  operatorId,
  operatorKind,
  operatorLabel,
  scope,
}: {
  actorLabel: string;
  principalId: string;
  principalLabel: string;
  provider?: NonNullable<NotebookActorProjection["principal"]["source"]>["provider"];
  namespace?: string;
  operatorId: string;
  operatorKind: string;
  operatorLabel: string;
  scope: NonNullable<NotebookActorProjection["scope"]>;
}): NotebookActorProjection {
  return {
    actorLabel,
    principal: {
      id: principalId,
      label: principalLabel,
      ...(provider && namespace ? { source: { provider, namespace } } : {}),
    },
    operator: {
      id: operatorId,
      kind: operatorKind,
      label: operatorLabel,
    },
    scope,
  };
}

function packageSyncLabel(status: ElementsNotebookPackageState["syncState"]["status"]) {
  switch (status) {
    case "dirty":
      return "Package metadata has pending changes";
    case "not_running":
      return "Runtime is not running";
    case "not_uv_managed":
      return "Package metadata is outside uv";
    case "synced":
      return "Package metadata synced";
  }
}

function notebookPackageSyncStatus(
  status: ElementsNotebookPackageState["syncState"]["status"],
): NotebookPackageSyncStatus {
  return status;
}

function trustStatusLabel(status: ElementsNotebookTrustState["trustInfo"]["status"]) {
  switch (status) {
    case "trusted":
      return "Trusted";
    case "untrusted":
      return "Untrusted dependencies";
    case "no_dependencies":
      return "No dependency trust review needed";
  }
}

function notebookTrustStatus(
  status: ElementsNotebookTrustState["trustInfo"]["status"],
): NotebookTrustStatus {
  switch (status) {
    case "trusted":
      return "trusted";
    case "untrusted":
      return "untrusted";
    case "no_dependencies":
      return "not_required";
  }
}
