import { env } from "cloudflare:test";
import { expect } from "vitest";
import { kind } from "../../../src/index";

export interface ChatClient {
  ws: WebSocket;
  /** Resolves with the next JSON message, FIFO. Rejects after a timeout. */
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

/** Connects a chat client. `user` becomes the PartyServer connection id. */
export async function connect(room: string, user: string): Promise<ChatClient> {
  const response = await kind(env.APP_DO, "chat")
    .get(room)
    .fetch(`https://do/?_pk=${user}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const queue: string[] = [];
  const waiters: Array<(message: string) => void> = [];
  ws.addEventListener("message", (event) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(event.data as string);
    else queue.push(event.data as string);
  });
  ws.accept();
  return {
    ws,
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
