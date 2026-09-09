import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./examples/alarm-scheduler/wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["examples/alarm-scheduler/test/**/*.test.ts"],
  },
});
