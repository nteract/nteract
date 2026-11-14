import type { Metadata } from "next";
import { PagesSourcesLineExample } from "@/components/pages-sources-line-example";

export const metadata: Metadata = {
  title: "Pages sources line",
  description: "Design exploration: source freshness beneath a Page title.",
};

export default function Page() {
  return <PagesSourcesLineExample />;
}
