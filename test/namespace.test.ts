import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kindNamespace, kinds } from "../src/index";
import { caught } from "./helpers";

describe("kind namespace compatibility", () => {
  const counter = kindNamespace(env.APP_DO, "counter");

  it("keeps logical names including colons and reaches the typed accessor", async () => {
    const id = counter.idFromName("namespace:a:b");
    const stub = counter.get(id);
    expect(stub.name).toBe("namespace:a:b");
    expect(await stub.increment(3)).toBe(3);
    expect(await kinds(env.APP_DO).counter.get("namespace:a:b").value()).toBe(
      3,
    );
    expect(await stub.whoAmI()).toEqual({
      name: "namespace:a:b",
      id: env.APP_DO.idFromName("namespace:a:b").toString(),
    });
  });

  it("getByName isolates equal names across kinds", async () => {
    const a = counter.getByName("namespace-shared");
    const b = kindNamespace(env.APP_DO, "reminder").getByName(
      "namespace-shared",
    );
    expect(a.id.equals(b.id)).toBe(false);
    expect(await a.increment()).toBe(1);
  });

  it("reconstructs IDs with a new adapter after eviction", async () => {
    const stub = counter.getByName("namespace-cold");
    await stub.increment(4);
    await evictDurableObject(env.APP_DO.get(stub.id));
    const fresh = kindNamespace(env.APP_DO, "counter");
    expect(
      await fresh.get(fresh.idFromString(stub.id.toString())).value(),
    ).toBe(4);
  });

  it("initializes unique IDs and reopens them without a name cache", async () => {
    const id = counter.newUniqueId();
    expect(await counter.get(id).increment(2)).toBe(2);
    const fresh = kindNamespace(env.APP_DO, "counter");
    expect(await fresh.get(fresh.idFromString(id.toString())).value()).toBe(2);
    expect((await fresh.get(id).whoAmI()).name).toBeUndefined();
  });

  it("initializes on fetch-first access", async () => {
    const response = await counter
      .get(counter.newUniqueId())
      .fetch("https://do/value");
    expect(await response.json()).toEqual({ value: 0 });
  });

  it("retains method types and runtime behavior for plain class kinds", async () => {
    expect(
      await kindNamespace(env.APP_DO, "plain")
        .getByName("namespace-plain")
        .touch(),
    ).toBe("plain");
  });

  it("rejects IDs belonging to another kind", async () => {
    const id = counter.idFromName("namespace-wrong-kind");
    await counter.get(id).increment();
    const error = await caught(
      kindNamespace(env.APP_DO, "vault").get(id).open(),
    );
    expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
  });

  it("forwards get options even for reconstructed IDs and scopes jurisdiction", async () => {
    const seen: unknown[] = [];
    const jurisdictions: DurableObjectJurisdiction[] = [];
    const uniqueOptions: unknown[] = [];
    const observed = new Proxy(env.APP_DO, {
      get(target, property) {
        // workerd does not implement jurisdiction restrictions. Record
        // delegation here; exercise real routing through get() below.
        if (property === "jurisdiction")
          return (jurisdiction: DurableObjectJurisdiction) => {
            jurisdictions.push(jurisdiction);
            return observed;
          };
        if (property === "newUniqueId")
          return (options?: DurableObjectNamespaceNewUniqueIdOptions) => {
            uniqueOptions.push(options);
            return target.newUniqueId();
          };
        if (property === "get")
          return (
            id: DurableObjectId,
            options?: DurableObjectNamespaceGetDurableObjectOptions,
          ) => {
            seen.push(options);
            return target.get(id, options);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ns = kindNamespace(observed, "counter");
    const options = {
      locationHint: "weur",
      routingMode: "primary-only",
    } as const;
    const id = ns.idFromName("namespace-options");
    ns.get(id, options);
    ns.get(ns.idFromString(id.toString()), options);
    ns.getByName("namespace-options", options);
    expect(seen).toEqual([options, options, options]);
    const eu = ns.jurisdiction("eu");
    expect(jurisdictions).toEqual(["eu"]);
    expect(await eu.getByName("namespace-scoped").increment()).toBe(1);
    eu.newUniqueId();
    ns.newUniqueId({ jurisdiction: "eu" });
    expect(uniqueOptions).toEqual([undefined, { jurisdiction: "eu" }]);
  });
});

// Compile-time API coverage, never invoked.
function typeChecks() {
  // @ts-expect-error Unknown kinds are rejected.
  kindNamespace(env.APP_DO, "missing");
  // @ts-expect-error The counter namespace cannot call reminder methods.
  kindNamespace(env.APP_DO, "counter").getByName("typed").remindAt(0, "x");
}
void typeChecks;
