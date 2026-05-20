export interface Fixture {
  label: string;
  mimeType: string;
  data: unknown;
  outputs?: FixtureOutput[];
  expectedText?: string[];
}

export interface FixtureOutput {
  mimeType: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export const fixtures: Fixture[] = [
  {
    label: "Plain text",
    mimeType: "text/plain",
    data: "Hello from the renderer test app.\nThis is a second line.",
    expectedText: ["Hello from the renderer test app.", "This is a second line."],
  },
  {
    label: "HTML",
    mimeType: "text/html",
    data: '<h2 style="color: steelblue;">HTML Output</h2><p>Rendered inside an isolated iframe.</p>',
    expectedText: ["HTML Output", "Rendered inside an isolated iframe."],
  },
  {
    label: "Pandas-like HTML table",
    mimeType: "text/html",
    data: [
      "<table>",
      "<thead><tr><th></th><th>a</th><th>b</th></tr></thead>",
      "<tbody><tr><th>0</th><td>1</td><td>3</td></tr><tr><th>1</th><td>2</td><td>4</td></tr></tbody>",
      "</table>",
    ].join(""),
    expectedText: ["a", "b", "1", "4"],
  },
  {
    label: "Stream plus rich output batch",
    mimeType: "application/vnd.nteract.fixture-batch+json",
    data: null,
    outputs: [
      {
        mimeType: "text/plain",
        data: "stream before",
        metadata: { streamName: "stdout" },
      },
      {
        mimeType: "text/html",
        data: "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>3</td></tr><tr><td>2</td><td>4</td></tr></tbody></table>",
      },
    ],
    expectedText: ["stream before", "a", "b", "4"],
  },
  {
    label: "JSON",
    mimeType: "application/json",
    data: JSON.stringify(
      { name: "renderer-test", version: "1.0.0", features: ["iframe", "plugins", "security"] },
      null,
      2,
    ),
    expectedText: ["renderer-test", "features", "security"],
  },
  {
    label: "SVG",
    mimeType: "image/svg+xml",
    data: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" rx="10" fill="#4f46e5"/><text x="100" y="55" text-anchor="middle" fill="white" font-family="system-ui" font-size="16">SVG Output</text></svg>',
    expectedText: ["SVG Output"],
  },
  {
    label: "Markdown (plugin)",
    mimeType: "text/markdown",
    data: "# Markdown Plugin\n\nThis is rendered by the **markdown renderer plugin**.\n\n- Item 1\n- Item 2\n- Item 3\n\n```python\nprint('hello')\n```\n",
    expectedText: ["Markdown Plugin", "Item 1", "print('hello')"],
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
];

export function getFixtureOutputs(fixture: Fixture): FixtureOutput[] {
  return fixture.outputs ?? [{ mimeType: fixture.mimeType, data: fixture.data }];
}

export const markdownFixture = fixtures.find((fixture) => fixture.mimeType === "text/markdown")!;
