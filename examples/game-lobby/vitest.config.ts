import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./examples/game-lobby/wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["examples/game-lobby/test/**/*.test.ts"],
  },
});
