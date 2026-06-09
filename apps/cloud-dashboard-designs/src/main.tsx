import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CloudDashboardDesignLab } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CloudDashboardDesignLab />
  </StrictMode>,
);
