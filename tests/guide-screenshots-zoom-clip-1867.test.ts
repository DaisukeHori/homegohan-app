// @vitest-environment node
/**
 * #1867 段 0: 紹介ページの拡大の画像を切り出す範囲 (scripts/guide-screenshots/zoom-clip.ts の zoomClip) の番兵。
 * 決まり (docs/design/marketing/01-landing-site.md §5.4・§7.1 の表 3): 箱いっぱいに見せるもの (targets) を切らずに入れる・
 * 写してはいけないもの (avoid。AI アドバイザーのボタン) を入れない・縦横比は LANDING_ZOOMS の width / height・画面の外を切り出さない。
 * 満たせなければ例外 (撮影を止める)。値は撮影の画面 (390 × 780 の CSS px) の上の矩形。
 */
import { describe, expect, it } from 'vitest';
import { LANDING_ZOOMS } from '@/components/marketing/landing-screens';
import { rectContains, rectsOverlap, unionRect, zoomClip, type ClipRect } from '../scripts/guide-screenshots/zoom-clip';
import { SHOOT_VIEWPORT } from '../scripts/guide-screenshots/guide-users';

/** 撮影の画面の右下の AI アドバイザーのボタン (right 16・bottom 96・56 px 角。src/components/AIChatBubble.tsx の既定の位置) と、縁のなめらかにする画素の 0.5 px (shoot.pw.ts の FAB_EDGE_ALLOWANCE_PX) */
const FAB_SIZE = 56;
const FAB_RIGHT = 16;
const FAB_BOTTOM = 96;
const FAB_EDGE = 0.5;
const FAB: ClipRect = {
  x: SHOOT_VIEWPORT.width - FAB_RIGHT - FAB_SIZE - FAB_EDGE,
  y: SHOOT_VIEWPORT.height - FAB_BOTTOM - FAB_SIZE - FAB_EDGE,
  width: FAB_SIZE + FAB_EDGE * 2,
  height: FAB_SIZE + FAB_EDGE * 2,
};
const MARGIN = 6;
const EPSILON = 1e-9;

const aspectOf = (name: string) => {
  const zoom = LANDING_ZOOMS.find((item) => item.name === name);
  if (!zoom) throw new Error(name);
  return zoom.width / zoom.height;
};

