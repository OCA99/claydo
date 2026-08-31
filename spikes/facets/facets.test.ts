import { env } from "cloudflare:test";
import { expect, it } from "vitest";

const sup = () =>
  (env as { SUPERVISOR: DurableObjectNamespace }).SUPERVISOR.get(
    (env as { SUPERVISOR: DurableObjectNamespace }).SUPERVISOR.idFromName(
      "spike",
    ),
  ) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };

it("P0: what ctx.exports contains", async () => {
  console.log("EXPORTS:", JSON.stringify(await sup().listExports()));
});

it("P1: static class (with migration) backs a facet", async () => {
  console.log("STATIC:", JSON.stringify(await sup().probeStatic()));
});

it("P1b: class with NO migration backs a facet", async () => {
  try {
    console.log("UNMIGRATED:", JSON.stringify(await sup().probeUnmigrated()));
  } catch (error) {
    console.log("UNMIGRATED-ERROR:", String(error).slice(0, 160));
  }
});

it("P1c: raw class constructor instead of ctx.exports", async () => {
  console.log("RAWCLASS:", JSON.stringify(await sup().probeRawClass()));
});

it("P2: storage isolation", async () => {
  console.log("ISOLATION:", JSON.stringify(await sup().probeIsolation()));
});

it("P3: alarms inside a facet", async () => {
  try {
    console.log("ALARM-SET:", JSON.stringify(await sup().probeAlarmSet()));
    await new Promise((resolve) => setTimeout(resolve, 900));
    console.log("ALARM-CHECK:", JSON.stringify(await sup().probeAlarmCheck()));
  } catch (error) {
    console.log("ALARM-FACET-ERROR:", String(error));
  }
});

it("P3b: supervisor alarm works and can relay into facets", async () => {
  console.log(
    "SUP-ALARM-SET:",
    JSON.stringify(await sup().probeSupervisorAlarm()),
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  console.log(
    "SUP-ALARM-FIRED:",
    JSON.stringify(await sup().probeSupervisorAlarmFired()),
  );
});

it("P4: hibernating WebSocket inside a facet", async () => {
  const response = await sup().fetch("https://do/", {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const reply = await new Promise<string>((resolve) => {
    ws.addEventListener("message", (event) =>
      resolve(event.data as string),
    );
    ws.send("hi");
  });
  console.log("WEBSOCKET reply:", reply);
  ws.close();
  expect(reply).toBe("echo:hi");
});

it("P5: abort + restart with a different class", async () => {
  console.log("SWAP:", JSON.stringify(await sup().probeSwap()));
});

it("P6: delete wipes facet storage", async () => {
  console.log("DELETE:", JSON.stringify(await sup().probeDelete()));
});

it("P7: undocumented clone(src, dst)", async () => {
  console.log("CLONE:", JSON.stringify(await sup().probeClone()));
});

it("P8: facet identity", async () => {
  console.log("IDENTITY:", JSON.stringify(await sup().probeIdentity()));
});

it("P9: shape of an unmigrated export", async () => {
  console.log(
    "UNMIGRATED-SHAPE:",
    JSON.stringify(await sup().probeUnmigratedShape()),
  );
});

it("P10: nested facets and in-facet exports", async () => {
  console.log("NESTED:", JSON.stringify(await sup().probeNested()));
});

it("P11: props-configured facet class (one class, many kinds)", async () => {
  console.log("PROPS:", JSON.stringify(await sup().probeProps()));
});
