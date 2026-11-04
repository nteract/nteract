import { defineConfig } from "vitest/config";

// Only Repo 3's backend contract runs under vitest (npm run test:contract);
// everything else uses node:test.
export default defineConfig({
  test: { include: ["sync-contract.vitest.mjs"] },
});
