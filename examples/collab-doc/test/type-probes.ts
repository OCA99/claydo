/**
 * Compile-time DX probes. Each `@ts-expect-error` documents a diagnostic
 * that TypeScript produces for a misuse; the verbatim messages are quoted
 * in ../DX-REPORT.md. This file is typechecked but never executed.
 */
import { env } from "cloudflare:test";
import { kind } from "../../../src/index";

const doc = kind(env.APP_DO, "doc").get("ts-probe");

// Typo'd method (TS2551):
//   Property 'getTxt' does not exist on type 'KindStub<Doc>'.
//   Did you mean 'getText'?
// @ts-expect-error
void doc.getTxt();

// Malformed op payload is caught with a regular structural error (TS2322):
//   Type 'string' is not assignable to type 'number'.
// @ts-expect-error
void doc.applyOp({ type: "insert", pos: "zero", text: "x" });

// Return types are awaited and exact: getText() yields Promise<string>.
const text: Promise<string> = doc.getText();

// The stub deliberately does not expose lifecycle handlers:
//   Property 'webSocketMessage' does not exist on type 'KindStub<Doc>'. (TS2339)
// @ts-expect-error
void doc.webSocketMessage;

void text;
