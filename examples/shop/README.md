# shop

A small shop built on claydo: two kinds hosted by one Durable Object class
(`ShopDO`). Each product and each user cart is its own instance with its own
SQLite database, and `Cart.checkout()` orchestrates reservations across the
per-product inventory instances with compensation on failure.

## Kinds

- `inventory` — one instance per product. Holds the stock count and exposes
  `stock()`, `restock()`, `reserve()` (throws `OutOfStockError` when short),
  and `release()`.
- `cart` — one instance per user. Collects order lines and, on `checkout()`,
  reserves stock on every product via cross-kind calls; when any product is
  short it releases the reservations already made and rethrows.

The tests also show how errors thrown by a kind travel across RPC hops:
`name`, `message`, and custom fields such as `productId` survive, while
`instanceof` the custom class does not — match on `error.name`.

## Running the tests

From the repository root:

```sh
npx vitest run --config examples/shop/vitest.config.ts
```

Typecheck:

```sh
npx tsc --noEmit -p examples/shop/tsconfig.json
```
