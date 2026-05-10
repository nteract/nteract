export interface Fixture {
  label: string;
  mimeType: string;
  data: unknown;
  widgetModels?: WidgetModelFixture[];
}

export interface WidgetModelFixture {
  commId: string;
  targetName: string;
  state: Record<string, unknown>;
  bufferPaths?: string[][];
}

const buckarooAnywidgetFixtureUrl = new URL("./buckaroo-anywidget-fixture.ts", import.meta.url).href;

export const fixtures: Fixture[] = [
  {
    label: "Plain text",
    mimeType: "text/plain",
    data: "Hello from the renderer test app.\nThis is a second line.",
  },
  {
    label: "HTML",
    mimeType: "text/html",
    data: '<h2 style="color: steelblue;">HTML Output</h2><p>Rendered inside an isolated iframe.</p>',
  },
  {
    label: "JSON",
    mimeType: "application/json",
    data: JSON.stringify(
      { name: "renderer-test", version: "1.0.0", features: ["iframe", "plugins", "security"] },
      null,
      2,
    ),
  },
  {
    label: "SVG",
    mimeType: "image/svg+xml",
    data: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" rx="10" fill="#4f46e5"/><text x="100" y="55" text-anchor="middle" fill="white" font-family="system-ui" font-size="16">SVG Output</text></svg>',
  },
  {
    label: "Markdown (plugin)",
    mimeType: "text/markdown",
    data: "# Markdown Plugin\n\nThis is rendered by the **markdown renderer plugin**.\n\n- Item 1\n- Item 2\n- Item 3\n\n```python\nprint('hello')\n```\n",
  },
  {
    label: "Plotly (plugin)",
    mimeType: "application/vnd.plotly.v1+json",
    data: JSON.stringify({
      data: [
        {
          x: [1, 2, 3, 4, 5],
          y: [2, 6, 3, 8, 5],
          type: "scatter",
          mode: "lines+markers",
          name: "Test Series",
        },
      ],
      layout: {
        title: "Plotly Plugin Test",
        width: 500,
        height: 300,
      },
    }),
  },
  {
    label: "Buckaroo anywidget table",
    mimeType: "application/vnd.jupyter.widget-view+json",
    data: { model_id: "buckaroo-table-model" },
    widgetModels: [
      {
        commId: "buckaroo-table-model",
        targetName: "jupyter.widget",
        state: {
          _model_name: "AnyModel",
          _model_module: "anywidget",
          _view_name: "AnyView",
          _view_module: "anywidget",
          _esm: buckarooAnywidgetFixtureUrl,
          df_data_dict: {
            main: [
              { index: 0, name: "Alice", age: 25, score: 85.5 },
              { index: 1, name: "Bob", age: 28, score: 92.3 },
              { index: 2, name: "Charlie", age: 31, score: 76.1 },
            ],
            all_stats: [
              { index: "dtype", name: "object", age: "int64", score: "float64" },
              { index: "count", name: 3, age: 3, score: 3 },
              { index: "min", name: "Alice", age: 25, score: 76.1 },
              { index: "max", name: "Charlie", age: 31, score: 92.3 },
            ],
          },
          df_display_args: {
            main: {
              data_key: "main",
              summary_stats_key: "all_stats",
              df_viewer_config: {
                pinned_rows: [],
                column_config: [
                  { col_name: "name", displayer_args: { displayer: "obj" } },
                  { col_name: "age", displayer_args: { displayer: "integer", min_digits: 1, max_digits: 5 } },
                  {
                    col_name: "score",
                    displayer_args: { displayer: "float", min_fraction_digits: 1, max_fraction_digits: 2 },
                  },
                ],
                component_config: { dfvHeight: 260 },
              },
            },
          },
          df_meta: { total_rows: 3, columns: 3, filtered_rows: 3, rows_shown: 3 },
          operations: [],
          operation_results: {
            transformed_df: {
              dfviewer_config: { pinned_rows: [], column_config: [] },
              data: [],
            },
            generated_py_code: "# renderer-test fixture",
          },
          command_config: { argspecs: {}, defaultArgs: {} },
          buckaroo_state: {
            sampled: false,
            auto_clean: false,
            quick_command_args: {},
            post_processing: false,
            df_display: "main",
            show_commands: false,
          },
          buckaroo_options: {
            sampled: [],
            auto_clean: [],
            post_processing: [],
            df_display: ["main"],
            show_commands: [],
          },
        },
      },
    ],
  },
];
