# Fresh-Page authoring eval

Can an agent build an interactive Plot chart on a fresh Page, using only the deployment’s assets? The prompt asks for three daily counts, per-bar hover titles, a filter and a reset button. Each candidate starts with its own Page, a fresh Kilo project, a local test identity and access to the same Pages tools. A host pin makes the standard catalog available. In the earlier-guide comparison, each Page starts with no catalog selected. In the module experiment, the deployment pins its standard libraries when the agent saves a view.

## Run a comparison

Use a full Git checkout of this branch. Follow the Pages setup instructions and build from `apps/pages`. Install Chromium with the checkout’s Playwright CLI. The runner needs a working `celld`, a signed-in Kilo CLI and provider internet access. Everything that reads or writes Pages runs on loopback. An HTTPS Git clone works on a network without SSH.

Run these commands in separate terminals from `apps/pages`:

```sh
PAGES_CATALOG_PORT=9447 node scripts/widget-catalog/serve.mjs
```

```sh
./scripts/widget-evals/start-host.sh
```

The host copies the existing build into a new temporary directory and starts with empty storage. Keep it running through the audit. If a host port is occupied, set PAGES_PORT on the start command and set EVAL_PAGES_ORIGIN to the corresponding localhost URL on the remaining commands. If changing the catalog port, pass PAGES_CATALOG_PORT to both the host and the audit.

```sh
node scripts/widget-evals/guides.mjs
node scripts/widget-evals/run.mjs my-cohort
node scripts/widget-evals/audit.mjs my-cohort
```

By default, the runner starts four concurrent sessions and runs five trials for each combination of Inkling 2 Small or Haiku 4.5 and the earlier or revised guide. Set EVAL_MODELS to comma-separated provider/model names, EVAL_REPETITIONS to a positive integer, and KILO_BIN to the desired CLI executable. For a two-trial smoke run:

```sh
EVAL_MODELS=google/gemini-3.1-flash-lite EVAL_REPETITIONS=1 node scripts/widget-evals/run.mjs gemini-smoke
node scripts/widget-evals/audit.mjs gemini-smoke
```

Use a distinct cohort name for each experiment. The runner saves a randomized order with one of each condition in every block. Rerunning the same cohort on the same host resumes its original order and skips completed trials. If the runner was forcibly stopped, verify the PID in the cohort’s `running` file has exited before removing that file. Keep the temporary host directory to retain the evaluation Pages. On the same host, agents can work independently with separate cohort names. Avoid changing the shared guide files while trials run.

## What varies

`guides.mjs` reads the earlier and revised public guide generators from Git and evaluates them with the hosted Page12 configuration. Both arms use the same running service, current read_page and edit_page schemas, upload helper and browser tool. URLs in the generated guides resolve to the local service. The unchanged entry-point guide comes from the local host. A controlled guide lookup makes the experiment about written guidance. A full-client comparison would also need the client’s ordinary file, network and MCP discovery abilities.

The candidate can read the assigned Page, upload JS or other text as an asset, edit the Page, and inspect it through an authenticated browser. The agent-side browser can click a named button and read chart text and SVG titles. It does not drive pointer hover. The independent grader does. Use the raw tool trace to compare a model’s final claim with the evidence it actually gathered.

## Reading the results

Per-trial inputs, model events, final claims, and browser evidence live under `apps/pages/.context/widget-evals/runs/<cohort>`. The audit writes `audit.json` beside each `result.json` and prints one verdict per trial. Treat transport/provider errors, catalog selection, rendering, tool verification and the model’s report as distinct outcomes. The registration of a view does not prove a browser could render it.

The audit blocks external HTTP requests and checks whether local Plot code created the SVG, whether the bars have the requested titles and relative heights, and whether clicking each button yields the expected rows. It supports native SVG titles and Plot’s pointer-driven tip marks. Its Plot provenance check recognizes the deployment’s catalog build. Manually inspect a legitimate independently bundled Plot implementation if one appears. An agent can satisfy the visual request with hand-authored SVG and still miss the request to use Plot.

## Pilot results

Five sessions per model per guide ran in Kilo 7.8.27. The original 20 trials used the same pre-rebase MCP schema in both arms. The new guide described the distinction between available libraries and active Page imports.

| Model | Guide | Catalog selected before placement | Complete reader passes | Median agent time |
| --- | --- | ---: | ---: | ---: |
| Inkling 2 Small | Earlier | 5/5 | 5/5 | 38.3 s |
| Inkling 2 Small | Revised | 5/5 | 5/5 | 26.9 s |
| Haiku 4.5 | Earlier | 0/5 | 1/5 | 94.7 s |
| Haiku 4.5 | Revised | 4/5 | 2/5 | 74.7 s |
| Gemini 3.1 Flash-Lite | Earlier | 2/5 | 2/5 | 60.9 s |
| Gemini 3.1 Flash-Lite | Revised | 5/5 | 5/5 | 57.6 s |
| DeepSeek V4.1 Flash | Earlier | 5/5 | 5/5 | 61.2 s |
| DeepSeek V4.1 Flash | Revised | 5/5 | 4/5 | 36.9 s |
| Kimi K3.1 Pro Highspeed | Earlier | 0/5 | 0/5 | 240 s |
| Kimi K3.1 Pro Highspeed | Revised | 0/5 | 0/5 | 240 s |

