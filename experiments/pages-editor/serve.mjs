import "./build.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const files = {
  "/": "index.html",
  "/index.html": "index.html",
  "/main.js": "main.js",
  "/main.js.map": "main.js.map",
  "/style.css": "style.css",
};
createServer(async (req, res) => {
  const file = files[new URL(req.url, "http://localhost").pathname];
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const data = await readFile(new URL(`./dist/${file}`, import.meta.url));
    res.setHeader(
      "Content-Type",
      file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
    );
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Build output unavailable");
  }
}).listen(4318, "127.0.0.1", () =>
  console.log("Pages editor fixture: http://127.0.0.1:4318 (generated data, memory only)"),
);
