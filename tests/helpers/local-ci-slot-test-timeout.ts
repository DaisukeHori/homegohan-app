/**
 * tests/local-ci-slot.test.ts と tests/local-ci-slot-consumers.test.ts (#1488)、tests/mobile-easignore-bundle-inputs.test.ts (#1605) の、
 * 1 件のテストの時間切れ。どれも 1 件のテストの中で bash・git を起動する。
 *
 * 根拠 (2026-10-11 に、それまでの local-ci の unit 段の結果 JSON 93 本の所要を集計した):
 *   この 2 本は 1 件のテストの中で bash・git を何度も起動し (scripts/lib/local-ci-slot.sh・scripts/supabase-local.sh・
 *   ハーネス)、consumers は TypeScript の構文木でリポジトリを走査する。軽い機械では 1 件 0.1〜2 秒だが、
 *   M2 の負荷が高いとき (1 分負荷 50〜110) は 10 倍以上に伸び、vitest の既定の 5 秒の時間切れで毎回数件が落ちた
 *   (アサーションの失敗ではない。流し直すか M1 で流すと緑)。93 本のうち、時間切れを個別に書いていないテストの所要の最大は
 *   「stop / status は、ほかの枠をあとから組み立てても…」の 31.3 秒 (中央値 1.4 秒)、consumers の最大は 16.0 秒。
 *   - 時間切れ: 60 秒。上の最大 31.3 秒のおよそ 2 倍の余裕。
 *   tests/mobile-easignore-bundle-inputs.test.ts (#1605) は、1 件ごとに一時ディレクトリで git init と git check-ignore を起こす。
 *   2026-10-15 に負荷 40 前後の 2 号機で、5 秒の時間切れだけで落ちた (結果 JSON が残っている 3 回の実行で計 6 件、ほかにログだけが
 *   残っている 1 回。流し直すと緑)。1 件の所要の最大は 29.8 秒だった
 *   (2026-10-14〜15 の local-ci の unit 段の結果 JSON 89 本。軽いときは 1 件 0.1 秒前後)。重い単体テストの 30 秒
 *   (tests/helpers/heavy-unit-test-timeout.ts) では余裕が無いので、同じく git を起動するこの 60 秒を使う (29.8 秒のおよそ 2 倍)。
 *
 * 時間切れが効くのは遅いときだけで、速く終わるテストの所要は変わらない (止まったテストを見切るまでが長くなるだけ)。
 * 期待値・待つ条件は変えないので、検査は緩まない。全体の既定 (vitest.config.ts) は変えず、この 3 本だけに効かせる
 * (各ファイルの先頭で vi.setConfig する。vitest はファイルが終わるたびに vi.resetConfig で戻す。フック (beforeAll・afterAll など)
 * を持つファイルは、フックの時間切れも同じ値にする)。
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
