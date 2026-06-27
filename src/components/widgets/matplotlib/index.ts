import { registerWidget } from "../widget-registry";
import { MatplotlibCanvasWidget, MatplotlibToolbarWidget } from "./matplotlib-widget";

registerWidget("MPLCanvasModel", MatplotlibCanvasWidget);
registerWidget("ToolbarModel", MatplotlibToolbarWidget);

export { MatplotlibCanvasWidget, MatplotlibToolbarWidget } from "./matplotlib-widget";
