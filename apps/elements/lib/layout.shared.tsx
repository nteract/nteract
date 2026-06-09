import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: "https://github.com/nteract/nteract",
    nav: {
      title: "nteract elements",
    },
    links: [
      {
        text: "Surfaces",
        url: "/docs",
        active: "nested-url",
      },
    ],
  };
}
