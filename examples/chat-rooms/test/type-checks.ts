/**
 * Compile-time checks: misuses that the typed stub rejects before runtime.
 * This file is typechecked with the example but never executed.
 */
import { env } from "cloudflare:test";
import { kinds } from "../../../src/index";

const app = kinds(env.APP_DO);
const limiter = app.limiter.get("type-checks");

// A typo'd method name is a type error, with a did-you-mean suggestion.
// @ts-expect-error -- Property 'consme' does not exist on type 'KindStub<Limiter>'.
void limiter.consme();

// Only registered kinds exist on the kinds() accessor.
// @ts-expect-error -- Property 'mailer' does not exist.
void app.mailer;

// Near-misses on kind names get a suggestion too.
// @ts-expect-error -- Did you mean 'limiter'?
void app.limter;

// Wrong arity is a type error.
// @ts-expect-error -- Expected 0 arguments, but got 1.
void limiter.peek("unexpected-arg");
