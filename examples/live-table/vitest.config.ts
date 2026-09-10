import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./examples/live-table/wrangler.jsonc",
      },
    }),
  ],
  test: { include: ["examples/live-table/test/**/*.test.ts"] },
});
