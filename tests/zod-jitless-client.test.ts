// @vitest-environment node
/**
 * #1721: ブラウザで zod の JIT を切る src/instrumentation-client.ts を確かめる (docs/design/cross/18-csp-nonce.md §7.1 c・§7.3)。
 *
 * zod 4 は z.object(...) を作るときに new Function("") で JIT が使えるかを試し、本番の CSP (script-src に 'unsafe-eval' が無い) が
 * それを違反として /api/csp-report に報告する。src/instrumentation-client.ts を読み込んだあとは
 *   1. zod の設定が jitless である
 *   2. スキーマを作って parse しても、zod は Function を一度も呼ばない (試しの new Function("") も、速い経路のコード生成も)
 * ことを見る。2 は対照として、jitless でない zod が同じ操作で Function を呼ぶことも確かめる (数え方が空振りしていないことの確認)。
 *
 * zod の設定は globalThis の 1 か所 (__zod_globalConfig) にあるので、テストの前後で元の値に戻す。
 * src/instrumentation-client.ts はトップレベルで設定するので、各テストは vi.resetModules() のあとに読み込み、毎回評価させる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** zod が JIT が使えるかを試すときの new Function の引数 (zod/v4/core/util.js の allowsEval) */
const PROBE_BODY = "";
/** zod の速い経路のコード生成 (zod/v4/core/doc.js の Doc.compile) が渡す本体の書き出し */
const FASTPASS_BODY_PREFIX = "return function";

type ZodModule = typeof import("zod");

interface FunctionCalls {
  probes: number;
  compiles: number;
}

const originalFunction = globalThis.Function;
let calls: FunctionCalls;
let previousJitless: boolean | undefined;

/** globalThis.Function を、zod の試しとコード生成の回数を数える代理に差し替える (呼び出しそのものは元の Function に渡す) */
function countFunctionCalls(): void {
  const count = (args: unknown[]): void => {
    const body = args[args.length - 1];
    if (args.length === 1 && body === PROBE_BODY) calls.probes += 1;
    if (typeof body === "string" && body.startsWith(FASTPASS_BODY_PREFIX)) calls.compiles += 1;
  };
  globalThis.Function = new Proxy(originalFunction, {
    construct(target, args, newTarget) {
      count(args);
      return Reflect.construct(target, args, newTarget === globalThis.Function ? target : newTarget);
    },
    apply(target, thisArg, args) {
      count(args);
      return Reflect.apply(target, thisArg, args);
    },
  });
}

/** オブジェクトのスキーマを作って同期で parse する (jitless でなければ、ここで試しと速い経路のコード生成が走る) */
function buildAndParse(zod: ZodModule): unknown {
  const schema = zod.z.object({ name: zod.z.string(), count: zod.z.number() });
  return schema.parse({ name: "a", count: 1 });
}

beforeEach(async () => {
  calls = { probes: 0, compiles: 0 };
  vi.resetModules();
  const zod = await import("zod");
  previousJitless = zod.z.config().jitless;
});

afterEach(async () => {
  globalThis.Function = originalFunction;
  const zod = await import("zod");
  zod.z.config({ jitless: previousJitless });
});

describe("#1721: src/instrumentation-client.ts はブラウザで zod の JIT を切る", () => {
  it("読み込んだあと、zod の設定が jitless になっている", async () => {
    const zod = await import("zod");
    zod.z.config({ jitless: false });

    await import("@/instrumentation-client");

    expect(zod.z.config().jitless).toBe(true);
  });

  it("読み込んだあとにスキーマを作って parse しても、zod は Function を呼ばない (CSP の unsafe-eval に当たらない)", async () => {
    const zod = await import("zod");
    zod.z.config({ jitless: false });
    vi.resetModules();
    countFunctionCalls();

    await import("@/instrumentation-client");
    const freshZod: ZodModule = await import("zod");

    expect(buildAndParse(freshZod)).toEqual({ name: "a", count: 1 });
    expect(calls).toEqual({ probes: 0, compiles: 0 });
  });

  it("対照: jitless でない zod は同じ操作で Function を呼ぶ (数え方が空振りしていない)", async () => {
    const zod = await import("zod");
    zod.z.config({ jitless: false });
    vi.resetModules();
    countFunctionCalls();

    const freshZod: ZodModule = await import("zod");

    expect(buildAndParse(freshZod)).toEqual({ name: "a", count: 1 });
    // 試しの結果は zod が覚えているので、試し (probes) は同じ worker で先に走っていれば 0 回になりうる。
    // 速い経路のコード生成はスキーマごとに 1 回なので、新しく作ったスキーマでは必ず走る
    expect(calls.compiles).toBeGreaterThan(0);
  });
});
