import { describe, expect, it } from 'vitest';

/**
 * next.config.mjs のブラウザの中のルーターのキャッシュ (Client Router Cache) の時間 (#1444)
 *
 * Next 14 の既定は「動的なページ 30 秒・静的なページ 300 秒」だった。Next 15 で動的なページの既定が 0 秒に変わったので、
 * Next 15 へ上げても戻る・進む・リンクでの移動の挙動が変わらないよう、Next 14 と同じ値を明示している。
 * 設定を消すと、Next 15 の既定 (動的なページを使い回さない) に黙って切り替わるので、ここで固定する。
 */

/** Next 14 (14.2) の既定値 (秒) */
const NEXT14_DEFAULT_DYNAMIC_STALE_SEC = 30;
const NEXT14_DEFAULT_STATIC_STALE_SEC = 300;

type NextConfigWithStaleTimes = {
  experimental?: { staleTimes?: { dynamic?: number; static?: number } };
};

describe('next.config.mjs: Client Router Cache の時間は Next 14 の既定のまま (#1444)', () => {
  it('動的なページは 30 秒、静的なページは 300 秒', async () => {
    const mod = await import(/* @vite-ignore */ '../../../next.config.mjs');
    const config = mod.default as NextConfigWithStaleTimes;

    expect(config.experimental?.staleTimes).toEqual({
      dynamic: NEXT14_DEFAULT_DYNAMIC_STALE_SEC,
      static: NEXT14_DEFAULT_STATIC_STALE_SEC,
    });
  });
});
