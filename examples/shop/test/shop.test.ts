import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import worker, { OutOfStockError } from "../worker";

const carts = () => kind(env.APP_DO, "cart");
const inventories = () => kind(env.APP_DO, "inventory");

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
    await expect(inv.reserve(5)).rejects.toThrow(
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

    await expect(cart.checkout()).rejects.toThrow(
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
    await expect(carts().get(user).checkout()).rejects.toThrow(
      "cart is empty",
    );
  });
});

describe("worker end to end", () => {
  it("surfaces the nested failure as a 409 with the error name", async () => {
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
    // Post-fix: the typed fields survive DO -> DO -> worker, so the HTTP
    // response can carry structured data instead of parsing the message.
    expect(await response.json()).toEqual({
      error: "OutOfStockError",
      message: `out of stock: product '${widget}' has 0 left, cannot reserve 2`,
      productId: widget,
      available: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Adversarial DX probes: what does a custom error class look like after one
// and after two RPC hops? Post-fix, the envelope carries the original stack
// and own enumerable serializable fields; `instanceof` still does not
// survive (by design — match on `error.name`). Verbatim findings are quoted
// in DX-REPORT.md.
// ---------------------------------------------------------------------------

describe("dx probes: cross-kind error propagation", () => {
  it("PROBE one hop (test -> inventory): name, message, FIELDS and remote stack survive", async () => {
    const { widget } = ids();
    const inv = inventories().get(widget);
    await inv.restock(1);
    let caught: unknown;
    try {
      await inv.reserve(3);
    } catch (error) {
      caught = error;
    }
    const e = caught as OutOfStockError;
    expect(e.name).toBe("OutOfStockError");
    expect(e.message).toBe(
      `out of stock: product '${widget}' has 1 left, cannot reserve 3`,
    );
    expect(caught instanceof Error).toBe(true);
    // Post-fix: the typed fields survive the hop (own enumerable props).
    expect(e.productId).toBe(widget);
    expect(e.requested).toBe(3);
    expect(e.available).toBe(1);
    // Class identity still does not survive, by design.
    expect(caught instanceof OutOfStockError).toBe(false);
    // Post-fix stack: the remote throw site leads, then the hop marker,
    // then the local frames.
    const stack = e.stack ?? "";
    const throwSite = stack.indexOf("at Inventory.reserve");
    const marker = stack.indexOf(
      "at [remote call inventory.reserve() via generic-durable-objects]",
    );
    const local = stack.indexOf("shop.test.ts");
    expect(throwSite).toBeGreaterThan(-1);
    expect(stack).toContain("examples/shop/worker.ts");
    expect(marker).toBeGreaterThan(throwSite);
    expect(local).toBeGreaterThan(marker);
  });

  it("PROBE inside the cart DO: the catch site now sees fields and the remote stack", async () => {
    const { user, widget } = ids();
    await inventories().get(widget).restock(1);
    const report = await carts().get(user).probeReserveFailure(widget, 5);
    expect(report).toMatchObject({
      instanceofOutOfStock: false, // still by design
      instanceofError: true,
      constructorName: "Error",
      name: "OutOfStockError",
      message: `out of stock: product '${widget}' has 1 left, cannot reserve 5`,
      // Post-fix: fields arrive inside the catching DO.
      productIdField: widget,
      availableField: 1,
    });
    // The first stack frame at the catch site is the real throw site.
    expect(report.stackHead).toContain("OutOfStockError: out of stock");
    expect(report.stackHead).toContain("at Inventory.reserve");
  });

  it("PROBE two hops (test -> cart -> inventory): full causal chain preserved", async () => {
    const { user, widget } = ids();
    await inventories().get(widget).restock(1);
    const cart = carts().get(user);
    await cart.addItem(widget, 4);

    let caught: unknown;
    try {
      await cart.checkout();
    } catch (error) {
      caught = error;
    }
    const e = caught as OutOfStockError;
    expect(e.name).toBe("OutOfStockError");
    expect(e.message).toBe(
      `out of stock: product '${widget}' has 1 left, cannot reserve 4`,
    );
    expect(caught instanceof OutOfStockError).toBe(false); // still by design
    // Post-fix: fields survive BOTH hops (re-wrapped at each hop).
    expect(e.productId).toBe(widget);
    expect(e.requested).toBe(4);
    expect(e.available).toBe(1);
    // Post-fix stack is a causal chain, innermost first:
    //   Inventory.reserve (worker.ts)
    //   ... at [remote call inventory.reserve() via generic-durable-objects]
    //   Cart.checkout (worker.ts)
    //   ... at [remote call cart.checkout() via generic-durable-objects]
    //   <test frames>
    const stack = e.stack ?? "";
    const throwSite = stack.indexOf("at Inventory.reserve");
    const innerMarker = stack.indexOf(
      "at [remote call inventory.reserve() via generic-durable-objects]",
    );
    const rethrowSite = stack.indexOf("at Cart.checkout");
    const outerMarker = stack.indexOf(
      "at [remote call cart.checkout() via generic-durable-objects]",
    );
    const local = stack.indexOf("shop.test.ts");
    expect(throwSite).toBeGreaterThan(-1);
    expect(innerMarker).toBeGreaterThan(throwSite);
    expect(rethrowSite).toBeGreaterThan(innerMarker);
    expect(outerMarker).toBeGreaterThan(rethrowSite);
    expect(local).toBeGreaterThan(outerMarker);
  });

  it("PROBE transport failure: non-serializable return values are wrapped with call context", async () => {
    const { widget } = ids();
    const inv = inventories().get(widget);
    await inv.restock(1);
    let caught: unknown;
    try {
      // snapshot() returns a custom class instance, which Workers RPC
      // cannot serialize.
      await inv.snapshot();
    } catch (error) {
      caught = error;
    }
    const e = caught as Error & { cause?: Error };
    expect(e.message).toBe(
      'generic-durable-objects: call to inventory.snapshot() failed: ' +
        'Could not serialize object of type "StockSnapshot". ' +
        'This type does not support serialization.',
    );
    expect(e.cause?.name).toBe("DataCloneError");
  });
});
