import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Note: vitest 4 transpiles this config into node_modules/.vite-temp, so
// import.meta.url does NOT point at this folder. Use a cwd-relative path and
// run vitest from the repository root:
//   npx vitest run --config examples/chat-rooms/vitest.config.ts
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./examples/chat-rooms/wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["examples/chat-rooms/test/**/*.test.ts"],
  },
});
