import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isClaydoError, kind, kinds, union } from "../src/index";
import type { ClaydoError } from "../src/index";
import { Counter } from "./fixtures/worker";

const app = kinds(env.APP_DO);

async function caught(promise: Promise<unknown>): Promise<ClaydoError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as ClaydoError;
}

describe("RPC through the typed stub", () => {
  it("calls kind methods and returns their values", async () => {
    const counter = app.counter.get("rpc-basic");
    expect(await counter.increment(2)).toBe(2);
    expect(await counter.increment(3)).toBe(5);
    expect(await counter.value()).toBe(5);
  });

  it("passes default parameters through", async () => {
    const counter = app.counter.get("rpc-defaults");
    expect(await counter.increment()).toBe(1);
  });

  it("exposes id, name, kind, and the raw stub as metadata", async () => {
    const counter = app.counter.get("rpc-meta");
    expect(counter.kind).toBe("counter");
    expect(counter.name).toBe("rpc-meta");
    expect(counter.id.toString()).toBe(
      app.counter.idFromName("rpc-meta").toString(),
    );
    expect(typeof counter.stub.fetch).toBe("function");
  });

  it("is not a thenable: await of the stub returns the stub", async () => {
    const counter = app.counter.get("rpc-thenable");
    const awaited = await counter;
    expect(awaited.kind).toBe("counter");
  });

  it("kind() and kinds() reach the same instance", async () => {
    const viaKinds = app.counter.get("rpc-same");
    const viaKind = kind(env.APP_DO, "counter").get("rpc-same");
    await viaKinds.increment(7);
    expect(await viaKind.value()).toBe(7);
  });
});

describe("identity and isolation", () => {
  it("separates equal names under different kinds", async () => {
    const counter = app.counter.get("shared-name");
    const reminder = app.reminder.get("shared-name");
    expect(counter.id.toString()).not.toBe(reminder.id.toString());
  });

  it("reports the logical name without the kind prefix", async () => {
    const who = await app.counter.get("iso-name").whoAmI();
    expect(who.name).toBe("iso-name");
  });

  it("keeps names with colons intact after the kind prefix", async () => {
    const who = await app.counter.get("a:b:c").whoAmI();
    expect(who.name).toBe("a:b:c");
  });

  it("isolates kind storage per instance", async () => {
    await app.counter.get("iso-1").increment(10);
    expect(await app.counter.get("iso-2").value()).toBe(0);
  });

  it("persists no routing state for named instances", async () => {
    await app.counter.get("iso-stateless").increment();
    const raw = env.APP_DO.get(app.counter.idFromName("iso-stateless"));
    const stored = await runInDurableObject(raw, (_instance, ctx) =>
      ctx.storage.get("kind"),
    );
    expect(stored).toBeUndefined();
  });
});

describe("unique-ID instances", () => {
  it("initializes on first contact and stays reachable by id", async () => {
    const created = app.counter.unique();
    await created.increment(4);
    const found = app.counter.fromId(created.id.toString());
    expect(await found.value()).toBe(4);
  });

  it("pins the kind exactly once, in instance storage", async () => {
    const created = app.counter.unique();
    await created.increment();
    const raw = env.APP_DO.get(created.id);
    const stored = await runInDurableObject(raw, (_instance, ctx) =>
      ctx.storage.get("kind"),
    );
    expect(stored).toBe("counter");
  });

  it("fromId() never initializes: an untouched id fails with a code", async () => {
    const untouched = env.APP_DO.newUniqueId();
    const error = await caught(
      app.counter.fromId(untouched.toString()).value(),
    );
    expect(isClaydoError(error)).toBe(true);
    expect(error.code).toBe("CLAYDO_UNINITIALIZED");
    expect(error.message).toContain("fromId()");
  });

  it("rejects access under the wrong kind with a mismatch code", async () => {
    const created = app.counter.unique();
    await created.increment();
    const error = await caught(
      app.vault.fromId(created.id.toString()).open(),
    );
    expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
    expect((error as ClaydoError & { actualKind?: string }).actualKind).toBe(
      "counter",
    );
    expect(
      (error as ClaydoError & { expectedKind?: string }).expectedKind,
    ).toBe("vault");
  });

  it("rejects a named instance accessed under the wrong kind", async () => {
    await app.counter.get("mismatch-named").increment();
    const id = app.counter.idFromName("mismatch-named").toString();
    const error = await caught(app.vault.fromId(id).open());
    expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
  });
});

