/**
 * デザイントークン (Web / モバイル共通)
 *
 * 状態色 (成功・注意・エラー・危険) の唯一の定義元。
 *
 * #590: 状態色の値が画面ごとに違っていた。Web の home・health・pantry は success #4CAF50 / warning #FF9800 の系統 (B 系)、
 * モバイルの colors.ts と Web の週間献立などは success #6B9B6B / warning #E5A84B の系統 (A 系)。
 * 2026-10-08 のオーナー判断 (590) で A 系に統一した。モバイルの値は変わらない。
 * Web の home・health・pantry とモバイルの colors.ts はここを import する。
 * (週間献立など、まだ A 系の値を直書きしている画面は、順次ここへ寄せる)
 *
 * 使い分け (590-2: 文字の見やすさは WCAG 2.x の AA = 4.5:1 を基準にする)
 * - success / warning / error / danger: 「塗り」用。背景・枠線・アイコン・グラフの線や棒。
 *   白地に置いた文字としては 4.5:1 に届かない (おおよそ success 3.2 / warning 2.1 / error 3.7 / danger 4.4)。文字には使わない。
 * - successLight / warningLight / errorLight / dangerLight: チップや通知バナーなどの淡い下地。
 * - successText / warningText / dangerText: 「文字」用の濃い色。塗りと同じ色相で、明度を下げた色 (彩度はほぼ同じ)。
 *   白地・各 Light の下地・ページの背景・塗りの色の薄い透過の下地の上で 4.5:1 以上になる (design-tokens.test.ts が数値で確かめる)。
 *   error (#F44336) の赤い文字にも dangerText を使う (赤系の文字は 1 色にそろえる)。
 *
 * 中立色 (bg / card / text / border など) と accent / purple / blue は、ここには含めない。
 * Web の画面ごと・モバイルで値が違うので、別の変更で揃える。
 */
export const STATUS_COLOR_TOKENS = {
  // --- 塗り (A 系) ---
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  error: '#F44336',
  errorLight: '#FFEBEE',
  danger: '#D64545',
  dangerLight: '#FDECEC',
  // --- 文字 (AA 4.5:1 以上) ---
  successText: '#4A704A',
  warningText: '#8C5C12',
  dangerText: '#BE2828',
} as const;

export type StatusColorTokenKey = keyof typeof STATUS_COLOR_TOKENS;
