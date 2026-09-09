/**
 * Compile-time checks of the typed stub. Each `@ts-expect-error` marks a
 * misuse that TypeScript must reject. This file is typechecked but never
 * executed.
 */
import { env } from "cloudflare:test";
import { kinds } from "../../../src/index";
import type { KindNameOf, KindStub } from "../../../src/index";
import type { Doc } from "../worker";

// The accessor returns a typed stub for the kind's instance type.
const doc: KindStub<Doc> = kinds(env.APP_DO).doc.get("type-checks");

// Method names are checked against the kind class.
// @ts-expect-error 'getTxt' does not exist on the stub.
void doc.getTxt();

// Argument types are checked structurally.
// @ts-expect-error 'pos' must be a number.
void doc.applyOp({ type: "insert", pos: "zero", text: "x" });

// Return types are exact and always promise-wrapped.
const text: Promise<string> = doc.getText();

// Lifecycle handlers are not RPC methods, so the stub does not expose them.
// @ts-expect-error 'webSocketMessage' does not exist on the stub.
void doc.webSocketMessage;

// KindNameOf extracts the kind names registered on the namespace.
const kindName: KindNameOf<typeof env.APP_DO> = "doc";
// @ts-expect-error 'chat' is not a registered kind.
const wrongKind: KindNameOf<typeof env.APP_DO> = "chat";

void text;
void kindName;
void wrongKind;
