import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./examples/rate-limiter/wrangler.jsonc",
      },
    }),
  ],
  test: { include: ["examples/rate-limiter/test/**/*.test.ts"] },
});
