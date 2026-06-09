import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "nteract elements",
    template: "%s | nteract elements",
  },
  description: "Notebook workspace surfaces and data workflow components from nteract/nteract.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-color-theme="classic" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
  try {
    const value = localStorage.getItem("notebook-color-theme");
    document.documentElement.setAttribute("data-color-theme", value === "cream" ? "cream" : "classic");
  } catch {
    document.documentElement.setAttribute("data-color-theme", "classic");
  }
})();`,
          }}
        />
      </head>
      <body className="min-h-dvh bg-fd-background text-fd-foreground">
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
