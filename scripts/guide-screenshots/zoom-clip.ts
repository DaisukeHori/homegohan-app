/**
 * 紹介ページ (/) の章 photo・menu の拡大の画像 (public/marketing/screens/zoom-*.png) を、撮影の画面から切り出す範囲を決める (#1867 段 0)。
 * shoot.pw.ts が、comment.png・menu-result.png を撮った同じ画面の状態で、この範囲を page.screenshot({ clip }) で撮る。
 *
 * 決まり (docs/design/marketing/01-landing-site.md §5.4・§7.1 の表 3):
 *   - 箱いっぱいに見せるもの (targets) は切らずに入れる (必須)。
 *   - 写ってはいけないもの (avoid。画面の右下の AI アドバイザーのボタン) は入れない (必須)。
 *   - 縦横比は LANDING_ZOOMS の width / height にそろえる (必須)。
 *   - targets の外接の矩形に marginPx の余白を足す (できるだけ。縦に余りがあれば上下の真ん中に置き、avoid に当たるなら避ける側へずらす)。
 *   - 画面 (viewport) の外は切り出さない (必須)。
 * 必須の条件を同時に満たせなければ例外にする (撮影を止めて、切り出し方か縦横比を決め直す: 同 §14)。
 * 値はどれも CSS px (page.screenshot の clip と locator.boundingBox() と同じ単位)。
 */

export interface ClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ZoomClipOptions {
  /** 箱いっぱいに見せる要素の矩形 (1 つ以上) */
  targets: readonly ClipRect[];
  /** 写してはいけない要素の矩形 */
  avoid: readonly ClipRect[];
  /** 切り出す範囲の 横 / 縦 */
  aspect: number;
  /** targets の外接の矩形の周りに足す余白 (CSS px) */
  marginPx: number;
  /** 撮影の画面の大きさ (CSS px) */
  viewport: { width: number; height: number };
}

/** 矩形どうしが重なるか (辺が接するだけは重ならない) */
export function rectsOverlap(a: ClipRect, b: ClipRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** a が b をすべて含むか */
export function rectContains(a: ClipRect, b: ClipRect): boolean {
  return a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
}

/** 矩形の外接の矩形 */
export function unionRect(rects: readonly ClipRect[]): ClipRect {
  if (rects.length === 0) throw new Error('zoomClip: targets が空');
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 1 つの軸の置き場所を決める: 長さ size の区間の始まりを、[lo, hi] (targets を含み画面に収まる範囲) の中で preferred に最も近く、
 * blocked (その軸で避ける区間の並び) のどれとも重ならない値にする。無ければ null
 */
function placeOnAxis(lo: number, hi: number, preferred: number, size: number, blocked: ReadonlyArray<readonly [number, number]>): number | null {
  if (lo > hi) return null;
  // 候補: 好みの位置 (範囲に収めたもの)・範囲の両端・避ける区間のすぐ前 / すぐ後
  const candidates = [Math.min(hi, Math.max(lo, preferred)), lo, hi];
  for (const [start, end] of blocked) {
    candidates.push(start - size, end);
  }
  const free = candidates
    .filter((value) => value >= lo && value <= hi)
    .filter((value) => blocked.every(([start, end]) => value + size <= start || value >= end));
  if (free.length === 0) return null;
  return free.reduce((best, value) => (Math.abs(value - preferred) < Math.abs(best - preferred) ? value : best));
}

/** 拡大の画像を切り出す範囲 (ファイル先頭の決まり)。必須の条件を満たせなければ例外 */
export function zoomClip({ targets, avoid, aspect, marginPx, viewport }: ZoomClipOptions): ClipRect {
  if (!(aspect > 0)) throw new Error(`zoomClip: 縦横比が正でない: ${aspect}`);
  const union = unionRect(targets);
  // 余白を足した大きさを、縦横比に合わせて足りない方の辺を伸ばす
  let width = union.width + marginPx * 2;
  let height = union.height + marginPx * 2;
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  if (width > viewport.width || height > viewport.height) {
    throw new Error(`zoomClip: 切り出す範囲 (${width.toFixed(1)}×${height.toFixed(1)}) が画面 (${viewport.width}×${viewport.height}) より大きい`);
  }

  // 横: targets を含み画面に収まる範囲で、targets の真ん中に置く
  const xLo = Math.max(0, union.x + union.width - width);
  const xHi = Math.min(viewport.width - width, union.x);
  const xPreferred = union.x + union.width / 2 - width / 2;
  const x = placeOnAxis(xLo, xHi, xPreferred, width, []);
  if (x === null) throw new Error('zoomClip: 横に収まる置き場が無い');

  // 縦: 横で重なる avoid を縦の区間として避け、targets の真ん中に最も近い置き場にする
  const blocked = avoid
    .filter((rect) => rect.x < x + width && x < rect.x + rect.width)
    .map((rect) => [rect.y, rect.y + rect.height] as const);
  const yLo = Math.max(0, union.y + union.height - height);
  const yHi = Math.min(viewport.height - height, union.y);
  const yPreferred = union.y + union.height / 2 - height / 2;
  const y = placeOnAxis(yLo, yHi, yPreferred, height, blocked);
  if (y === null) {
    throw new Error(
      `zoomClip: 写してはいけないもの (${avoid.map((r) => `${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}×${r.height.toFixed(1)}`).join(' / ')}) ` +
        `を避けて targets (${union.x.toFixed(1)},${union.y.toFixed(1)} ${union.width.toFixed(1)}×${union.height.toFixed(1)}) を縦横比 ${aspect} で入れられない`,
    );
  }
  const clip = { x, y, width, height };
  if (!rectContains(clip, union) || avoid.some((rect) => rectsOverlap(clip, rect))) {
    throw new Error('zoomClip: 決めた範囲が条件を満たさない (内部の誤り)');
  }
  return clip;
}
