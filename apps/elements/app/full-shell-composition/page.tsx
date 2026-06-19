import type { Metadata } from "next";
import { FullShellCompositionExample } from "@/components/full-shell-composition-example";

export const metadata: Metadata = {
  title: "Full shell composition",
  description: "Full-space Elements notebook shell composition.",
};

export default function Page() {
  return <FullShellCompositionExample />;
}
