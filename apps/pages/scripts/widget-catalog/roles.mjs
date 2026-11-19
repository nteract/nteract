import activity from "data/activity";
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChoiceGroup } from "activity-controls";

function Roles({ counts }) {
  const [role, setRole] = useState("Readers");
  return h(
    "div",
    null,
    h(ChoiceGroup, {
      label: "Activity type",
      value: role,
      onChange: setRole,
      options: Object.keys(counts).map((role) => [role, role]),
    }),
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

export async function render({ el, signal }) {
  const { counts } = await activity.json();
  signal.throwIfAborted();
  const root = createRoot(el);
  root.render(h(Roles, { counts }));
  return () => root.unmount();
}
