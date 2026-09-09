import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import worker, { OutOfStockError } from "../worker";

const carts = () => kind(env.APP_DO, "cart");
const inventories = () => kind(env.APP_DO, "inventory");

/** Awaits a promise that must reject, and returns the rejection. */
async function caught(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/**
 * Storage persists across tests in this file, so every test gets its own
 * product/user namespace via a unique prefix.
 */
let seq = 0;
function ids() {
  const p = `t${seq++}`;
  return {
    user: `${p}-user`,
    widget: `${p}-widget`,
    gadget: `${p}-gadget`,
  };
}

describe("inventory", () => {
  it("restocks, reserves and releases", async () => {
    const { widget } = ids();
    const inv = inventories().get(widget);
    expect(await inv.stock()).toBe(0);
    expect(await inv.restock(10)).toBe(10);
    expect(await inv.reserve(4)).toBe(6);
    expect(await inv.release(1)).toBe(7);
  });

  it("throws OutOfStockError when stock is insufficient", async () => {
    const { widget } = ids();
    const inv = inventories().get(widget);
    await inv.restock(2);
    const error = await caught(inv.reserve(5));
    expect(error.message).toBe(
      `out of stock: product '${widget}' has 2 left, cannot reserve 5`,
    );
    expect(await inv.stock()).toBe(2);
  });
});

describe("cart checkout", () => {
  it("happy checkout reserves stock on every product", async () => {
    const { user, widget, gadget } = ids();
    await inventories().get(widget).restock(10);
    await inventories().get(gadget).restock(5);

    const cart = carts().get(user);
    await cart.addItem(widget, 3);
    await cart.addItem(gadget, 2);
    await cart.addItem(widget, 1); // merges into the widget line

    const order = await cart.checkout();
    expect(order.lines).toEqual([
      { productId: gadget, qty: 2 },
      { productId: widget, qty: 4 },
    ]);
    expect(await inventories().get(widget).stock()).toBe(6);
    expect(await inventories().get(gadget).stock()).toBe(3);
    expect(await cart.items()).toEqual([]); // cart cleared
  });

  it("failed checkout releases already-reserved stock (compensation)", async () => {
    const { user, widget, gadget } = ids();
    // 'gadget' sorts before 'widget', so checkout reserves gadget first,
    // then fails on widget and must release the gadget reservation.
    await inventories().get(gadget).restock(10);
    await inventories().get(widget).restock(1);

    const cart = carts().get(user);
    await cart.addItem(gadget, 2);
    await cart.addItem(widget, 3); // only 1 in stock

    const error = await caught(cart.checkout());
    expect(error.message).toBe(
      `out of stock: product '${widget}' has 1 left, cannot reserve 3`,
    );

    // Compensation restored everything.
    expect(await inventories().get(gadget).stock()).toBe(10);
    expect(await inventories().get(widget).stock()).toBe(1);
    // The cart still holds the items for a retry.
    expect(await cart.items()).toHaveLength(2);
  });

  it("rejects checkout of an empty cart", async () => {
    const { user } = ids();
    const error = await caught(carts().get(user).checkout());
    expect(error.message).toBe("cart is empty");
  });
});

describe("error propagation across kinds", () => {
  it("keeps name, message, and custom fields over one hop", async () => {
    const { widget } = ids();
    const inv = inventories().get(widget);
    await inv.restock(1);
    const error = await caught(inv.reserve(3));
    const e = error as OutOfStockError;
    expect(e.name).toBe("OutOfStockError");
    expect(e.message).toBe(
      `out of stock: product '${widget}' has 1 left, cannot reserve 3`,
    );
    // Own enumerable fields survive the RPC hop.
    expect(e.productId).toBe(widget);
    expect(e.requested).toBe(3);
    expect(e.available).toBe(1);
    // Class identity does not survive RPC: match on `error.name`.
    expect(error instanceof OutOfStockError).toBe(false);
  });

  it("keeps the fields over two hops (test -> cart -> inventory)", async () => {
    const { user, widget } = ids();
    await inventories().get(widget).restock(1);
    const cart = carts().get(user);
    await cart.addItem(widget, 4);

    const error = await caught(cart.checkout());
    const e = error as OutOfStockError;
    expect(e.name).toBe("OutOfStockError");
    expect(e.message).toBe(
      `out of stock: product '${widget}' has 1 left, cannot reserve 4`,
    );
    expect(e.productId).toBe(widget);
    expect(e.requested).toBe(4);
    expect(e.available).toBe(1);
  });
});

describe("worker end to end", () => {
  it("surfaces the nested failure as a 409 with structured fields", async () => {
    const { user, widget } = ids();
    await worker.fetch(
      new Request(`https://x/cart/${user}/items`, {
        method: "POST",
        body: JSON.stringify({ productId: widget, qty: 2 }),
      }),
      env,
    );
    const response = await worker.fetch(
      new Request(`https://x/cart/${user}/checkout`, { method: "POST" }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "OutOfStockError",
      message: `out of stock: product '${widget}' has 0 left, cannot reserve 2`,
      productId: widget,
      available: 0,
    });
  });
});
