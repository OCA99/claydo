import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Note: vitest 4 transpiles this config into node_modules/.vite-temp, so
// import.meta.url does NOT point at this folder. Use cwd-relative paths and
// run vitest from the repository root:
//   npx vitest run --config examples/migrate-app/vitest.config.ts
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./examples/migrate-app/wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["examples/migrate-app/test/**/*.test.ts"],
    // The journey test walks one migration end to end; steps depend on the
    // previous ones, so keep everything sequential and deterministic.
    fileParallelism: false,
  },
});
