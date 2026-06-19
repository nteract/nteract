import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  addTextAttributions,
  textAttributionExtension,
  type TextAttributionExtensionOptions,
} from "../text-attribution";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) {
    view.destroy();
  }
  views.length = 0;
  document.body.replaceChildren();
});

function createEditor(options?: TextAttributionExtensionOptions): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);

  const view = new EditorView({
    state: EditorState.create({
      doc: "hello world",
      extensions: textAttributionExtension(options),
    }),
    parent,
  });
  views.push(view);
  return view;
}

function textAttributionElement(): HTMLElement {
  const element = document.querySelector(".cm-text-attribution");
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

describe("text attribution", () => {
  it("humanizes and dedupes actor labels in the tooltip", () => {
    const view = createEditor();

    addTextAttributions(view, [
      {
        from: 0,
        to: 5,
        actors: [
          "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab-a",
          "user:anaconda:550e8400-e29b-41d4-a716-446655440000/browser:tab-b",
          "anonymous:viewer:session-a/browser:tab",
          " ",
        ],
      },
    ]);

    expect(textAttributionElement().getAttribute("title")).toBe("Anaconda user, Anonymous");
  });

  it("uses a custom actor name resolver when provided", () => {
    const view = createEditor({
      resolveActorName: (label) => (label === "known-actor" ? "Known actor" : ""),
    });

    addTextAttributions(view, [
      {
        from: 6,
        to: 11,
        actors: ["unknown-actor", "known-actor", "known-actor"],
      },
    ]);

    expect(textAttributionElement().getAttribute("title")).toBe("Known actor");
  });
});
