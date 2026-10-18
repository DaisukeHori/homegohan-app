// src/components/marketing/count-up.ts
// 数値が 0 から目標まで増えて止まる動き (M-7 のデモのスコア・M-11 の輪の数字) の値を決める純関数。React に依存しない。
// 島は requestAnimationFrame のループで経過時間を渡し、戻り値を描く。読み上げは最後の値だけ (§8.3)。
// 動きを減らす設定 (useReducedMotion() が true) のときは呼ばず、最初から目標の値を描く (§6.4)。

/** 速く始まり、ゆっくり止まる緩急 (0〜1 → 0〜1) */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

/**
 * 経過時間 elapsedMs のときに描く値 (0 以上 target 以下の整数)。
 * durationMs 以上で target。durationMs が 0 以下なら常に target。target が 0 以下なら 0。
 */
export function countUpValue(target: number, elapsedMs: number, durationMs: number): number {
  if (target <= 0) return 0;
  if (durationMs <= 0 || elapsedMs >= durationMs) return Math.round(target);
  if (elapsedMs <= 0) return 0;
  return Math.min(Math.round(target), Math.round(Math.round(target) * easeOutCubic(elapsedMs / durationMs)));
}
