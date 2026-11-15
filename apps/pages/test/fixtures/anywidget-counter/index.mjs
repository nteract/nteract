function render({ model, el }) {
  let button = document.createElement("button");
  button.innerHTML = `count is ${model.get("count")}`;
  button.addEventListener("click", () => {
    model.set("count", model.get("count") + 1);
    model.save_changes();
  });
  model.on("change:count", () => {
    button.innerHTML = `count is ${model.get("count")}`;
  });
  el.classList.add("counter-widget");
  el.appendChild(button);
}
export default { render };
