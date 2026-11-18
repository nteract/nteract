import { createElement as h } from "react";

// Owned by this Page. Native frame button styles follow the reader's theme.
export function ChoiceGroup({ label, options, value, onChange }) {
  return h(
    "div",
    {
      role: "group",
      "aria-label": label,
      style: {
        display: "flex",
        justifyContent: "center",
        gap: "0.375rem",
        paddingBottom: "0.5rem",
        borderBottom: "1px solid var(--border)",
      },
    },
    ...options.map(([id, text]) =>
      h(
        "button",
        {
          key: id,
          type: "button",
          "aria-pressed": id === value,
          "data-variant": id === value ? "primary" : "secondary",
          onClick: () => onChange(id),
        },
        text,
      ),
    ),
  );
}
