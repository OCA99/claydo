import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./examples/shop/wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["examples/shop/test/**/*.test.ts"],
  },
});
