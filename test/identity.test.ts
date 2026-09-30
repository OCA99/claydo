import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../src/index";
import { fireScheduledAlarm } from "../src/test";

const app = kinds(env.APP_DO);

describe("native facet identity", () => {
  it("isolates storage when two facets have the same logical native ID", async () => {
    const a = app.counter.get("equal:logical:id");
    const b = app.otherCounter.get("equal:logical:id");
    expect(a.id.equals(b.id)).toBe(false);
    await a.increment(7);
    await b.increment(2);
    expect(await a.whoAmI()).toEqual(await b.whoAmI());
    expect((await a.whoAmI()).id).toBe(
      env.APP_DO.idFromName("equal:logical:id").toString(),
    );
    expect(await a.value()).toBe(7);
    expect(await b.value()).toBe(2);
  });

  it("restores the logical native ID after both facet and supervisor restart", async () => {
    const named = app.counter.get("cold:native:id");
    await named.increment(6);
    const expected = await named.whoAmI();
    const raw = env.APP_DO.get(named.id);
    await runInDurableObject(raw, (_instance, ctx) => {
      ctx.facets.abort("counter", "test cold facet");
    });
    await evictDurableObject(raw);
    const restored = app.counter.fromId(named.id.toString());
    expect(await restored.whoAmI()).toEqual(expected);
    expect(await restored.value()).toBe(6);
  });

  it("retains old facet data when a named instance upgrades its inherited ID", async () => {
    const raw = env.APP_DO.getByName("counter:legacy:named");
    await runInDurableObject(raw, async (_instance, ctx) => {
      await ctx.storage.put("kind", "counter");
      const entry = (
        ctx.exports as unknown as {
          AppDO(options: { props: unknown }): DurableObjectClass;
        }
      ).AppDO;
      const configured = entry({
        props: { __claydo: { v: 1, kind: "counter", host: "AppDO" } },
      });
      const facet = ctx.facets.get("counter", () => ({
        class: configured,
      })) as unknown as {
        __claydoCall(
          kind: string,
          method: string,
          args: unknown[],
          init: boolean,
        ): Promise<unknown>;
      };
      try {
        await facet.__claydoCall("counter", "increment", [9], true);
      } finally {
        const dispose = (Symbol as unknown as { dispose: symbol }).dispose;
        for (const handle of [facet, configured]) {
          const release = Reflect.get(handle, dispose);
          if (typeof release === "function") release.call(handle);
        }
      }
      ctx.facets.abort("counter", "test upgrading facet");
    });
    await evictDurableObject(raw);
    const named = app.counter.get("legacy:named");
    expect(await named.value()).toBe(9);
    expect((await named.whoAmI()).name).toBe("legacy:named");
    expect((await named.whoAmI()).id).toBe(
      env.APP_DO.idFromName("legacy:named").toString(),
    );
  });

  it("relays alarms to the physical parent after an ID-based cold start", async () => {
    const reminder = app.reminder.get("cold:alarm");
    await reminder.remindAt(Date.now() + 3_600_000, "parent-owned");
    const raw = env.APP_DO.get(reminder.id);
    await runInDurableObject(raw, (_instance, ctx) => {
      ctx.facets.abort("reminder", "test cold facet");
    });
    await evictDurableObject(raw);
    const restored = app.reminder.fromId(reminder.id.toString());
    expect(await restored.alarmTime()).not.toBeNull();
    expect(await fireScheduledAlarm(restored)).toBe(true);
    expect(((await restored.fired()) as { payload: string }).payload).toBe(
      "parent-owned",
    );
    expect(await restored.alarmTime()).toBeNull();
  });
});

describe("framework-agnostic startup", () => {
  it("does not inspect or call private framework startup methods", async () => {
    expect(await app.lifecycle.get("no-implicit-hook").starts()).toBe(0);
  });

  it("awaits an explicit hook once for concurrent first calls", async () => {
    const lifecycle = kinds(env.EXPLICIT).lifecycle.get("explicit-hook");
    expect(await Promise.all([lifecycle.starts(), lifecycle.starts()])).toEqual(
      [1, 1],
    );
  });
});
