import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: new URL("./wrangler.jsonc", import.meta.url).pathname,
      },
    }),
  ],
  test: {
    include: ["examples/migrate-gnarly/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
