import type { Env as WorkerEnv } from "./fixtures/worker";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
