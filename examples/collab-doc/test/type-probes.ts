import { env } from "cloudflare:test";
import { kind } from "../../../src/index";

const doc = kind(env.APP_DO, "doc").get("ts-probe");

// @ts-expect-error
void doc.getTxt();

// @ts-expect-error
void doc.applyOp({ type: "insert", pos: "zero", text: "x" });

const text: Promise<string> = doc.getText();

// @ts-expect-error
void doc.webSocketMessage;

void text;
