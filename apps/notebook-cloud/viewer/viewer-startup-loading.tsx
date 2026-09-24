import { BookOpen, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { NotebookBrandMark } from "@/components/notebook/NotebookBrandMark";

/** Once content or an actionable notice is shown, preserve that mounted UI. */
export function useNotebookStartupLoading(loading: boolean): boolean {
  const [finished, setFinished] = useState(!loading);
  useEffect(() => {
    if (!loading) setFinished(true);
  }, [loading]);
  return loading && !finished;
}

export function ViewerStartupLoading({ title }: { title: string }) {
  return (
    <main className="cloud-startup-shell" aria-busy="true">
      <header className="cloud-startup-toolbar">
        <a className="cloud-app-home" href="/n" aria-label="Notebook home" title="Notebook home">
          <NotebookBrandMark className="size-8" />
        </a>
        <div className="cloud-notebook-title-group">
          <div className="cloud-notebook-title">
            <h1 className="cloud-startup-title">{title}</h1>
            <p className="cloud-startup-status" role="status">
              <Loader2 aria-hidden="true" />
              Opening notebook
            </p>
          </div>
        </div>
        <div className="cloud-startup-toolbar-actions" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </header>
      <div className="cloud-startup-workspace">
        <aside className="cloud-startup-rail" aria-hidden="true">
          <BookOpen aria-hidden="true" />
          <span />
        </aside>
        <div className="cloud-startup-main">
          <div className="cloud-startup-command-row" aria-hidden="true">
            <div className="cloud-startup-toolbar-actions">
              <span />
              <span />
            </div>
          </div>
          <section className="cloud-startup-stage" aria-hidden="true">
            <div className="cloud-startup-cell">
              <span className="cloud-startup-line cloud-startup-line--wide" />
              <span className="cloud-startup-line" />
              <span className="cloud-startup-line cloud-startup-line--short" />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
