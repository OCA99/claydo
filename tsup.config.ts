import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/test.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["cloudflare:workers", "cloudflare:test"],
});