Haiku eventually selected the catalog in all five revised-guide runs. Three of those charts had incorrect per-bar hover labels. Under the earlier guide, two charts depended on external CDNs. All twenty agents read the anywidget guide. These samples identify failure modes and suggest a follow-up experiment that gives the agent browser tool real hover support.

The ten Gemini trials used the rebased host at `a2e63d9cd`, including the Gemini-compatible tool schema from #5147. Gemini made tool calls in all ten trials. Three earlier-guide charts requested a third-party CDN and failed the local-assets audit. Compare guide versions within each model. Gemini, DeepSeek and Kimi ran with a newer MCP schema than the first two cohorts.

The DeepSeek and Kimi cohort used Kilo models `deepseek/deepseek-v4.1-flash-1017` and `moonshotai/kimi-k3.1-pro-highspeed` on the same rebased host as Gemini. Each session had four minutes. A timeout counts at the time limit in the median. The reader audit checks the saved Page even if the agent times out.

DeepSeek rendered a local Plot chart in all ten trials. In the one failing revised-guide trial, “Last 2 days” kept Mon and Tue. DeepSeek accurately reported the visible bars and left the mistake in place.

Kimi read the anywidget guide in all five revised-guide trials. Across both arms it selected the catalog on three Pages (two earlier, one revised), but never placed a widget. All ten sessions hit the time limit. The traces show repeated rejected edits, including a missing `source_revision: null` on catalog creation and a missing or invalid `asset_id` on `set_source`. This points to a narrower follow-up eval: give the agent a real upload receipt and ask it to register that single source.

One revised-guide Kimi session lost its host connection before a result could be saved. Its replacement used a fresh Page and the original time limit. All twenty scored Pages were then audited on the restored host.

## Module authoring on a fresh Page

The module experiment used the same prompt, five fresh Pages per model, Kilo 7.8.27 and the four-minute limit. The candidate host ran the module API from [PR #5148](https://github.com/nteract/nteract/pull/5148), including automatic standard library pins. The earlier and revised guide cohorts above used the earlier API. Treat this as a comparison of authoring experiences across runs. The guide and service both changed.

| Model | Previous revised guide passes | Module passes | Saved module views | Median agent time |
| --- | ---: | ---: | ---: | ---: |
| Inkling 2 Small | 5/5 | 5/5 | 5/5 | 20.0 s |
| Haiku 4.5 | 2/5 | 2/5 | 5/5 | 63.7 s |
| Gemini 3.1 Flash-Lite | 5/5 | 5/5 | 5/5 | 46.8 s |
| DeepSeek V4.1 Flash | 4/5 | 5/5 | 5/5 | 31.2 s |
| Kimi K3.1 Pro Highspeed | 0/5 | 0/5 | 0/5 | 240 s |

All twenty saved views used the deployment’s Plot code. Three Haiku charts failed the per-bar hover check. Every Kimi session read the views guide and called the upload tool. Its edit attempts repeatedly added unrelated fields to `set_source`, including `type`, `alt`, or `view_id`. All five timed out before saving a view. Four unscored setup sessions with Kilo 7.4.21 produced no tool events and were discarded before this cohort began.

To repeat, build the candidate checkout’s Pages app and start its catalog from that checkout. Run the harness from this branch. Set `EVAL_PAGES_APP` to the absolute path of the candidate’s `apps/pages` when starting the host. The host copies the candidate build into a fresh directory.

```sh
PAGES_PORT=9963 PAGES_CATALOG_PORT=9447 EVAL_PAGES_APP=/path/to/candidate/apps/pages ./scripts/widget-evals/start-host.sh
```

In another terminal, select the Kilo 7.8.27 executable with `KILO_BIN`, then run the following commands.

```sh
export EVAL_PAGES_ORIGIN=http://localhost:9963 PAGES_CATALOG_PORT=9447 EVAL_GUIDE=module
export EVAL_MODELS=thinkingmachines/inkling-2-small,anthropic/claude-haiku-4.5,google/gemini-3.1-flash-lite,deepseek/deepseek-v4.1-flash-1017,moonshotai/kimi-k3.1-pro-highspeed
node scripts/widget-evals/guides.mjs
node scripts/widget-evals/run.mjs module-comparison
node scripts/widget-evals/audit.mjs module-comparison
```
