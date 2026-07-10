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

/**
 * 現在のタグ一覧に rawInput から抽出した新規タグを追加した配列を返す。
 * - 「、」「,」「，」で分割し、前後の空白を trim する
 * - 空文字・既存タグとの重複は無視する
 * - 1件あたり TAG_MAX_LENGTH 文字で切り詰める
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
    const trimmed = candidate.slice(0, TAG_MAX_LENGTH);
    if (trimmed && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }
  return next;
}
