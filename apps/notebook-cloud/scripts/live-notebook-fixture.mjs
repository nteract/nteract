export async function createLiveNotebookFixture(rt, { preset = "mathnet" } = {}) {
  if (preset === "mathnet") {
    return createMathNetNotebook(rt);
  }
  if (preset === "html-output") {
    return createHtmlOutputNotebook(rt);
  }
  if (preset === "lets-edit") {
    return createLetsEditNotebook(rt);
  }
  throw new Error(`Unknown NOTEBOOK_CLOUD_LIVE_PRESET ${preset}`);
}

async function createMathNetNotebook(rt) {
  const session = await rt.createNotebook({
    runtime: "python",
    description: "notebook-cloud live publish",
    dependencies: ["polars", "pyarrow", "datasets", "pillow", "numpy", "matplotlib", "plotly"],
    packageManager: "uv",
    environmentMode: "notebook",
  });

  try {
    await session.createCell(MATHNET_NOTEBOOK_CELLS[0].source, { cellType: "markdown" });
    await session.approveTrust();
    await session.syncEnvironment();
    for (const cell of MATHNET_NOTEBOOK_CELLS.slice(1)) {
      if (cell.cellType === "markdown") {
        await session.createCell(cell.source, { cellType: "markdown" });
      } else {
        await session.runCell(cell.source, { timeoutMs: 10 * 60 * 1000 });
      }
    }
    return session;
  } catch (error) {
    await session.shutdownNotebook().catch(() => {});
    await session.close().catch(() => {});
    throw error;
  }
}

