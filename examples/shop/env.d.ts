import type { Env as WorkerEnv } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
  // The workers-types lib set does not declare `import.meta.url`, which
  // vitest.config.ts needs to locate wrangler.jsonc.
  interface ImportMeta {
    readonly url: string;
  }
}

export {};
