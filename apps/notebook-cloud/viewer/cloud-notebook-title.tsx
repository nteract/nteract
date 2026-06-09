export function CloudNotebookTitle() {
  const title = cloudNotebookRouteTitle();

  return (
    <div className="cloud-notebook-title" title={title.title}>
      <span>{title.label}</span>
      {title.detail ? <small>{title.detail}</small> : null}
    </div>
  );
}

function cloudNotebookRouteTitle(): {
  label: string;
  detail: string | null;
  title: string;
} {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const routeSlug = pathParts[0] === "n" ? pathParts[2] : null;
  const decodedSlug = safeDecodeRouteSegment(routeSlug);

  if (decodedSlug) {
    const label = humanizeCloudRouteTitle(decodedSlug);
    return {
      label,
      detail: null,
      title: label,
    };
  }

  return {
    label: "Cloud Notebook",
    detail: null,
    title: "Cloud Notebook",
  };
}

function humanizeCloudRouteTitle(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => {
      if (!word) return word;
      return `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function safeDecodeRouteSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return value.trim() || null;
  }
}
