import { env } from "cloudflare:test";
import { kind, kinds, type KindStub } from "../../../src/index";

const limiter = kind(env.APP_DO, "limiter").get("ts-probe");

// @ts-expect-error
void limiter.consme(1);

// @ts-expect-error
const nope = kind(env.APP_DO, "mailer");

// @ts-expect-error
const nope2 = kinds(env.APP_DO).mailer;

// @ts-expect-error
const nearMiss = kinds(env.APP_DO).limter;

// @ts-expect-error
void limiter.windowMs;

// @ts-expect-error
void limiter.peek("unexpected-arg");

declare class WithReservedNames {
  constructor(ctx: DurableObjectState, env: unknown);
  name(): string;
  stub(): number;
}
type S = KindStub<WithReservedNames>;
declare const s: S;
const metaName: string | undefined = s.name;
const metaStub: DurableObjectStub = s.stub;
// @ts-expect-error
void s.name!();

void [nope, nope2, nearMiss, metaName, metaStub];