const MATHNET_NOTEBOOK_CELLS = [
  {
    cellType: "markdown",
    source: [
      "# MathNet topic visualization",
      "",
      "The [MathNet dataset](https://huggingface.co/datasets/ShadenA/MathNet) collects competition math problems from around the world, each annotated with a hierarchical topic path like `Geometry > Plane Geometry > Triangles`. This notebook takes a small, fixed-seed slice and asks the obvious question: **what does that hierarchy actually look like?**",
      "",
      "Two views land it. A **sunburst** for the radial sense of where the mass lives, and a **treemap** for proportional comparison at a glance. Both fall out of the same prefix-walk over the topic strings.",
      "",
      "Along the way: a quick schema check, a few summary stats, and a feel for the distribution of problem and solution lengths.",
      "",
      "## Loading the slice",
      "",
      "25 rows, shuffled with a fixed seed so the picture is reproducible while the hosted smoke stays quick. The loading step pre-computes `problem_length`, `avg_solution_length`, `topic_count`, and `has_images` so downstream cells can focus on visualization.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "from datasets import load_dataset",
      "import polars as pl",
      "",
      "def summarize_value(value):",
      "    if value is None or isinstance(value, (str, int, float, bool)):",
      "        return value",
      "    if hasattr(value, 'size') and hasattr(value, 'mode'):",
      '        return f"Image({value.size[0]}x{value.size[1]}, {value.mode})"',
      "    if isinstance(value, list):",
      '        return f"list[{len(value)}]"',
      "    text = str(value)",
      "    return text if len(text) <= 240 else text[:237] + '...'",
      "",
      "def average_solution_length(solutions):",
      "    if not solutions:",
      "        return 0.0",
      "    return sum(len(solution) for solution in solutions) / len(solutions)",
      "",
      "dataset = load_dataset('ShadenA/MathNet', 'all', split='train[:25]').shuffle(seed=67)",
      "rows = []",
      "for example in dataset:",
      "    topics = example.get('topics_flat') or []",
      "    solutions = example.get('solutions_markdown') or []",
      "    problem_markdown = example.get('problem_markdown') or ''",
      "    rows.append({",
      "        'id': example.get('id'),",
      "        'problem_markdown': problem_markdown,",
      "        'problem_length': len(problem_markdown),",
      "        'images': summarize_value(example.get('images')),",
      "        'has_images': bool(example.get('images')),",
      "        'country': example.get('country'),",
      "        'competition': example.get('competition'),",
      "        'topics_flat': topics,",
      "        'top_level': topics[0].split('>')[0].strip() if topics else 'Uncategorized',",
      "        'language': example.get('language'),",
      "        'problem_type': example.get('problem_type'),",
      "        'final_answer': example.get('final_answer'),",
      "        'solutions_markdown': summarize_value(solutions),",
      "        'avg_solution_length': average_solution_length(solutions),",
      "        'topic_count': len(topics),",
      "    })",
      "",
      "df = pl.DataFrame(rows)",
      "print(f'Loaded {df.height} rows and {df.width} columns from ShadenA/MathNet')",
      "df",
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "### Schema at a glance",
      "",
      "The interesting columns for this notebook are `topics_flat` (the ` > `-delimited hierarchy paths), `problem_markdown` and `avg_solution_length` for length stats, plus `country` / `competition` if we want to slice by origin.",
      "",
      "Each row is a single problem; `solutions_markdown` is a list in the source dataset because a single problem can have multiple accepted solutions.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "print(df.schema)",
      "df.select(['problem_length', 'avg_solution_length', 'topic_count', 'has_images']).describe()",
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "### Adding derived columns",
      "",
      "`avg_solution_length` averages over the per-problem solution list (or 0 if no solutions are present). `topic_count` is just the length of the `topics_flat` list - useful for asking how many concepts a typical problem touches.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "from IPython.display import Markdown",
      "import numpy as np",
      "",
      "prob = np.array(df['problem_length'].to_list())",
      "sol = np.array(df['avg_solution_length'].to_list())",
      "tc = np.array(df['topic_count'].to_list())",
      "has_img = np.array(df['has_images'].to_list())",
      "",
      'Markdown(f"""### Distribution snapshot',
      "",
      "Before getting into topic structure, a one-shot summary grounds the rest of the notebook. Three numbers to remember:",
      "",
      "- Median problem is **{int(np.median(prob))} chars** - a paragraph.",
      "- Median solution is **{int(np.median(sol)):,} chars** - often a multi-paragraph proof.",
      "- Most problems carry **{int(np.percentile(tc, 25))}-{int(np.percentile(tc, 75))}** topic tags. A few touch up to {int(tc.max())}.",
      "",
      "**{has_img.mean():.0%}** of problems include at least one image, which matters for geometry-heavy categories.",
      '""")',
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "### And in pictures",
      "",
      "`describe()` gives the headline numbers; the histograms show the shape. Both distributions are right-skewed - most problems and solutions are short, with a long tail of much longer ones.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "import matplotlib.pyplot as plt",
      "import numpy as np",
      "",
      "problem_lens = np.array(df['problem_length'].to_list())",
      "solution_lens = np.array(df['avg_solution_length'].to_list())",
      "",
      "fig, axes = plt.subplots(1, 2, figsize=(13, 4.5))",
      "for ax, data, label, color in [",
      "    (axes[0], problem_lens, 'problem length (chars)', '#0969da'),",
      "    (axes[1], solution_lens, 'avg solution length (chars)', '#8250df'),",
      "]:",
      "    ax.hist(data, bins=12, color=color, alpha=0.85, edgecolor='white', linewidth=0.5)",
      "    ax.axvline(np.median(data), color='#1f2328', linestyle='--', linewidth=1, label=f'median {np.median(data):.0f}')",
      "    ax.axvline(np.mean(data), color='#cf222e', linestyle=':', linewidth=1.2, label=f'mean {np.mean(data):.0f}')",
      "    ax.set_xlabel(label)",
      "    ax.set_ylabel('problems')",
      "    ax.legend(frameon=False, fontsize=9)",
      "    ax.spines['top'].set_visible(False)",
      "    ax.spines['right'].set_visible(False)",
      "    ax.grid(axis='y', alpha=0.25)",
      "",
      "fig.suptitle('MathNet slice: length distributions (n=25)', fontsize=12, y=1.02)",
      "plt.tight_layout()",
      "plt.show()",
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "## Topic hierarchy",
      "",
      "Topics in MathNet are encoded as `>`-separated paths. A single string carries up to four levels:",
      "",
      "```",
      "Geometry > Plane Geometry > Triangles > Special points and lines",
      "```",
      "",
      "We do not need a tree library to walk that - a flat list of prefix strings is enough. The next cell flattens all topic strings across the slice, counts them by full path, and reports depth plus top-level distribution.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "from collections import Counter",
      "",
      "all_topics = [topic for topics in df['topics_flat'].to_list() for topic in topics]",
      "depths = Counter(len(topic.split('>')) for topic in all_topics)",
      "top_counter = Counter(topic.split('>')[0].strip() for topic in all_topics)",
      "",
      "print(f'{len(all_topics)} topic tags across {df.height} problems')",
      "print(f'{len(set(all_topics))} unique full topic paths')",
      "print(f'hierarchy depths (levels -> count): {dict(sorted(depths.items()))}')",
      "print()",
      "print('top-level categories:')",
      "for cat, n in top_counter.most_common():",
      "    print(f'  {n:3d}  {cat}')",
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "## Sunburst: where the mass lives",
      "",
      "A sunburst is a polar treemap. Inner rings are top-level categories; outer rings drill into subtopics. Useful for a sense of where the gravity is without forcing the eye to do area arithmetic.",
      "",
      'The construction walks every topic path and registers each prefix as a node. `branchvalues="remainder"` tells Plotly that a parent\'s displayed size is its own count plus the sum of children.',
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "import plotly.graph_objects as go",
      "from collections import Counter",
      "",
      "topic_counts = Counter(all_topics)",
      "own_value = Counter()",
      "parent_of = {}",
      "for topic, count in topic_counts.items():",
      "    parts = [part.strip() for part in topic.split('>')]",
      "    for index in range(len(parts)):",
      "        node = ' > '.join(parts[: index + 1])",
      "        parent_of[node] = ' > '.join(parts[:index]) if index > 0 else ''",
      "    own_value[' > '.join(parts)] += count",
      "",
      "ids = sorted(parent_of)",
      "fig = go.Figure(go.Sunburst(",
      "    ids=ids,",
      "    labels=[node.split(' > ')[-1] for node in ids],",
      "    parents=[parent_of[node] for node in ids],",
      "    values=[own_value.get(node, 0) for node in ids],",
      "    branchvalues='remainder',",
      "    hovertemplate='<b>%{label}</b><br>%{value} tags<br>%{percentRoot} of all tags<extra></extra>',",
      "    insidetextorientation='radial',",
      "))",
      "fig.update_layout(title=f'MathNet topic distribution - {df.height}-problem slice', margin=dict(t=50, l=0, r=0, b=0), height=650)",
      "fig",
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "## Treemap: proportional comparison",
      "",
      "Same data, rectangular layout. The treemap is better when you want to compare sizes side-by-side. Polar arcs at the outer ring of a sunburst exaggerate area; rectangles read more honestly when two subtopics have similar counts.",
      "",
      "Same prefix-walk, same value semantics. Only the geometry of the layout changes.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "fig = go.Figure(go.Treemap(",
      "    ids=ids,",
      "    labels=[node.split(' > ')[-1] for node in ids],",
      "    parents=[parent_of[node] for node in ids],",
      "    values=[own_value.get(node, 0) for node in ids],",
      "    branchvalues='remainder',",
      "    hovertemplate='<b>%{label}</b><br>%{value} tags<br>%{percentRoot} of all tags<extra></extra>',",
      "    tiling=dict(pad=3),",
      "    marker=dict(cornerradius=4),",
      "    textinfo='label+value',",
      "))",
      "fig.update_layout(title=f'MathNet topics: treemap view ({len(all_topics)} tags, {df.height}-problem slice)', margin=dict(t=50, l=0, r=0, b=0), height=650)",
      "fig",
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "### Problem-space scatter",
      "",
      "One more view before the sample gallery: each problem as a point in (problem length, avg solution length) space, colored by its primary top-level topic. This puts the summary back into individual dots and shows the correlation visually.",
      "",
      "Long problems generally produce long solutions, but the cloud is wide - a short, dense problem can still demand a multi-page proof.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "import matplotlib.pyplot as plt",
      "import numpy as np",
      "",
      "CATEGORY_COLORS = {",
      "    'Geometry': '#0969da',",
      "    'Discrete Mathematics': '#bc4c00',",
      "    'Algebra': '#8250df',",
      "    'Number Theory': '#1a7f37',",
      "}",
      "",
      "fig, ax = plt.subplots(figsize=(11, 6.5))",
      "for category, color in CATEGORY_COLORS.items():",
      "    subset = df.filter(pl.col('top_level') == category)",
      "    if subset.height == 0:",
      "        continue",
      "    ax.scatter(",
      "        subset['problem_length'].to_list(),",
      "        subset['avg_solution_length'].to_list(),",
      "        s=42,",
      "        color=color,",
      "        alpha=0.75,",
      "        edgecolor='white',",
      "        linewidth=0.6,",
      "        label=f'{category} (n={subset.height})',",
      "    )",
      "",
      "ax.set_xlabel('problem length (chars)')",
      "ax.set_ylabel('avg solution length (chars)')",
      "ax.set_title('Problem vs solution length, by top-level topic')",
      "ax.legend(frameon=False, fontsize=9, loc='upper left')",
      "ax.spines['top'].set_visible(False)",
      "ax.spines['right'].set_visible(False)",
      "ax.grid(alpha=0.25)",
      "plt.tight_layout()",
      "plt.show()",
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "## A sample from each top-level category",
      "",
      "The charts tell us how much of each topic exists. They do not say what one looks like. The next cell picks the first problem from each top-level category and renders it with the problem text, topics, and final answer.",
      "",
      "The rendering uses `IPython.display` so the formatting stays consistent: header card with metadata, then the problem markdown rendered (LaTeX and all), then a green answer footer.",
    ].join("\n"),
  },
  {
    cellType: "code",
    source: [
      "from IPython.display import display, HTML, Markdown",
      "import re",
      "",
      "_BADGE_COLORS = {",
      "    'Geometry': '#0969da',",
      "    'Discrete Mathematics': '#bc4c00',",
      "    'Algebra': '#8250df',",
      "    'Number Theory': '#1a7f37',",
      "    'Precalculus': '#9a6700',",
      "    'Statistics': '#cf222e',",
      "}",
      "",
      "seen = {}",
      "for row in rows:",
      "    top = row['top_level']",
      "    if top not in seen:",
      "        seen[top] = row",
      "",
      "for top in ['Geometry', 'Discrete Mathematics', 'Algebra', 'Number Theory']:",
      "    row = seen.get(top)",
      "    if not row:",
      "        continue",
      "    color = _BADGE_COLORS.get(top, '#57606a')",
      "    topics_html = ''.join(",
      "        f'<span style=\"display:inline-block;font-size:11px;padding:2px 8px;margin:2px 4px 2px 0;background:#eaeef2;border-radius:10px;color:#24292f;\">{topic}</span>'",
      "        for topic in row['topics_flat']",
      "    )",
      "    display(HTML(f'''",
      '    <div style="font-family:-apple-system,sans-serif;margin:12px 0;border-left:4px solid {color};padding:10px 14px;background:#f6f8fa;border-radius:4px;">',
      '      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:{color};">{top}</div>',
      "      <div style=\"font-size:15px;font-weight:600;margin-top:2px;color:#1f2328;\">{row['id']} - {row['competition'] or '-'} - {row['country']}</div>",
      '      <div style="margin-top:6px;">{topics_html}</div>',
      "    </div>",
      "    '''))",
      "    problem_markdown = re.sub(r'!\\[[^\\]]*\\]\\([^)]*\\)', '[diagram omitted in smoke fixture]', row['problem_markdown'])",
      "    display(Markdown(problem_markdown))",
      "    if row['final_answer']:",
      '        display(HTML(f\'<div style="margin:8px 0 20px;padding:8px 12px;background:#dafbe1;border-radius:4px;font-family:-apple-system,sans-serif;font-size:13px;"><strong>Answer:</strong> {row["final_answer"]}</div>\'))',
    ].join("\n"),
  },
  {
    cellType: "markdown",
    source: [
      "## Where to take this next",
      "",
      "A few obvious extensions:",
      "",
      "- **Per-country topic mix.** Russia is heavy on combinatorics; France leans algebra/number theory. The same prefix-walk, faceted by `country`, would surface that.",
      "- **Solution length by depth.** Do deeper topics correlate with longer or shorter solutions? `topic_count` x `avg_solution_length` is a scatter away.",
      "- **Image presence by category.** Geometry's image rate is the headline, but the split within Geometry is probably more interesting.",
      "",
      "The small slice is a smoke-test sketch. The full set is 20,000+, and the same pipeline holds - only the sunburst gets denser.",
    ].join("\n"),
  },
];

async function createLetsEditNotebook(rt) {
  const session = await rt.createNotebook({
    runtime: "python",
    description: "notebook-cloud shared editing smoke",
    packageManager: "uv",
    environmentMode: "notebook",
  });

  try {
    await session.createCell(
      [
        "# Let's edit",
        "",
        "This is a small shared notebook for trying the hosted editor flow on preview.runt.run.",
      ].join("\n"),
      { cellType: "markdown" },
    );
    await session.createCell(
      [
        "## Notes",
        "",
        "- Add a section below.",
        "- Try editing together from separate accounts.",
        "- Keep this notebook intentionally lightweight while auth and sharing are still settling.",
      ].join("\n"),
      { cellType: "markdown" },
    );
    await session.createCell(["## Scratch space", "", "Start here."].join("\n"), {
      cellType: "markdown",
    });
    return session;
  } catch (error) {
    await session.shutdownNotebook().catch(() => {});
    await session.close().catch(() => {});
    throw error;
  }
}

async function createHtmlOutputNotebook(rt) {
  const session = await rt.createNotebook({
    runtime: "python",
    description: "notebook-cloud HTML output publish",
    packageManager: "uv",
    environmentMode: "notebook",
  });

  try {
    await session.createCell(
      [
        "# HTML output document origin smoke",
        "",
        "This notebook verifies that hosted HTML outputs render in the dedicated output document origin.",
      ].join("\n"),
      { cellType: "markdown" },
    );
    await session.approveTrust();
    await session.syncEnvironment();
    await session.runCell(
      [
        "from IPython.display import HTML, display",
        "",
        'display(HTML("""',
        "<section data-testid='html-output-origin-probe'>",
        "  <h2>Hello from HTML output document</h2>",
        "  <p>This HTML came from a live runtime snapshot.</p>",
        "</section>",
        '"""))',
      ].join("\n"),
      { timeoutMs: 2 * 60 * 1000 },
    );
    return session;
  } catch (error) {
    await session.shutdownNotebook().catch(() => {});
    await session.close().catch(() => {});
    throw error;
  }
}
