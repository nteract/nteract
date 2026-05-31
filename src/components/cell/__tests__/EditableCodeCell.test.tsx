import { render, screen } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditableCodeCell } from "../EditableCodeCell";
import type { CodeMirrorEditorRef } from "@/components/editor";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import type { JupyterOutput } from "../jupyter-output";

const outputAreaCalls = vi.hoisted(() => ({
  props: [] as Array<{
    cellId?: string;
    className?: string;
    executionCount?: number | null;
    hostContext?: unknown;
    priority?: readonly string[];
    outputs: JupyterOutput[];
  }>,
}));

vi.mock("@/components/cell/OutputArea", () => ({
  OutputArea: (props: {
    cellId?: string;
    className?: string;
    executionCount?: number | null;
    hostContext?: unknown;
    priority?: readonly string[];
    outputs: JupyterOutput[];
  }) => {
    outputAreaCalls.props.push(props);
    return (
      <div
        data-cell-id={props.cellId}
        data-class-name={props.className ?? ""}
        data-execution-count={props.executionCount ?? ""}
        data-host-context={JSON.stringify(props.hostContext ?? null)}
        data-output-count={props.outputs.length}
        data-priority={props.priority?.join(",") ?? ""}
        data-testid="output-area"
      />
    );
  },
}));

vi.mock("@/components/editor/codemirror-editor", () => ({
  CodeMirrorEditor: forwardRef<
    CodeMirrorEditorRef,
    {
      className?: string;
      initialValue?: string;
      language?: string;
      placeholder?: string;
    }
  >(function MockCodeMirrorEditor({ className, initialValue = "", language, placeholder }, ref) {
    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      setCursorPosition: vi.fn(),
      getEditor: () => null,
    }));

    return (
      <textarea
        className={className}
        data-language={language}
        data-testid="codemirror-editor"
        placeholder={placeholder}
        readOnly
        value={initialValue}
      />
    );
  }),
}));

describe("EditableCodeCell", () => {
  it("renders editable source and outputs through shared cell chrome", () => {
    const output: JupyterOutput = {
      output_id: "output-1",
      output_type: "stream",
      name: "stdout",
      text: "hello",
    };

    render(
      <Harness
        id="code-1"
        elementId="notebook-cell-code-1"
        source='print("hello")'
        language="python"
        outputs={[output]}
        executionCount={7}
        priority={["text/plain"]}
        hostContext={{
          nteract: {
            rendererAssetsBaseUrl: "https://assets.example.test/renderer-assets/",
          },
        }}
        sourceClassName="source"
        outputClassName="output"
      />,
    );

    expect(document.querySelector('[data-slot="cell-container"]')).toHaveAttribute(
      "id",
      "notebook-cell-code-1",
    );
    expect(screen.getByTestId("codemirror-editor")).toHaveValue('print("hello")');
    expect(screen.getByTestId("codemirror-editor")).toHaveAttribute("data-language", "python");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-cell-id", "code-1");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-output-count", "1");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-execution-count", "7");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-priority", "text/plain");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-class-name", "output");
    expect(screen.getByTestId("output-area").getAttribute("data-host-context")).toContain(
      "https://assets.example.test/renderer-assets/",
    );
  });

  it("preserves output rendering when code source is hidden", () => {
    const output: JupyterOutput = {
      output_id: "output-2",
      output_type: "stream",
      name: "stdout",
      text: "hidden source output",
    };

    render(<Harness id="code-2" source="1 + 1" outputs={[output]} showSource={false} />);

    expect(screen.queryByTestId("codemirror-editor")).toBeNull();
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-cell-id", "code-2");
    expect(document.querySelector('[data-slot="cell-output-content"]')).not.toBeNull();
  });
});

function Harness({
  id,
  elementId,
  source,
  language,
  outputs,
  executionCount,
  priority,
  hostContext,
  sourceClassName,
  outputClassName,
  showSource,
}: {
  id: string;
  elementId?: string;
  source: string;
  language?: "python";
  outputs?: readonly JupyterOutput[];
  executionCount?: number | null;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  sourceClassName?: string;
  outputClassName?: string;
  showSource?: boolean;
}) {
  const editorRef = useRef<CodeMirrorEditorRef>(null);

  return (
    <EditableCodeCell
      id={id}
      elementId={elementId}
      source={source}
      language={language}
      outputs={outputs}
      executionCount={executionCount}
      priority={priority}
      hostContext={hostContext}
      editorRef={editorRef}
      sourceClassName={sourceClassName}
      outputClassName={outputClassName}
      showSource={showSource}
    />
  );
}
