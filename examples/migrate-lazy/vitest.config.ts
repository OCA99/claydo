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
    include: ["examples/migrate-lazy/test/**/*.test.ts"],
    // The migrated() route cache attaches a `.then()` to every route
    // resolution without a rejection handler, so every FAILED resolution
    // (both-live splits, racing lazy drivers) leaks an unhandled rejection
    // even when the caller handled the error. Without this filter the suite
    // cannot stay green. See DX-REPORT.md.
    onUnhandledError(error) {
      if (error.message?.startsWith("claydo:")) return false;
    },
  },
});
