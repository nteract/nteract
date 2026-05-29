import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SidebarTocPrototype } from "~/prototypes/sidebar-toc/SidebarTocPrototype";
import "../../src/index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SidebarTocPrototype />
  </StrictMode>,
);
