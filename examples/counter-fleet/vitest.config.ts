import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./examples/counter-fleet/wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["examples/counter-fleet/test/**/*.test.ts"],
  },
});
