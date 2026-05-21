import type { NteractEmbeddableOutput } from "../../../src/components/isolated/embeddable-output";
import type {
  OutputBlobRef,
  OutputBlobResolver,
  OutputManifest,
} from "../../../src/components/isolated/output-manifest";

const blobFixtures: Record<string, { body: string; mediaType: string }> = {
  "mathnet-problem-card": {
    mediaType: "text/html",
    body: `
<div class="mathnet-card">
  <p class="eyebrow">ShadenA/MathNet · geometry · optional diagram column</p>
  <h3>Problem: Ratio in a triangle</h3>
  <p>In triangle ABC, points D and E lie on AB and AC respectively. If DE is
  parallel to BC and AD:DB = 2:3, what is the ratio of the area of ADE to ABC?</p>
  <p class="answer">final_answer: 4/25</p>
</div>
<style>
  .mathnet-card {
    border-left: 4px solid #2563eb;
    padding: 0.75rem 1rem;
    font-family: var(--font-sans, system-ui, sans-serif);
  }
  .mathnet-card .eyebrow {
    color: #64748b;
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    margin: 0 0 0.4rem;
    text-transform: uppercase;
  }
  .mathnet-card h3 {
    margin: 0 0 0.35rem;
    font-size: 1.05rem;
  }
  .mathnet-card p {
    margin: 0 0 0.5rem;
    color: #4b5563;
  }
  .mathnet-card .answer {
    color: #0f172a;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    margin-bottom: 0;
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

export const agentReplOutputs: NteractEmbeddableOutput[] = [
  {
    output_type: "stream",
    name: "stdout",
    text: [
      "agent$ python",
      ">>> from datasets import load_dataset",
      ">>> ds = load_dataset('ShadenA/MathNet', split='train[:100]')",
      ">>> ds.features",
      "",
    ].join("\n"),
  } as NteractEmbeddableOutput,
  {
    output_type: "display_data",
    data: {
      "text/markdown": [
        "### Observation",
        "",
        "The REPL gives the agent a real inspection loop:",
        "",
        "- `problem_markdown` is long-form text, not a scalar metric",
        "- rows carry provenance like `country`, `competition`, and `language`",
        "- some rows include image columns that should stay inspectable",
      ].join("\n"),
    },
    metadata: {},
  } as NteractEmbeddableOutput,
];

export const mathnetDataFrameOutput: NteractEmbeddableOutput = {
  output_type: "execute_result",
  execution_count: 12,
  data: {
    "text/plain":
      "              id country competition language problem_type final_answer\\n0  mathnet-00017     USA         AMC       en      algebra           42\\n1  mathnet-00042   China         CMO       zh     geometry         4/25\\n2  mathnet-00083  Brazil         OBM       pt   combinatorics        120",
    "text/html": `
<style>
  table.mathnet {
    border-collapse: collapse;
    font-family: var(--font-sans, system-ui, sans-serif);
    width: 100%;
  }
  table.mathnet th,
  table.mathnet td {
    border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    padding: 0.42rem 0.6rem;
    text-align: left;
    vertical-align: top;
  }
  table.mathnet th:first-child,
  table.mathnet td:first-child {
    color: #6b7280;
    width: 2.5rem;
  }
  table.mathnet td.problem {
    max-width: 30rem;
  }
  table.mathnet .tag {
    background: rgb(37 99 235 / 0.08);
    border-radius: 999px;
    color: #1d4ed8;
    display: inline-block;
    font-size: 0.75rem;
    padding: 0.1rem 0.45rem;
  }
</style>
<table border="1" class="mathnet">
  <thead>
    <tr>
      <th></th>
      <th>problem_markdown</th>
      <th>country</th>
      <th>competition</th>
      <th>type</th>
      <th>final_answer</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>0</th>
      <td class="problem">Find all positive integers n such that n^2 + 1 is divisible by 2n + 1.</td>
      <td>USA</td>
      <td>AMC</td>
      <td><span class="tag">algebra</span></td>
      <td>none</td>
    </tr>
    <tr>
      <th>1</th>
      <td class="problem">In triangle ABC, D and E lie on AB and AC. If DE is parallel to BC and AD:DB = 2:3, find [ADE]/[ABC].</td>
      <td>China</td>
      <td>CMO</td>
      <td><span class="tag">geometry</span></td>
      <td>4/25</td>
    </tr>
    <tr>
      <th>2</th>
      <td class="problem">How many arrangements of five students around a round table avoid adjacent twins?</td>
      <td>Brazil</td>
      <td>OBM</td>
      <td><span class="tag">combinatorics</span></td>
      <td>120</td>
    </tr>
  </tbody>
</table>`,
  },
  metadata: {},
} as NteractEmbeddableOutput;

export const mathnetProblemManifest: OutputManifest = {
  output_type: "display_data",
  data: {
    "text/html": {
      blob: "mathnet-problem-card",
      media_type: "text/html",
    },
  },
  metadata: {},
};
