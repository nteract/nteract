import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TracebackOutput } from "../traceback-output";

const payload = {
  ename: "AttributeError",
  evalue: "module 'pandas' has no attribute 'not_real'",
  execution: {
    execution_id: "exec-run",
    execution_count: 3,
  },
  frames: [
    {
      filename: "/var/folders/x/T/ipykernel_39879/258099874.py",
      lineno: 1,
      name: "<module>",
      execution_id: "exec-run",
      execution_count: 3,
      source_ref: {
        kind: "notebook_execution",
        execution_id: "exec-run",
        execution_count: 3,
        compiled_filename: "/var/folders/x/T/ipykernel_39879/258099874.py",
      },
      lines: [{ lineno: 1, source: "g()", highlight: true }],
    },
    {
      filename: "/var/folders/x/T/ipykernel_39879/3398808089.py",
      lineno: 5,
      name: "g",
      execution_id: "exec-def",
      execution_count: 2,
      source_ref: {
        kind: "notebook_execution",
        execution_id: "exec-def",
        execution_count: 2,
        compiled_filename: "/var/folders/x/T/ipykernel_39879/3398808089.py",
      },
      lines: [{ lineno: 5, source: "pd.not_real()", highlight: true }],
    },
  ],
  text: "Traceback (most recent call last):\n  Line 1 in Current Cell (In[3])\n    g()\n  Line 5 in Earlier Cell (In[2]), in g\n    pd.not_real()\nAttributeError: module 'pandas' has no attribute 'not_real'",
  raw_text:
    "Traceback (most recent call last):\n  File \"/var/folders/x/T/ipykernel_39879/258099874.py\", line 1, in <module>\n    g()\n  File \"/var/folders/x/T/ipykernel_39879/3398808089.py\", line 5, in g\n    pd.not_real()\nAttributeError: module 'pandas' has no attribute 'not_real'",
};

describe("TracebackOutput", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  it("renders notebook source labels instead of synthetic ipykernel paths", () => {
    const { container } = render(<TracebackOutput data={payload} />);

    expect(container.textContent).toContain("Line1inCurrent CellIn[3]");
    expect(container.textContent).toContain("Line5inEarlier CellIn[2]ing");
    expect(container.textContent).not.toContain("/var/folders/x/T/ipykernel_39879");
  });

  it("copies the sanitized traceback text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<TracebackOutput data={payload} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy traceback" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Line 1 in Current Cell (In[3])");
    expect(copied).toContain("Line 5 in Earlier Cell (In[2]), in g");
    expect(copied).not.toContain("/var/folders/x/T/ipykernel_39879");
  });
});
