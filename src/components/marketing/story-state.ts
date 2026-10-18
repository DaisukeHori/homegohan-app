// src/components/marketing/story-state.ts
// 物語 (仕組みの区切り。M-6) の「いま見えている手順」を決める純関数。React に依存しない。
// StoryScroller が useInViewIds の結果 (手順ごとの「帯と交差しているか」) を渡し、固定した端末に出す画面の index を得る。
// 遷移表は docs/design/marketing/01-landing-site.md §13.3 (U-30 が全行を確かめる)。

/**
 * 帯 (画面の中央の 20 %) と交差している手順のうち、最も下 (index が最大) のものを返す。
 * どの手順も交差していなければ current をそのまま返す (手順と手順の間を通る間、画面を変えない)。
 * current が範囲の外 (負・length 以上) なら 0 に直す (最初の描画)。
 */
export function storyActiveIndex(intersecting: ReadonlyArray<boolean>, current: number): number {
  let active = -1;
  for (let index = 0; index < intersecting.length; index += 1) {
    if (intersecting[index]) active = index;
  }
  if (active >= 0) return active;
  if (current < 0 || current >= intersecting.length) return 0;
  return current;
}
