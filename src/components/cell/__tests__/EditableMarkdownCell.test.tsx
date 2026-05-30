import { fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditableMarkdownCell } from "../EditableMarkdownCell";
import type { CodeMirrorEditorRef } from "@/components/editor";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";

const outputAreaCalls = vi.hoisted(() => ({
  props: [] as Array<{
    cellId?: string;
    className?: string;
    hostContext?: unknown;
    priority?: readonly string[];
    outputs: Array<{ data?: Record<string, unknown>; output_type?: string }>;
  }>,
}));

vi.mock("@/components/cell/OutputArea", () => ({
  OutputArea: (props: {
    cellId?: string;
    className?: string;
    hostContext?: unknown;
    priority?: readonly string[];
    outputs: Array<{ data?: Record<string, unknown>; output_type?: string }>;
  }) => {
    outputAreaCalls.props.push(props);
    return (
      <div
        data-cell-id={props.cellId}
        data-class-name={props.className ?? ""}
        data-host-context={JSON.stringify(props.hostContext ?? null)}
        data-mimes={Object.keys(props.outputs[0]?.data ?? {}).join(",")}
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
      onBlur?: () => void;
      placeholder?: string;
    }
  >(function MockCodeMirrorEditor({ className, initialValue = "", onBlur, placeholder }, ref) {
    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      setCursorPosition: vi.fn(),
      getEditor: () =>
        ({
          state: {
            doc: {
              toString: () => initialValue,
            },
          },
        }) as ReturnType<CodeMirrorEditorRef["getEditor"]>,
    }));

    return (
      <textarea
        className={className}
        data-testid="codemirror-editor"
        onBlur={onBlur}
        placeholder={placeholder}
        readOnly
        value={initialValue}
      />
    );
  }),
}));

describe("EditableMarkdownCell", () => {
  it("renders markdown preview through the shared output surface", () => {
    render(
      <Harness
        id="markdown-1"
        source="## Shared"
        editing={false}
        onEditingChange={() => undefined}
        priority={["text/markdown", "text/plain"]}
        hostContext={{
          nteract: {
            rendererAssetsBaseUrl: "https://assets.example.test/renderer-assets/",
          },
        }}
        previewClassName="preview"
        previewOutputClassName="preview-output"
      />,
    );

    expect(screen.getByTestId("output-area")).toHaveAttribute("data-cell-id", "markdown-1");
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-mimes", "text/markdown");
    expect(screen.getByTestId("output-area")).toHaveAttribute(
      "data-priority",
      "text/markdown,text/plain",
    );
    expect(screen.getByTestId("output-area")).toHaveAttribute("data-class-name", "preview-output");
    expect(screen.getByTestId("output-area").getAttribute("data-host-context")).toContain(
      "https://assets.example.test/renderer-assets/",
    );
    expect(outputAreaCalls.props.at(-1)?.outputs[0]?.data?.["text/markdown"]).toBe("## Shared");
  });

  it("enters edit mode from the preview", () => {
    const onEditingChange = vi.fn();

    render(
      <Harness
        id="markdown-2"
        source="## Editable"
        editing={false}
        onEditingChange={onEditingChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit markdown" }));

    expect(onEditingChange).toHaveBeenCalledWith(true);
  });

  it("exits edit mode using the current editor source", () => {
    const onEditingChange = vi.fn();

    render(
      <Harness id="markdown-3" source="## Current" editing onEditingChange={onEditingChange} />,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Render markdown" }));

    expect(onEditingChange).toHaveBeenCalledWith(false);
  });
});

function Harness({
  id,
  source,
  editing,
  onEditingChange,
  priority,
  hostContext,
  previewClassName,
  previewOutputClassName,
}: {
  id: string;
  source: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  priority?: readonly string[];
  hostContext?: NteractEmbedHostContextPatch;
  previewClassName?: string;
  previewOutputClassName?: string;
}) {
  const editorRef = useRef<CodeMirrorEditorRef>(null);

  return (
    <EditableMarkdownCell
      id={id}
      source={source}
      editing={editing}
      onEditingChange={onEditingChange}
      editorRef={editorRef}
      priority={priority}
      hostContext={hostContext}
      previewClassName={previewClassName}
      previewOutputClassName={previewOutputClassName}
    />
  );
}
