import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit tests for pure lib/ logic (normalizers, formatters, aggregation).
// These exercise plain functions with no DB or network, so the default
// node environment is all we need — no React/jsdom setup.
export default defineConfig({
  // Mirror tsconfig's "@/*" -> "./*" so lib code importing "@/lib/..." resolves.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Co-located *.test.ts files next to the code they cover.
    include: ["lib/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/types.ts"],
    },
  },
})
