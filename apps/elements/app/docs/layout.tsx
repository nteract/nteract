import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { NotebookPaletteToggle } from "@/components/notebook-palette-toggle";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      {...baseOptions()}
      tree={source.getPageTree()}
      searchToggle={{ enabled: false }}
      sidebar={{ footer: <NotebookPaletteToggle key="notebook-flavor" className="mt-2" /> }}
    >
      {children}
    </DocsLayout>
  );
}
