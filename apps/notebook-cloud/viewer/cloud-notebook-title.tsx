import { House } from "lucide-react";
import { notebookRouteSegmentTitle } from "../src/notebook-route-title";

export function CloudNotebookTitle() {
  const title = cloudNotebookRouteTitle();

  return (
    <div className="cloud-notebook-title-group">
      <a
        className="cloud-notebook-home-link"
        href="/n"
        aria-label="Open notebooks dashboard"
        title="Notebooks"
      >
        <House aria-hidden="true" />
      </a>
      <div className="cloud-notebook-title" title={title.title}>
        <span>{title.label}</span>
        {title.detail ? <small>{title.detail}</small> : null}
      </div>
    </div>
  );
}

export function cloudNotebookRouteTitle(): {
  label: string;
  detail: string | null;
  title: string;
} {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const routeSlug = pathParts[0] === "n" ? pathParts[2] : null;
  const routeTitle = notebookRouteSegmentTitle(routeSlug);

  if (routeTitle) {
    return {
      label: routeTitle,
      detail: null,
      title: routeTitle,
    };
  }

  return {
    label: "Cloud Notebook",
    detail: null,
    title: "Cloud Notebook",
  };
}
