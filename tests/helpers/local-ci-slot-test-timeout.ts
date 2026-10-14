/**
 * tests/local-ci-slot.test.ts と tests/local-ci-slot-consumers.test.ts の、1 件のテストの時間切れ (#1488)。
 *
 * 根拠 (2026-10-11 に、それまでの local-ci の unit 段の結果 JSON 93 本の所要を集計した):
 *   この 2 本は 1 件のテストの中で bash・git を何度も起動し (scripts/lib/local-ci-slot.sh・scripts/supabase-local.sh・
 *   ハーネス)、consumers は TypeScript の構文木でリポジトリを走査する。軽い機械では 1 件 0.1〜2 秒だが、
 *   M2 の負荷が高いとき (1 分負荷 50〜110) は 10 倍以上に伸び、vitest の既定の 5 秒の時間切れで毎回数件が落ちた
 *   (アサーションの失敗ではない。流し直すか M1 で流すと緑)。93 本のうち、時間切れを個別に書いていないテストの所要の最大は
 *   「stop / status は、ほかの枠をあとから組み立てても…」の 31.3 秒 (中央値 1.4 秒)、consumers の最大は 16.0 秒。
 *   - 時間切れ: 60 秒。上の最大 31.3 秒のおよそ 2 倍の余裕。
 *
 * 時間切れが効くのは遅いときだけで、速く終わるテストの所要は変わらない (止まったテストを見切るまでが長くなるだけ)。
 * 期待値・待つ条件は変えないので、検査は緩まない。全体の既定 (vitest.config.ts) は変えず、この 2 本だけに効かせる
 * (各ファイルの先頭で vi.setConfig する。vitest はファイルが終わるたびに vi.resetConfig で戻す)。
 * 時間切れを個別に書いたテスト (local-ci-slot.test.ts の RACE_TIMEOUT_MS) はそちらが優先する。
 * 機械に合わせて変えるときは環境変数 UNIT_SLOT_TEST_TIMEOUT_MS (ミリ秒) で上書きする (scripts/local-ci.sh も unit の段に持ち込む)。
 */
import type { RunnerTask, RunnerTestFile } from "vitest";

import { timeoutFromEnv } from "../../vitest.integration.config";

/** 1 件のテストの時間切れの既定 (ミリ秒)。根拠は上のコメント */
export const DEFAULT_UNIT_SLOT_TEST_TIMEOUT_MS = 60_000;
/** 上書きの環境変数の名前 */
export const UNIT_SLOT_TEST_TIMEOUT_ENV = "UNIT_SLOT_TEST_TIMEOUT_MS";

/** 環境変数と既定から時間切れを決める。正の整数でなければ止まる (黙って既定に戻さない。規則は timeoutFromEnv と同じ) */
export function resolveUnitSlotTestTimeout(env: Record<string, string | undefined>): number {
  return timeoutFromEnv(env, UNIT_SLOT_TEST_TIMEOUT_ENV, DEFAULT_UNIT_SLOT_TEST_TIMEOUT_MS);
}

/**
 * ファイルの中のテストのうち、時間切れが allowed のどれでもないものの名前 (検査用)。
 * vi.setConfig を消した・別の値で上書きした・describe の外に置いたテストより後ろへ動かした、などで
 * 全体の既定 (5 秒) のまま残ったテストを見つける (時間切れはテストを登録したときの設定で決まる)
 */
export function testsWithUnexpectedTimeout(file: RunnerTestFile, allowed: readonly number[]): string[] {
  const walk = (tasks: readonly RunnerTask[]): string[] =>
    tasks.flatMap((t) => {
      if (t.type === "suite") return walk(t.tasks);
      return allowed.includes(t.timeout) ? [] : [`${t.name} (${t.timeout})`];
    });
  return walk(file.tasks);
}
