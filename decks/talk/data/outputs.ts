import type { NteractEmbeddableOutput } from "../../../src/components/isolated/embeddable-output";
import type {
  OutputBlobRef,
  OutputBlobResolver,
  OutputManifest,
} from "../../../src/components/isolated/output-manifest";

const blobFixtures: Record<string, { body: string; mediaType: string }> = {
  "demo-html-output": {
    mediaType: "text/html",
    body: `
<div class="blob-demo">
  <h3>Blob-backed output</h3>
  <p>This HTML came through the same manifest resolver boundary that daemon
  blobs and future signed HTTPS storage can use.</p>
</div>
<style>
  .blob-demo {
    border-left: 4px solid #2563eb;
    padding: 0.75rem 1rem;
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .blob-demo h3 {
    margin: 0 0 0.35rem;
    font-size: 1.05rem;
  }
  .blob-demo p {
    margin: 0;
    color: #4b5563;
  }
</style>`,
  },
};

export const demoBlobResolver: OutputBlobResolver = {
  url(ref: OutputBlobRef) {
    return `https://example.invalid/nteract-output/${encodeURIComponent(ref.blob)}`;
  },
  async fetch(ref: OutputBlobRef) {
    const fixture = blobFixtures[ref.blob];
    if (!fixture) {
      return new Response(`missing blob fixture: ${ref.blob}`, { status: 404 });
    }
    return new Response(fixture.body, {
      headers: {
        "Content-Type": fixture.mediaType,
      },
    });
  },
};

export const streamAndMarkdownOutputs: NteractEmbeddableOutput[] = [
  {
    output_type: "stream",
    name: "stdout",
    text: "stream before\n",
  } as NteractEmbeddableOutput,
  {
    output_type: "display_data",
    data: {
      "text/markdown": [
        "### Markdown output",
        "",
        "- rendered through the isolated renderer plugin",
        "- sized by iframe notifications",
        "- themed by host context",
      ].join("\n"),
    },
    metadata: {},
  } as NteractEmbeddableOutput,
];

export const dataframeOutput: NteractEmbeddableOutput = {
  output_type: "execute_result",
  execution_count: 7,
  data: {
    "text/plain": "   A  B\\n0  1  3\\n1  2  4",
    "text/html": `
<style>
  table.dataframe {
    border-collapse: collapse;
    font-family: var(--font-sans, system-ui, sans-serif);
    width: 100%;
  }
  table.dataframe th,
  table.dataframe td {
    border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    padding: 0.42rem 0.6rem;
    text-align: right;
  }
  table.dataframe th:first-child,
  table.dataframe td:first-child {
    color: #6b7280;
    text-align: left;
  }
</style>
<table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;">
      <th></th>
      <th>A</th>
      <th>B</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>0</th>
      <td>1</td>
      <td>3</td>
    </tr>
    <tr>
      <th>1</th>
      <td>2</td>
      <td>4</td>
    </tr>
  </tbody>
</table>`,
  },
  metadata: {},
} as NteractEmbeddableOutput;

export const blobBackedHtmlManifest: OutputManifest = {
  output_type: "display_data",
  data: {
    "text/html": {
      blob: "demo-html-output",
      media_type: "text/html",
    },
  },
  metadata: {},
};
