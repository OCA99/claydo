import { env } from "cloudflare:test";
import { expect } from "vitest";
import { kind } from "../../../src/index";

export interface DocClient {
  ws: WebSocket;

  next(): Promise<Record<string, unknown>>;

  events: string[];
  close(): void;
}

export async function connect(doc: string): Promise<DocClient> {
  const response = await kind(env.APP_DO, "doc")
    .get(doc)
    .fetch("https://do/", { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const queue: string[] = [];
  const waiters: Array<(message: string) => void> = [];
  const events: string[] = [];
  ws.addEventListener("message", (event) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(event.data as string);
    else queue.push(event.data as string);
  });
  ws.addEventListener("close", (event) => events.push(`close:${event.code}`));
  ws.addEventListener("error", () => events.push("error"));
  ws.accept();
  return {
    ws,
    events,
    next() {
      const buffered = queue.shift();
      if (buffered !== undefined) {
        return Promise.resolve(JSON.parse(buffered) as Record<string, unknown>);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a WebSocket message")),
          2_000,
        );
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(JSON.parse(message) as Record<string, unknown>);
        });
      });
    },
    close() {
      ws.close();
    },
  };
}
