import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  base: "/operator/",
  plugins: [react(), tailwind()],
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: { outDir: "dist", sourcemap: false },
});
