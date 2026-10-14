// タグ入力 (アレルギー・苦手な食材・好きな食材・趣味) の追加ロジックを
// JSX を含まない純粋な関数として切り出したもの (question-flow.ts の
// pruneStaleAnswers と同じ設計方針: UI をレンダリングせずに単体テストできるようにする)。
//
// #1045 round-2 (Sonnet Warning): プレースホルダ「例: 卵、エビ、小麦」がカンマ区切りで
// 1タグに複数の食材を詰め込む誘因になっており、freeTagList (Zod: 1件30文字・最大30件) を
// 超えて /api/onboarding/progress が 400 を返す原因になっていた。
// 「、」「,」「，」区切りで自動的に複数タグへ分割することで1タグ=1食材にし、
// 件数上限・文字数上限もスキーマと同じ定数 (TAG_MAX_LENGTH / TAG_MAX_COUNT) で
// クライアント側から強制する。

import { TAG_MAX_LENGTH, TAG_MAX_COUNT } from '@/schemas/onboarding';

// #1045 round-3 (Fable Suggestion): candidate.slice(0, TAG_MAX_LENGTH) は UTF-16 code unit
// 単位でのスライスのため、サロゲートペア (絵文字等) の途中で切れると不正な文字列
// (孤立した高位サロゲート) が末尾に残ることがあった。
// Zod 側 (freeTagList: z.string().max(TAG_MAX_LENGTH)) の .max() も UTF-16 code unit 長
// で判定するため、単純に Array.from(...).slice(0, N).join('') (code point 単位) にすると
// 絵文字を含む場合に code unit 長が TAG_MAX_LENGTH を超えてスキーマ側で弾かれ得る。
// そのため、まず code unit 単位で slice し、末尾が孤立した高位サロゲート
// (0xD800-0xDBFF) の場合のみ 1 文字短く切り直すことで、Zod の .max() 判定と
// 一致させつつサロゲートペアを分断しないようにする。
function sliceUtf16Safe(value: string, maxLength: number): string {
  const sliced = value.slice(0, maxLength);
  if (sliced.length === 0) return sliced;
  const lastCharCode = sliced.charCodeAt(sliced.length - 1);
  const isLoneHighSurrogate = lastCharCode >= 0xd800 && lastCharCode <= 0xdbff;
  return isLoneHighSurrogate ? sliced.slice(0, maxLength - 1) : sliced;
}

/**
 * 現在のタグ一覧に rawInput から抽出した新規タグを追加した配列を返す。
 * - 「、」「,」「，」で分割し、前後の空白を trim する
 * - 空文字・既存タグとの重複は無視する
 * - 1件あたり TAG_MAX_LENGTH 文字で切り詰める (サロゲートペアを分断しない)
 * - 合計件数が TAG_MAX_COUNT を超える分は追加しない
 */
export function addTagsFromInput(current: string[], rawInput: string): string[] {
  const candidates = rawInput
    .split(/[、,，]/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (candidates.length === 0) return current;

  const next = [...current];
  for (const candidate of candidates) {
    if (next.length >= TAG_MAX_COUNT) break;
    const trimmed = sliceUtf16Safe(candidate, TAG_MAX_LENGTH);
    if (trimmed && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }
  return next;
}