describe('#1867 段 0 拡大の画像を切り出す範囲 (zoomClip)', () => {
  it('章 photo の形 (スコアの箱と記録コメントの箱。縦に余りがある): 2 つの箱を含み、縦横比 3:2、横は箱の真ん中、縦も真ん中、ボタンに当たらない', () => {
    const score: ClipRect = { x: 16, y: 258, width: 358, height: 94 };
    const comment: ClipRect = { x: 16, y: 370, width: 358, height: 114 };
    const clip = zoomClip({ targets: [score, comment], avoid: [FAB], aspect: aspectOf('zoom-photo'), marginPx: MARGIN, viewport: SHOOT_VIEWPORT });
    const union = unionRect([score, comment]);
    expect(rectContains(clip, union)).toBe(true);
    expect(rectsOverlap(clip, FAB)).toBe(false);
    expect(clip.width / clip.height).toBeCloseTo(3 / 2, 9);
    expect(clip.width).toBeCloseTo(union.width + MARGIN * 2, 9);
    // 縦は余り (高さ − 箱の高さ) を上下に等分する
    expect(clip.y - union.y + (clip.y + clip.height - (union.y + union.height))).toBeCloseTo(0, 9);
    expect(clip.x).toBeCloseTo(union.x - MARGIN, 9);
  });

  it('章 menu の形 (朝食の箱の下の端のすぐ下にボタン): 箱を含み、縦横比 6:5、下の端はボタン (縁を含む) の上で止まり、上へ寄せる', () => {
    const breakfast: ClipRect = { x: 12, y: 318, width: 367, height: 307 };
    const clip = zoomClip({ targets: [breakfast], avoid: [FAB], aspect: aspectOf('zoom-menu'), marginPx: MARGIN, viewport: SHOOT_VIEWPORT });
    expect(rectContains(clip, breakfast)).toBe(true);
    expect(rectsOverlap(clip, FAB)).toBe(false);
    expect(clip.width / clip.height).toBeCloseTo(6 / 5, 9);
    // 真ん中に置くとボタンに当たるので、下の端はボタン (縁を含む) の上の端に合わせる
    const centredBottom = breakfast.y + breakfast.height / 2 + clip.height / 2;
    expect(centredBottom).toBeGreaterThan(FAB.y);
    expect(clip.y + clip.height).toBeCloseTo(FAB.y, 9);
  });

  it('縦横比が足りず横に伸ばすとき (縦に長い箱): 横は箱の真ん中から左右に等しく伸ばす', () => {
    const tall: ClipRect = { x: 150, y: 100, width: 60, height: 200 };
    const clip = zoomClip({ targets: [tall], avoid: [], aspect: 1.5, marginPx: MARGIN, viewport: SHOOT_VIEWPORT });
    expect(clip.height).toBeCloseTo(tall.height + MARGIN * 2, 9);
    expect(clip.width).toBeCloseTo(clip.height * 1.5, 9);
    expect(clip.x + clip.width / 2).toBeCloseTo(tall.x + tall.width / 2, 9);
    expect(clip.y).toBeCloseTo(tall.y - MARGIN, 9);
  });

  it('画面の端に寄った箱は、画面の中に押し戻す (箱は含んだまま)', () => {
    const nearLeft: ClipRect = { x: 0, y: 0, width: 200, height: 100 };
    const clip = zoomClip({ targets: [nearLeft], avoid: [], aspect: 2, marginPx: MARGIN, viewport: SHOOT_VIEWPORT });
    expect(clip.x).toBeGreaterThanOrEqual(0);
    expect(clip.y).toBeGreaterThanOrEqual(0);
    expect(rectContains(clip, nearLeft)).toBe(true);
    expect(clip.x).toBe(0);
    expect(clip.y).toBe(0);
  });

  it('ボタンを避けると箱が切れるとき・範囲が画面より大きいとき・縦横比が正でないときは例外', () => {
    // 箱の下の端がボタンより下 (ボタンを避けると箱が切れる)
    const overlapping: ClipRect = { x: 12, y: 330, width: 367, height: 307 };
    expect(() => zoomClip({ targets: [overlapping], avoid: [FAB], aspect: 6 / 5, marginPx: MARGIN, viewport: SHOOT_VIEWPORT })).toThrow(/写してはいけないもの/);
    const huge: ClipRect = { x: 0, y: 0, width: 390, height: 700 };
    expect(() => zoomClip({ targets: [huge], avoid: [], aspect: 1.5, marginPx: MARGIN, viewport: SHOOT_VIEWPORT })).toThrow(/画面/);
    expect(() => zoomClip({ targets: [huge], avoid: [], aspect: 0, marginPx: MARGIN, viewport: SHOOT_VIEWPORT })).toThrow(/縦横比/);
    expect(() => zoomClip({ targets: [], avoid: [], aspect: 1.5, marginPx: MARGIN, viewport: SHOOT_VIEWPORT })).toThrow(/targets/);
  });

  it('ボタンの下に置けるときは、下の候補も選べる (真ん中に近い方)', () => {
    // ボタンより下に十分な場所があり、真ん中がボタンの下側に近い
    const lowBox: ClipRect = { x: 300, y: 700, width: 60, height: 40 };
    const clip = zoomClip({ targets: [lowBox], avoid: [FAB], aspect: 1, marginPx: 0, viewport: SHOOT_VIEWPORT });
    expect(rectsOverlap(clip, FAB)).toBe(false);
    expect(clip.y).toBeGreaterThanOrEqual(FAB.y + FAB.height - EPSILON);
    expect(rectContains(clip, lowBox)).toBe(true);
  });

  it('rectsOverlap は辺が接するだけなら重ならないとみなし、rectContains は等しい矩形を含む', () => {
    const a: ClipRect = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectsOverlap(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
    expect(rectsOverlap(a, { x: 0, y: 10, width: 5, height: 5 })).toBe(false);
    expect(rectsOverlap(a, { x: 9, y: 9, width: 5, height: 5 })).toBe(true);
    expect(rectContains(a, a)).toBe(true);
    expect(rectContains(a, { x: 1, y: 1, width: 10, height: 1 })).toBe(false);
    expect(unionRect([a, { x: 20, y: 30, width: 5, height: 5 }])).toEqual({ x: 0, y: 0, width: 25, height: 35 });
  });
});
