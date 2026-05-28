/**
 * DX bootstrap LLM formatter E2E test.
 *
 * This spec must run with `disable_nteract_launcher` off before the daemon
 * starts. That makes the Python kernel launch through nteract_kernel_launcher,
 * which installs the `text/llm+plain` display formatter.
 */

import { browser } from "@wdio/globals";
import {
  getKernelStatus,
  setCellSource,
  waitForCellOutputMatching,
  waitForKernelReady,
  waitForNotebookSynced,
  waitForSessionReady,
} from "../helpers.js";

const LLM_REPR_SENTINEL = "llm-e2e: dx bootstrap repr";

describe("DX bootstrap LLM formatter", () => {
  it("registers _repr_llm_ in the launched kernel", async () => {
    await waitForKernelReady(300000);
    expect(await getKernelStatus()).toBe("idle");

    await waitForNotebookSynced();

    const codeCell = await $('[data-cell-type="code"]');
    await codeCell.waitForExist({ timeout: 5000 });

    await setCellSource(
      codeCell,
      `
class LLMExample:
    def _repr_llm_(self):
        return "${LLM_REPR_SENTINEL}"

example = LLMExample()
ip = get_ipython()
formatter = ip.display_formatter.formatters.get("text/llm+plain")
data, _metadata = ip.display_formatter.format(example)

print("LLM_FORMATTER", type(formatter).__name__ if formatter else "missing")
print("HAS_LLM_MIME", "text/llm+plain" in data)
print("LLM_VALUE", data.get("text/llm+plain"))
`.trim(),
    );
    await waitForSessionReady();

    const executeButton = await codeCell.$('[data-testid="execute-button"]');
    if (await executeButton.isExisting()) {
      await executeButton.waitForClickable({ timeout: 5000 });
      await executeButton.click();
    } else {
      const editor = await codeCell.$('.cm-content[contenteditable="true"]');
      await editor.click();
      await browser.pause(200);
      await browser.keys(["Shift", "Enter"]);
    }

    const outputText = await waitForCellOutputMatching(
      codeCell,
      (text) =>
        text.includes("LLM_FORMATTER LLMFormatter") &&
        text.includes("HAS_LLM_MIME True") &&
        text.includes(`LLM_VALUE ${LLM_REPR_SENTINEL}`),
      120000,
    );

    expect(outputText).toContain("LLM_FORMATTER LLMFormatter");
    expect(outputText).toContain("HAS_LLM_MIME True");
    expect(outputText).toContain(`LLM_VALUE ${LLM_REPR_SENTINEL}`);
  });
});