describe("error fidelity across the stub", () => {
  it("keeps name, message, code, and custom fields of kind errors", async () => {
    const error = await caught(app.vault.get("errors").open());
    expect(error.name).toBe("VaultLockedError");
    expect(error.message).toBe("the vault is locked");
    expect((error as unknown as { code: string }).code).toBe("VAULT_LOCKED");
    expect(
      (error as unknown as { retryAfterMs: number }).retryAfterMs,
    ).toBe(1500);
    expect(isClaydoError(error)).toBe(false);
  });

  it("surfaces kind constructor failures on every call", async () => {
    const error = await caught(app.broken.get("errors").anything());
    expect(error.message).toContain("broken on purpose");
  });

  it("reports a missing method with CLAYDO_NO_METHOD", async () => {
    const counter = app.counter.get("errors") as unknown as {
      noSuchMethod(): Promise<void>;
    };
    const error = await caught(counter.noSuchMethod());
    expect((error as ClaydoError).code).toBe("CLAYDO_NO_METHOD");
    expect(error.message).toContain("noSuchMethod");
  });

  it("explains a plain property accessed as a method", async () => {
    const counter = app.counter.get("errors") as unknown as {
      label(): Promise<void>;
    };
    const error = await caught(counter.label());
    expect((error as ClaydoError).code).toBe("CLAYDO_NO_METHOD");
    expect(error.message).toContain("property, not a method");
  });

  it("explains a function-valued instance field", async () => {
    const counter = app.counter.get("errors") as unknown as {
      fieldFn(): Promise<void>;
    };
    const error = await caught(counter.fieldFn());
    expect((error as ClaydoError).code).toBe("CLAYDO_NO_METHOD");
    expect(error.message).toContain("instance field");
  });

  it("refuses reserved and internal method names", async () => {
    const counter = app.counter.get("errors") as unknown as Record<
      string,
      () => Promise<void>
    >;
    for (const name of ["alarm", "webSocketMessage", "__claydoCall"]) {
      const error = await caught(counter[name]!());
      expect((error as ClaydoError).code).toBe("CLAYDO_NO_METHOD");
    }
  });

  it("fails when a return value cannot serialize", async () => {
    const error = await caught(app.counter.get("errors").unserializable());
    expect(error.message).toMatch(/serial|clone|function/i);
  });
});

describe("kinds without a DurableObject base", () => {
  it("runs plain (ctx, env) classes", async () => {
    expect(await app.plain.get("plain-1").touch()).toBe("plain");
  });
});

describe("raw namespace access", () => {
  it("explains un-prefixed names with a code and guidance", async () => {
    const raw = env.APP_DO.get(
      env.APP_DO.idFromName("no-prefix"),
    ) as unknown as {
      __claydoCall(
        kind: string,
        method: string,
        args: unknown[],
        init: boolean,
      ): Promise<unknown>;
    };
    const error = await caught(
      raw.__claydoCall("counter", "value", [], false),
    );
    expect((error as ClaydoError).code).toBe("CLAYDO_UNINITIALIZED");
    expect(error.message).toContain("kind() helper");
  });
});

describe("registry validation", () => {
  it("rejects kind names with a colon", () => {
    expect(() => union({ "bad:name": Counter })).toThrowError(
      /invalid kind name/,
    );
  });

  it("rejects kind names with a reserved prefix", () => {
    expect(() => union({ __bad: Counter })).toThrowError(
      /invalid kind name/,
    );
  });

  it("rejects kinds that define reserved stub keys as methods", () => {
    class BadKind {
      constructor(_ctx: DurableObjectState, _env: unknown) {}
      async stub(): Promise<void> {}
    }
    expect(() => union({ bad: BadKind })).toThrowError(/reserves that name/);
  });
});

describe("union configuration errors", () => {
  it("supports direct export with the name option", async () => {
    const renamed = kinds(env.RENAMED);
    expect(await renamed.counter.get("renamed-1").increment(5)).toBe(5);
  });

  it("guides a direct export that is missing the name option", async () => {
    const misnamed = kinds(env.MISNAMED);
    const error = await caught(misnamed.counter.get("misnamed-1").value());
    expect((error as ClaydoError).code).toBe("CLAYDO_CONFIG");
    expect(error.message).toContain('{ name: "..." }');
  });
});

describe("role selection", () => {
  const Union = union({ counter: Counter });

  it("rejects construction with props that claydo did not write", () => {
    for (const props of [
      { anything: true },
      { claydoFacet: true },
      { claydoFacet: true, kind: "counter" },
      "nonsense",
      42,
    ]) {
      expect(
        () => new Union({ props } as unknown as DurableObjectState, {}),
      ).toThrowError(/reserves ctx\.props/);
    }
  });

  it("refuses facet-internal methods on a supervisor", async () => {
    await app.counter.get("role-guard").increment();
    const raw = env.APP_DO.get(
      app.counter.idFromName("role-guard"),
    ) as unknown as {
      __claydoAlarm(info: unknown): Promise<void>;
    };
    const error = await caught(
      raw.__claydoAlarm({ scheduledTime: 0, isRetry: false, retryCount: 0 }),
    );
    expect((error as ClaydoError).code).toBe("CLAYDO_CONFIG");
    expect(error.message).toContain("internal to claydo");
  });
});
