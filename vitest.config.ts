import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.ts",
      "tests/audit/**/*.audit.test.ts",
    ],
    environment: "node",
  },
});
