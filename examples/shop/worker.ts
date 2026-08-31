/**
 * shop example for claydo.
 *
 * Two kinds share one host DO class:
 *  - `inventory`: one instance per product (`get(productId)`), stock in SQLite.
 *  - `cart`: one instance per user. `checkout()` reserves stock on every
 *    product's inventory instance (cross-kind RPC from inside the DO) and
 *    compensates (releases) already-reserved stock when any product is short.
 */
import { DurableObject, instanceName, kind, kinds, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<ShopDO>;
}

/** Typed error thrown by `Inventory.reserve()` when stock is insufficient. */
export class OutOfStockError extends Error {
  readonly productId: string;
  readonly requested: number;
  readonly available: number;

  constructor(productId: string, requested: number, available: number) {
    super(
      `out of stock: product '${productId}' has ${available} left, ` +
        `cannot reserve ${requested}`,
    );
    this.name = "OutOfStockError";
    this.productId = productId;
    this.requested = requested;
    this.available = available;
  }
}

/** A custom class used by a Test: not structured-cloneable over RPC. */
export class StockSnapshot {
  constructor(readonly qty: number) {}
}

/** Per-product stock, held in the instance's SQLite database. */
export class Inventory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS stock (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        qty INTEGER NOT NULL CHECK (qty >= 0)
      )`,
    );
    ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO stock (id, qty) VALUES (0, 0)`,
    );
  }

  stock(): number {
    return this.ctx.storage.sql
      .exec<{ qty: number }>(`SELECT qty FROM stock WHERE id = 0`)
      .one().qty;
  }

  restock(qty: number): number {
    return this.#adjust(qty);
  }

  /** Throws {@link OutOfStockError} when fewer than `qty` units remain. */
  reserve(qty: number): number {
    const available = this.stock();
    if (available < qty) {
      const productId = instanceName(this.ctx) ?? this.ctx.id.toString();
      throw new OutOfStockError(productId, qty, available);
    }
    return this.#adjust(-qty);
  }

  release(qty: number): number {
    return this.#adjust(qty);
  }

  /**
   * Test instrument: returns a custom class instance, which Workers RPC
   * cannot serialize, to exercise the transport-failure wrapping.
   */
  snapshot(): StockSnapshot {
    return new StockSnapshot(this.stock());
  }

  #adjust(delta: number): number {
    return this.ctx.storage.sql
      .exec<{ qty: number }>(
        `UPDATE stock SET qty = qty + ? WHERE id = 0 RETURNING qty`,
        delta,
      )
      .one().qty;
  }
}

export interface OrderLine {
  productId: string;
  qty: number;
}

/** Per-user cart. `checkout()` coordinates the per-product inventories. */
export class Cart extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS items (
        product_id TEXT PRIMARY KEY,
        qty INTEGER NOT NULL CHECK (qty > 0)
      )`,
    );
  }

  addItem(productId: string, qty: number): void {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error(`qty must be a positive integer, got ${qty}`);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO items (product_id, qty) VALUES (?, ?)
       ON CONFLICT(product_id) DO UPDATE SET qty = qty + excluded.qty`,
      productId,
      qty,
    );
  }

  items(): OrderLine[] {
    return this.ctx.storage.sql
      .exec<{ product_id: string; qty: number }>(
        `SELECT product_id, qty FROM items ORDER BY product_id`,
      )
      .toArray()
      .map((row) => ({ productId: row.product_id, qty: row.qty }));
  }

  /**
   * Reserves stock for every line. When any reservation fails, releases the
   * reservations made so far (compensation) and rethrows the failure.
   *
   * The compensation deliberately catches every error, so it needs no error
   * class or name matching at all — the revived error's typed fields
   * only matter to callers that want to *report* the failure.
   */
  async checkout(): Promise<{ lines: OrderLine[] }> {
    const lines = this.items();
    if (lines.length === 0) throw new Error("cart is empty");

    const inventories = kinds(this.env.APP_DO).inventory;
    const reserved: OrderLine[] = [];
    for (const line of lines) {
      try {
        await inventories.get(line.productId).reserve(line.qty);
        reserved.push(line);
      } catch (error) {
        for (const undo of reserved) {
          await inventories.get(undo.productId).release(undo.qty);
        }
        throw error;
      }
    }

    this.ctx.storage.sql.exec(`DELETE FROM items`);
    return { lines };
  }

  /**
   * Test instrument: catches the error from a failing cross-kind
   * `reserve()` INSIDE the cart DO and reports what actually arrived.
   */
  async probeReserveFailure(productId: string, qty: number): Promise<{
    instanceofOutOfStock: boolean;
    instanceofError: boolean;
    constructorName: string;
    name: string;
    message: string;
    productIdField: unknown;
    availableField: unknown;
    stackHead: string;
  }> {
    try {
      await kind(this.env.APP_DO, "inventory").get(productId).reserve(qty);
      throw new Error("expected reserve() to fail");
    } catch (error) {
      const e = error as OutOfStockError;
      return {
        instanceofOutOfStock: error instanceof OutOfStockError,
        instanceofError: error instanceof Error,
        constructorName: (error as object).constructor.name,
        name: e.name,
        message: e.message,
        productIdField: e.productId,
        availableField: e.available,
        stackHead: (e.stack ?? "").split("\n").slice(0, 2).join("\n"),
      };
    }
  }
}

export class ShopDO extends union({
  cart: Cart,
  inventory: Inventory,
}) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, id, action] = url.pathname.split("/");

    if (resource === "inventory" && id !== undefined) {
      const inventory = kind(env.APP_DO, "inventory").get(id);
      if (request.method === "POST" && action === "restock") {
        const { qty } = (await request.json()) as { qty: number };
        return Response.json({ stock: await inventory.restock(qty) });
      }
      return Response.json({ stock: await inventory.stock() });
    }

    if (resource === "cart" && id !== undefined) {
      const cart = kind(env.APP_DO, "cart").get(id);
      if (request.method === "POST" && action === "items") {
        const { productId, qty } = (await request.json()) as OrderLine;
        await cart.addItem(productId, qty);
        return Response.json(await cart.items(), { status: 201 });
      }
      if (request.method === "POST" && action === "checkout") {
        try {
          return Response.json(await cart.checkout());
        } catch (error) {
          // `instanceof OutOfStockError` does not survive RPC (by design);
          // typed fields DO survive, so the response can carry them —
          // though they arrive untyped and need the cast below.
          const e = error as Error & Partial<OutOfStockError>;
          if (e.name === "OutOfStockError") {
            return Response.json(
              {
                error: e.name,
                message: e.message,
                productId: e.productId,
                available: e.available,
              },
              { status: 409 },
            );
          }
          return Response.json(
            { error: e.name, message: e.message },
            { status: 500 },
          );
        }
      }
      return Response.json(await cart.items());
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
