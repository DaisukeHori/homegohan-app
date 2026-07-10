/**
 * #1048 F2-16: クエリパラメータの数値検証を共通化する。
 *
 * `parseInt` は不正な文字列 (例: "abc") に対して NaN を返し、それを
 * そのまま日付演算等に渡すと RangeError 等の未処理例外→500 につながる。
 * また limit 系パラメータは DoS 防止のため必ず上限でクランプする。
 *
 * この関数は不正な入力（NaN・空文字・非数値文字列）を例外にせず、
 * 安全に `opts.default` へフォールバックさせた上で [min, max] にクランプする。
 */
export function clampIntParam(
  raw: string | null | undefined,
  opts: { min: number; max: number; default: number },
): number {
  if (raw == null || raw.trim() === '') {
    return opts.default;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return opts.default;
  }

  const rounded = Math.trunc(parsed);
  return Math.min(Math.max(rounded, opts.min), opts.max);
}
