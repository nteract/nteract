import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToggleGroup, ToggleGroupItem, Separator } from "@nteract/pages-ui";

function Roles({ counts }) {
  const [role, setRole] = useState("Readers");
  return h(
    "div",
    null,
    h(
      ToggleGroup,
      {
        type: "single",
        value: role,
        onValueChange: (v) => v && setRole(v),
        "aria-label": "Activity type",
      },
      ...Object.keys(counts).map((v) => h(ToggleGroupItem, { key: v, value: v }, v)),
    ),
    h(Separator),
    h(
      "p",
      { style: { marginTop: "0.75rem" }, "aria-live": "polite" },
      h("strong", { style: { fontSize: "1.7rem" } }, counts[role]),
      " people ",
      role === "Readers" ? "read a Page" : "edited a Page",
      " in the example week.",
    ),
  );
}

export default {
  render({ el, model }) {
    const root = createRoot(el);
    root.render(h(Roles, { counts: model.get("counts") }));
    return () => root.unmount();
  },
};
