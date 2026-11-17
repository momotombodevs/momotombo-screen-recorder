import { defineConfig } from "vitest/config";

// Runs only the audit tests; the main suite (vitest.config.ts) includes them too.
export default defineConfig({
  test: { include: ["tests/audit/**/*.audit.test.ts"], environment: "node" },
});
