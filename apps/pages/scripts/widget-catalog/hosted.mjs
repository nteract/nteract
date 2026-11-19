import { startCatalogServer } from "./server.mjs";
const [dir, pin, origin, port] = process.argv.slice(2);
if (
  !/^[0-9a-f]{64}$/.test(pin) ||
  new URL(origin).protocol !== "https:" ||
  new URL(origin).origin !== origin
)
  throw Error("Expected a catalog directory, revision, HTTPS origin and port");
startCatalogServer({ dir, pin, origin, port: Number(port) });
