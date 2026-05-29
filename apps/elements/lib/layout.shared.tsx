import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { NotebookPaletteToggle } from "@/components/notebook-palette-toggle";

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: "https://github.com/nteract/nteract",
    nav: {
      title: "nteract elements",
    },
    links: [
      {
        text: "Catalog",
        url: "/docs",
        active: "nested-url",
      },
      {
        type: "custom",
        secondary: true,
        children: <NotebookPaletteToggle />,
      },
    ],
  };
}
