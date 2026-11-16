import type { Metadata } from "next";
import { PagesSourcesPanelExample } from "@/components/pages-sources-panel-example";

export const metadata: Metadata = {
  title: "Pages sources panel",
  description: "Explore source inspection, connections, and a future data pipeline.",
};

export default function Page() {
  return <PagesSourcesPanelExample />;
}
