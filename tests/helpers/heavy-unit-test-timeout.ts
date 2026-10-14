/**
 * 負荷の高い機械で、vitest の既定の時間切れ (1 件のテスト 5 秒・フック 10 秒) を超えたことがある単体テストのファイルの時間切れ (#1488)。
 *
 * 根拠 (2026-10-11 に、それまでの local-ci の unit 段の結果 JSON 274 本 (この Issue の実走を含む) を集計した):
 *   - 次の 18 本は、アサーションの失敗ではなく、vitest の既定の時間切れだけで落ちたことがある
 *     (テストの 5 秒: 15 本・計 60 回 / フックの 10 秒: 3 本・計 10 回。流し直すか M1 で流すと緑)。
 *     そのうち 2 本 (menu-generation-range-1482・super-admin-llm-usage-route) は、#1498 で数千行の組み立てをやめ
 *     (集計を DB の関数 llm_usage_summary に移し、行を数える検査は実 DB の結合テストへ)、1 件の所要の最大が
 *     M2 の 1 分負荷 45 のときで 7ms / 24ms になったので一覧から外した。下の HEAVY_UNIT_TEST_FILES は残りの 16 本。
 *     (集計の当時あった tests/eslint-react19-guard.test.ts も時間切れで 1 回落ちたが、ファイル自身の beforeAll の
 *     時間切れで、この延長では効かないので入れなかった。#1444 で Next 15 に上げたときに、このテストは消した)
 *     中身は、数千行のデータの集計・1,500 通りのでたらめな入力・TypeScript の構文木によるリポジトリの走査・
 *     Edge Function の動的 import・画面の描画など、CPU を使うもの。
 *   - M2 の 1 分負荷が 112 のときの 1 件の所要は、M1 で流したときの最大 36 倍だった
 *     (例: menu-generation-range-1482 は 0.34 秒 → 9.0 秒、super-admin-llm-usage-route は 0.43 秒 → 10.0 秒。どちらも #1498 で一覧から外す前の値)。
 *     これらのファイルの M1 での 1 件の所要の最大は 0.43 秒なので、36 倍でも約 15.5 秒。
 *   - 時間切れ: どちらも vitest の既定の 6 倍 (テスト 30 秒・フック 60 秒)。テストは上の約 15.5 秒のおよそ 2 倍の余裕。
 *     フックの所要は結果 JSON に残らないので、フックもテストと同じ倍率にした。
 *
 * 時間切れが効くのは遅いときだけで、速く終わるテストの所要は変わらない (止まったテストを見切るまでが長くなるだけ)。
 * 期待値・待つ条件は変えないので、検査は緩まない。全体の既定 (vitest.config.ts) は変えず、一覧のファイルだけに効かせる
 * (各ファイルの先頭で applyHeavyUnitTestTimeout() を呼んで vi.setConfig する。時間切れはテスト・フックを登録したときの
 * 設定で決まり、vitest はファイルが終わるたびに vi.resetConfig で戻す)。時間切れを個別に書いたテスト・フックはそちらが優先する。
 * bash・git を何度も起動する tests/local-ci-slot*.test.ts は、別の値 (tests/helpers/local-ci-slot-test-timeout.ts) を使う。
 *
 * 新しく時間切れだけで落ちるファイルが出たら、HEAVY_UNIT_TEST_FILES に足し、そのファイルの import の直後で
 * applyHeavyUnitTestTimeout() を呼ぶ (tests/heavy-unit-test-timeout.test.ts が、一覧と呼び出しの食い違いを止める)。
 * 機械に合わせて変えるときは環境変数 UNIT_HEAVY_TEST_TIMEOUT_MS / UNIT_HEAVY_HOOK_TIMEOUT_MS (ミリ秒) で上書きする
 * (scripts/local-ci.sh も unit の段に持ち込む)。
 */
import { vi } from "vitest";

/** 1 件のテストの時間切れの既定 (ミリ秒)。vitest の既定 5 秒の 6 倍。根拠は上のコメント */
export const DEFAULT_UNIT_HEAVY_TEST_TIMEOUT_MS = 30_000;
/** フック (beforeAll など) の時間切れの既定 (ミリ秒)。vitest の既定 10 秒の 6 倍。根拠は上のコメント */
export const DEFAULT_UNIT_HEAVY_HOOK_TIMEOUT_MS = 60_000;
/** 上書きの環境変数の名前 */
export const UNIT_HEAVY_TEST_TIMEOUT_ENV = "UNIT_HEAVY_TEST_TIMEOUT_MS";
export const UNIT_HEAVY_HOOK_TIMEOUT_ENV = "UNIT_HEAVY_HOOK_TIMEOUT_MS";

/** 時間切れを延ばすファイル (リポジトリの根からの相対パス)。どれも 274 本の結果のどこかで時間切れだけで落ちた (#1498 で速くした 2 本は外した) */
export const HEAVY_UNIT_TEST_FILES: readonly string[] = [
  "src/__tests__/api/ai/menu/engine-feature-flags.test.ts",
  "src/__tests__/api/ai/menu/weekly-request.test.ts",
  "src/__tests__/app/settings/data-export.test.ts",
  "src/__tests__/lib/membership/invite-throttle.in-memory.test.ts",
  "tests/ai-consent-enforcement-edge.test.ts",
  "tests/ai-consent-enforcement-routes.test.ts",
  "tests/ai-consent-entry-points.test.ts",
  "tests/ai-consent-mobile-entry-points.test.ts",
  "tests/ai-consent-settings-page.test.tsx",
  "tests/ai-consent-stored-failure.test.ts",
  "tests/ai-rate-limit-contracts.test.ts",
  "tests/ai-usage-direct-jwt-edge.test.ts",
  "tests/markdown-lite.test.ts",
  "tests/recipes-route.test.ts",
  "tests/route-error-boundaries.test.tsx",
  "tests/use-ai-consent.test.tsx",
];

export type HeavyUnitTimeouts = { testTimeout: number; hookTimeout: number };

/**
 * 環境変数の時間切れ (ミリ秒) を読む。無い・空白だけなら既定、正の整数でなければ止まる (黙って既定に戻さない)。
 * 規則と文面は vitest.integration.config.ts の timeoutFromEnv と同じ (tests/heavy-unit-test-timeout.test.ts が突き合わせる)。
 * ここで import しないのは、一覧のファイル (画面の描画のテストを含む) に vite 本体の読み込みを足さないため
 */
function timeoutFromEnvLocal(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} は正の整数 (ミリ秒) にしてください: ${raw}`);
  }
  return value;
}

/** 環境変数と既定から時間切れを決める。正の整数でなければ止まる (黙って既定に戻さない) */
export function resolveHeavyUnitTimeouts(env: Record<string, string | undefined>): HeavyUnitTimeouts {
  return {
    testTimeout: timeoutFromEnvLocal(env, UNIT_HEAVY_TEST_TIMEOUT_ENV, DEFAULT_UNIT_HEAVY_TEST_TIMEOUT_MS),
    hookTimeout: timeoutFromEnvLocal(env, UNIT_HEAVY_HOOK_TIMEOUT_ENV, DEFAULT_UNIT_HEAVY_HOOK_TIMEOUT_MS),
  };
}

/**
 * 呼んだファイルの、このあとに登録するテストとフックの時間切れを延ばす。ファイルの import の直後 (テスト・フックを定義する前) で呼ぶ。
 * 使った値を返す (検査用)
 */
export function applyHeavyUnitTestTimeout(): HeavyUnitTimeouts {
  const timeouts = resolveHeavyUnitTimeouts(process.env);
  vi.setConfig(timeouts);
  return timeouts;
}
