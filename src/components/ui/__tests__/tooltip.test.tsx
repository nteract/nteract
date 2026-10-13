import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";

const RAW_PALETTE_CLASS =
  /^(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

function renderTooltip() {
  return render(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="Restart kernel">
            R
          </button>
        </TooltipTrigger>
        <TooltipContent>Restart kernel</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe("Tooltip", () => {
  it("opens on keyboard focus and describes the trigger", async () => {
    const user = userEvent.setup();
    renderTooltip();

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.tab();

    const trigger = screen.getByRole("button", { name: "Restart kernel" });
    expect(trigger).toHaveFocus();
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Restart kernel");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("opens on hover after the provider delay and closes on Escape", async () => {
    const user = userEvent.setup();
    renderTooltip();

    await user.hover(screen.getByRole("button", { name: "Restart kernel" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Restart kernel");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("uses the inverted foreground surface without raw palette classes", async () => {
    const user = userEvent.setup();
    renderTooltip();

    await user.tab();

    const content = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
    expect(content).not.toBeNull();
    expect(content).toHaveClass("bg-foreground", "text-background", "text-xs", "rounded-md");
    expect([...content!.classList].filter((name) => RAW_PALETTE_CLASS.test(name))).toEqual([]);
  });
});
