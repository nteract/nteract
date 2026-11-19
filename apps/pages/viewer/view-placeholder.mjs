// The dispatcher shows the same frame while it learns which renderer a view needs.
export function viewPlaceholder(root) {
  const doc = root.ownerDocument;
  const placeholder = root.appendChild(doc.createElement("figure"));
  placeholder.className = "pages-chart pages-view-placeholder";
  const header = placeholder.appendChild(doc.createElement("figcaption"));
  header.className = "pages-chart-header";
  const title = header.appendChild(doc.createElement("span"));
  title.className = "pages-chart-title";
  const frame = placeholder.appendChild(doc.createElement("div"));
  frame.className = "pages-chart-frame";
  const message = frame.appendChild(doc.createElement("p"));
  message.className = "pages-chart-message";
  header.hidden = true;
  return { placeholder, header, title, message };
}
