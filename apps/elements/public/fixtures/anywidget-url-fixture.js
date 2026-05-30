export default {
  render({ model, el }) {
    el.classList.add("elements-anywidget-url-fixture");

    const header = document.createElement("div");
    header.className = "elements-anywidget-url-header";

    const title = document.createElement("div");
    title.className = "elements-anywidget-url-title";
    title.textContent = String(model.get("title") || "URL-backed AnyWidget");

    const badge = document.createElement("div");
    badge.className = "elements-anywidget-url-badge";
    badge.textContent = "url asset";

    header.append(title, badge);

    const status = document.createElement("div");
    status.className = "elements-anywidget-url-status";
    status.textContent = String(model.get("status") || "loaded");

    const meter = document.createElement("div");
    meter.className = "elements-anywidget-url-meter";
    const meterFill = document.createElement("div");
    meterFill.className = "elements-anywidget-url-meter-fill";
    meter.append(meterFill);

    const custom = document.createElement("div");
    custom.className = "elements-anywidget-url-custom";
    custom.textContent = "waiting for URL-backed custom message";

    el.append(header, status, meter, custom);

    const update = () => {
      const value = Number(model.get("value") || 0);
      meterFill.style.width = Math.min(100, value * 10) + "%";
    };

    const onCustom = (content, buffers) => {
      const kind = content && typeof content.kind === "string" ? content.kind : "message";
      custom.textContent = kind + " with " + (buffers ? buffers.length : 0) + " buffer(s)";
    };

    model.on("change:value", update);
    model.on("msg:custom", onCustom);
    update();

    return () => {
      model.off("change:value", update);
      model.off("msg:custom", onCustom);
      el.replaceChildren();
    };
  },
};
