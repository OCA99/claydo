import { DurableObject } from "cloudflare:workers";

/**
 * KindA: has its own migration entry (namespace exists). Exercises SQL, KV,
 * alarms, and hibernating WebSockets — the surfaces claydo kinds rely on.
 */
export class KindA extends DurableObject {
  async kvPut(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  async kvGet(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(key);
  }

  sqlPut(value: string): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)`,
    );
    this.ctx.storage.sql.exec(`INSERT INTO t (v) VALUES (?)`, value);
  }

  sqlRows(): string[] {
    try {
      return this.ctx.storage.sql
        .exec<{ v: string }>(`SELECT v FROM t ORDER BY id`)
        .toArray()
        .map((row) => row.v);
    } catch {
      return [];
    }
  }

  whoami(): { id: string; name: string | null } {
    return { id: this.ctx.id.toString(), name: this.ctx.id.name ?? null };
  }

  async setAlarmIn(ms: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }

  async getAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.put("alarm-fired-at", Date.now());
  }

  async alarmFiredAt(): Promise<number | null> {
    return (await this.ctx.storage.get<number>("alarm-fired-at")) ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(`kindA:${this.ctx.id.name ?? "?"}`);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(`echo:${message}`);
  }
}

/**
 * KindB: exported but NOT in any migration — no namespace of its own.
 * Tests whether "child-only" classes can back facets.
 */
export class KindB extends DurableObject {
  ping(): string {
    return "B";
  }

  sqlRows(): string[] {
    try {
      return this.ctx.storage.sql
        .exec<{ v: string }>(`SELECT v FROM t ORDER BY id`)
        .toArray()
        .map((row) => row.v);
    } catch {
      return [];
    }
  }

  whoami(): { id: string; name: string | null } {
    return { id: this.ctx.id.toString(), name: this.ctx.id.name ?? null };
  }
}

/** KindC: migrated, used to test abort + class swap on live storage. */
export class KindC extends DurableObject {
  ping(): string {
    return "C";
  }

  sqlRows(): string[] {
    try {
      return this.ctx.storage.sql
        .exec<{ v: string }>(`SELECT v FROM t ORDER BY id`)
        .toArray()
        .map((row) => row.v);
    } catch {
      return [];
    }
  }

  /** Nested facets: can a facet spawn its own children? */
  nested(): unknown {
    try {
      const sub = this.ctx.facets.get("sub", () => ({
        class: (this.ctx.exports as unknown as Record<string, unknown>)
          .KindA as DurableObjectClass,
      })) as unknown as { whoami(): Promise<unknown> };
      return sub.whoami();
    } catch (error) {
      return `nested error: ${String(error)}`;
    }
  }

  /** What does ctx.exports look like from INSIDE a facet? */
  facetExports(): string[] {
    return Object.keys(
      this.ctx.exports as unknown as Record<string, unknown>,
    );
  }

  /** Did startup props reach the facet instance? */
  myProps(): unknown {
    return (this.ctx as unknown as { props?: unknown }).props ?? null;
  }
}

type AnyStub = Record<string, (...args: unknown[]) => Promise<unknown>> & {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export class Supervisor extends DurableObject {
  #exports(): Record<string, unknown> {
    return this.ctx.exports as unknown as Record<string, unknown>;
  }

  #facet(name: string, className: string, id?: string): AnyStub {
    return this.ctx.facets.get(name, () => ({
      class: this.#exports()[className] as DurableObjectClass,
      ...(id !== undefined ? { id } : {}),
    })) as unknown as AnyStub;
  }

  /** What does ctx.exports actually contain, and of what shape? */
  listExports(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.#exports())) {
      out[key] = typeof value;
    }
    return out;
  }

  /** P1: statically-bundled class (with migration) as a facet. */
  async probeStatic(): Promise<unknown> {
    const facet = this.#facet("a", "KindA");
    await facet.kvPut("greeting", "hello");
    return {
      whoami: await facet.whoami(),
      supervisorId: this.ctx.id.toString(),
      value: await facet.kvGet("greeting"),
    };
  }

  /** P1b: class exported but present in NO migration (child-only). */
  async probeUnmigrated(): Promise<unknown> {
    const facet = this.#facet("b", "KindB");
    return facet.ping();
  }

  /** P1c: passing the raw class constructor instead of ctx.exports. */
  async probeRawClass(): Promise<string> {
    try {
      const facet = this.ctx.facets.get("raw", () => ({
        class: KindA as unknown as DurableObjectClass,
      })) as unknown as AnyStub;
      return `ok: ${JSON.stringify(await facet.whoami())}`;
    } catch (error) {
      return `error: ${String(error)}`;
    }
  }

  /** P2: storage isolation between supervisor and facet. */
  async probeIsolation(): Promise<unknown> {
    await this.ctx.storage.put("supervisor-secret", "s3cret");
    const facet = this.#facet("a", "KindA");
    await facet.sqlPut("row-1");
    const facetSeesSecret = await facet.kvGet("supervisor-secret");
    const supervisorKeys = [...(await this.ctx.storage.list()).keys()];
    let supervisorSeesFacetTable: boolean;
    try {
      this.ctx.storage.sql.exec(`SELECT 1 FROM t LIMIT 1`);
      supervisorSeesFacetTable = true;
    } catch {
      supervisorSeesFacetTable = false;
    }
    return {
      facetSeesSecret: facetSeesSecret ?? null,
      supervisorKeys,
      supervisorSeesFacetTable,
      facetRows: await facet.sqlRows(),
    };
  }

  /** P3: alarms inside a facet. */
  async probeAlarmSet(): Promise<unknown> {
    const facet = this.#facet("a", "KindA");
    await facet.setAlarmIn(300);
    return {
      facetAlarm: await facet.getAlarm(),
      supervisorAlarm: await this.ctx.storage.getAlarm(),
    };
  }

  async probeAlarmCheck(): Promise<unknown> {
    const facet = this.#facet("a", "KindA");
    return {
      firedAt: await facet.alarmFiredAt(),
      supervisorAlarmFired:
        (await this.ctx.storage.get<number>("alarm-fired-at")) ?? null,
    };
  }

  /** Supervisor's own alarm handler — relays into a facet, claydo-style. */
  async alarm(): Promise<void> {
    await this.ctx.storage.put("alarm-fired-at", Date.now());
    await this.#facet("a", "KindA").kvPut("alarm-relay", "relayed");
  }

  /** P4: forward a WebSocket upgrade into the facet. */
  async fetch(request: Request): Promise<Response> {
    const facet = this.#facet("a", "KindA");
    return facet.fetch(request);
  }

  /** P5: abort, then restart the SAME facet name with a DIFFERENT class. */
  async probeSwap(): Promise<unknown> {
    const before = this.#facet("swap", "KindA");
    await before.sqlPut("written-by-A");
    this.ctx.facets.abort("swap", new Error("upgrading"));
    let stale: string;
    try {
      await before.sqlRows();
      stale = "old stub still works";
    } catch (error) {
      stale = `old stub invalidated: ${String(error).slice(0, 60)}`;
    }
    const after = this.#facet("swap", "KindC");
    return {
      stale,
      pingViaNewClass: await after.ping(),
      rowsSurvivedSwap: await after.sqlRows(),
    };
  }

  /** What IS ctx.exports.KindB (exported, but in no migration)? */
  async probeUnmigratedShape(): Promise<unknown> {
    const kindB = this.#exports()["KindB"] as Record<string, unknown>;
    const result: Record<string, unknown> = {
      typeof: typeof kindB,
      keys: Object.keys(kindB ?? {}),
      constructorName: (kindB as { constructor?: { name?: string } })
        ?.constructor?.name,
    };
    try {
      const called = (kindB as unknown as (o: object) => unknown)({});
      result.callable = `ok: ${typeof called}`;
    } catch (error) {
      result.callable = `error: ${String(error).slice(0, 90)}`;
    }
    return result;
  }

  /** Supervisor alarm still works, and can dispatch into facets. */
  async probeSupervisorAlarm(): Promise<unknown> {
    await this.ctx.storage.setAlarm(Date.now() + 200);
    return this.ctx.storage.getAlarm();
  }

  async probeSupervisorAlarmFired(): Promise<unknown> {
    return {
      supervisorFiredAt:
        (await this.ctx.storage.get<number>("alarm-fired-at")) ?? null,
      relayedToFacet: await this.#facet("a", "KindA").kvGet("alarm-relay"),
    };
  }

  /** Nested facets + exports visibility inside a facet. */
  async probeNested(): Promise<unknown> {
    const facet = this.#facet("c", "KindC");
    return {
      facetExports: await facet.facetExports(),
      nested: await facet.nested(),
    };
  }

  /**
   * One generic class, many facets, configured via props: the claydo-v2
   * shape. LoopbackDurableObjectClass is callable with { props }.
   */
  async probeProps(): Promise<unknown> {
    const makeClass = this.#exports()["KindC"] as (opts: {
      props?: unknown;
    }) => DurableObjectClass;
    const facet = this.ctx.facets.get("props-facet", () => ({
      class: makeClass({ props: { kind: "chat", note: 42 } }),
    })) as unknown as AnyStub;
    return facet.myProps();
  }

  /** P6: delete wipes facet storage. */
  async probeDelete(): Promise<unknown> {
    const facet = this.#facet("doomed", "KindA");
    await facet.sqlPut("to-be-deleted");
    this.ctx.facets.delete("doomed");
    const fresh = this.#facet("doomed", "KindA");
    return { rowsAfterDelete: await fresh.sqlRows() };
  }

  /** P7: the undocumented clone(src, dst). */
  async probeClone(): Promise<unknown> {
    const src = this.#facet("clone-src", "KindA");
    await src.sqlPut("cloned-row");
    await src.kvPut("k", "v");
    try {
      this.ctx.facets.clone("clone-src", "clone-dst");
      const dst = this.#facet("clone-dst", "KindA");
      return {
        ok: true,
        dstRows: await dst.sqlRows(),
        dstKv: await dst.kvGet("k"),
        srcRows: await src.sqlRows(),
      };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  /** P8: facet identity — inherited vs custom id. */
  async probeIdentity(): Promise<unknown> {
    const inherited = this.#facet("a", "KindA");
    const custom = this.#facet("named", "KindA", "my-custom-facet-id");
    return {
      supervisor: { id: this.ctx.id.toString(), name: this.ctx.id.name ?? null },
      inherited: await inherited.whoami(),
      custom: await custom.whoami(),
    };
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("spike");
  },
};
