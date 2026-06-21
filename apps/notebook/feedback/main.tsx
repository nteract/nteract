import { NotebookHostProvider } from "@nteract/notebook-host";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createNotebookHost } from "../src/host/create-notebook-host";
import App from "./App";
import "./index.css";

async function boot() {
  const host = await createNotebookHost();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <NotebookHostProvider host={host}>
        <App />
      </NotebookHostProvider>
    </StrictMode>,
  );
}

void boot().catch((err) => {
  console.error("[feedback] failed to boot", err);
  const root = document.getElementById("root");
  if (root) root.textContent = err instanceof Error ? err.message : String(err);
});
