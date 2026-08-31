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
  // No onUnhandledError filter anymore: the route cache's promise chain
  // gained a rejection handler, so failed resolutions no longer leak
  // unhandled rejections (DX-REPORT.md issue 5, verified fixed).
  test: { include: ["examples/migrate-lazy/test/**/*.test.ts"] },
});
