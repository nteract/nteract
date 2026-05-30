import type { EditorView, KeyBinding } from "@codemirror/view";

export interface MarkdownTextSelection {
  from: number;
  to: number;
}

export interface MarkdownFormatResult {
  insert: string;
  from: number;
  to: number;
  selectionAnchor: number;
  selectionHead: number;
}

export function applyInlineMarkdownFormatting(
  docText: string,
  selection: MarkdownTextSelection,
  prefix: string,
  suffix = prefix,
): MarkdownFormatResult {
  const selectedText = docText.slice(selection.from, selection.to);
  const wrappedText = `${prefix}${selectedText}${suffix}`;

  return {
    insert: wrappedText,
    from: selection.from,
    to: selection.to,
    selectionAnchor: selection.from + prefix.length,
    selectionHead: selection.from + prefix.length + selectedText.length,
  };
}

export function applyLinkMarkdownFormatting(
  docText: string,
  selection: MarkdownTextSelection,
): MarkdownFormatResult {
  const selectedText = docText.slice(selection.from, selection.to);
  const linkText = selectedText || "link text";
  const formattedText = `[${linkText}](https://)`;

  return {
    insert: formattedText,
    from: selection.from,
    to: selection.to,
    selectionAnchor: selection.from + 1,
    selectionHead: selection.from + 1 + linkText.length,
  };
}

export function applyQuoteMarkdownFormatting(
  docText: string,
  selection: MarkdownTextSelection,
): MarkdownFormatResult {
  const selectedText = docText.slice(selection.from, selection.to);
  const text = selectedText || "quote";
  const quotedText = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return {
    insert: quotedText,
    from: selection.from,
    to: selection.to,
    selectionAnchor: selection.from,
    selectionHead: selection.from + quotedText.length,
  };
}

export function shouldExitMarkdownEditOnBlur(source: string): boolean {
  return source.trim().length > 0;
}

export function shouldStartMarkdownEditMode(source: string): boolean {
  return source.trim().length === 0;
}

function dispatchMarkdownFormat(
  view: EditorView,
  formatter: (docText: string, selection: MarkdownTextSelection) => MarkdownFormatResult,
) {
  const selection = view.state.selection.main;
  const result = formatter(view.state.doc.toString(), {
    from: selection.from,
    to: selection.to,
  });

  view.dispatch({
    changes: {
      from: result.from,
      to: result.to,
      insert: result.insert,
    },
    selection: {
      anchor: result.selectionAnchor,
      head: result.selectionHead,
    },
  });
  return true;
}

export function createMarkdownFormattingKeyMap(): KeyBinding[] {
  return [
    {
      key: "Mod-b",
      run: (view) =>
        dispatchMarkdownFormat(view, (docText, selection) =>
          applyInlineMarkdownFormatting(docText, selection, "**"),
        ),
    },
    {
      key: "Mod-i",
      run: (view) =>
        dispatchMarkdownFormat(view, (docText, selection) =>
          applyInlineMarkdownFormatting(docText, selection, "*"),
        ),
    },
    {
      key: "Mod-u",
      run: (view) =>
        dispatchMarkdownFormat(view, (docText, selection) =>
          applyInlineMarkdownFormatting(docText, selection, "<u>", "</u>"),
        ),
    },
    {
      key: "Mod-k",
      run: (view) => dispatchMarkdownFormat(view, applyLinkMarkdownFormatting),
    },
    {
      key: "Mod-Shift-.",
      run: (view) => dispatchMarkdownFormat(view, applyQuoteMarkdownFormatting),
    },
    {
      key: "Mod-Shift->",
      run: (view) => dispatchMarkdownFormat(view, applyQuoteMarkdownFormatting),
    },
  ];
}

export function createMarkdownEditModeKeyMap({
  exitEditing,
}: {
  exitEditing: () => void;
}): KeyBinding[] {
  return [
    {
      key: "Ctrl-Enter",
      run: () => {
        exitEditing();
        return true;
      },
    },
    {
      key: "Escape",
      run: () => {
        exitEditing();
        return true;
      },
    },
    ...createMarkdownFormattingKeyMap(),
  ];
}
