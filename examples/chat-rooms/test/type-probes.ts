/**
 * Compile-time DX probes, updated after the library's post-audit changes.
 * Each `@ts-expect-error` documents a diagnostic that TypeScript produces
 * for a misuse; the verbatim messages are quoted in ../DX-REPORT.md.
 * This file is typechecked but never executed.
 */
import { env } from "cloudflare:test";
import { kind, kinds, type KindStub } from "../../../src/index";

const limiter = kind(env.APP_DO, "limiter").get("ts-probe");

// Typo'd method — unchanged, still excellent (TS2551):
//   Property 'consme' does not exist on type 'KindStub<Limiter>'.
//   Did you mean 'consume'?
// @ts-expect-error
void limiter.consme(1);

// Unknown kind through kind() (TS2345) — alias renamed KindNames -> KindNameOf
// but still does not list the valid names:
//   Argument of type '"mailer"' is not assignable to parameter of type
//   'KindNameOf<DurableObjectNamespace<AppDO>>'.
// @ts-expect-error
const nope = kind(env.APP_DO, "mailer");

// FIXED by the new kinds() accessor (TS2339) — the registry is spelled out:
//   Property 'mailer' does not exist on type
//   '{ chat: KindAccessor<Chat>; limiter: KindAccessor<Limiter>; }'.
// @ts-expect-error
const nope2 = kinds(env.APP_DO).mailer;

// ...and near-misses get a suggestion (TS2551):
//   Property 'limter' does not exist on type
//   '{ chat: KindAccessor<Chat>; limiter: KindAccessor<Limiter>; }'.
//   Did you mean 'limiter'?
// @ts-expect-error
const nearMiss = kinds(env.APP_DO).limter;

// Plain (non-method) property — unchanged (TS2339):
//   Property 'windowMs' does not exist on type 'KindStub<Limiter>'.
// (The RUNTIME message for this misuse improved; see probes.test.ts.)
// @ts-expect-error
void limiter.windowMs;

// Wrong arity — unchanged (TS2554): Expected 0 arguments, but got 1.
// @ts-expect-error
void limiter.peek("unexpected-arg");

// FIXED: reserved-name collisions no longer produce impossible intersections.
// KindStub now strips `id`/`name`/`kind`/`stub` from the method mapping, so
// the metadata types win cleanly:
declare class WithReservedNames {
  constructor(ctx: DurableObjectState, env: unknown);
  name(): string;
  stub(): number;
}
type S = KindStub<WithReservedNames>;
declare const s: S;
const metaName: string | undefined = s.name;
const metaStub: DurableObjectStub = s.stub;
// Calling the shadowed method is now a type error (TS2349):
//   This expression is not callable. Type 'String' has no call signatures.
// @ts-expect-error
void s.name!();
// (union() additionally rejects such classes at runtime — see probes.test.ts.)

void [nope, nope2, nearMiss, metaName, metaStub];
