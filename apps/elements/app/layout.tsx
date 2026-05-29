import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "nteract elements",
    template: "%s | nteract elements",
  },
  description: "Notebook UI and rendering examples from nteract/nteract.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-fd-background text-fd-foreground">
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
