export async function createLiveNotebookFixture(rt, { preset = "mathnet" } = {}) {
  if (preset !== "mathnet") {
    throw new Error(`Unknown NOTEBOOK_CLOUD_LIVE_PRESET ${preset}`);
  }
  return createMathNetNotebook(rt);
}

async function createMathNetNotebook(rt) {
  const session = await rt.createNotebook({
    runtime: "python",
    description: "notebook-cloud live publish",
    dependencies: ["polars", "pyarrow", "datasets", "pillow"],
    packageManager: "uv",
    environmentMode: "notebook",
  });

  try {
    await session.createCell(
      [
        "# MathNet via notebook-cloud",
        "",
        "This notebook was executed through a live local runtimed session, exported as a NotebookDoc + RuntimeStateDoc snapshot pair, and published to the Cloudflare notebook-cloud worker.",
      ].join("\n"),
      { cellType: "markdown" },
    );
    await session.approveTrust();
    await session.syncEnvironment();
    await session.runCell(
      [
        "import polars as pl",
        "from datasets import load_dataset",
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
        "dataset = load_dataset('ShadenA/MathNet', 'all', split='train[:25]')",
        "rows = [{key: summarize_value(value) for key, value in example.items()} for example in dataset]",
        "df = pl.DataFrame(rows)",
        "print(f'Loaded {df.height} rows and {df.width} columns from ShadenA/MathNet')",
        "df",
      ].join("\n"),
      { timeoutMs: 10 * 60 * 1000 },
    );
    return session;
  } catch (error) {
    await session.shutdownNotebook().catch(() => {});
    await session.close().catch(() => {});
    throw error;
  }
}
