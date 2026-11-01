// tests/helpers/design-doc-pending-notes-1598.ts
// #1598 の続きで消した画面・ファイルを、設計書がまだ注記なしで名指ししている行のうち、同じ行に「削除した」と注記すれば済むもの。
// 注記を待つ名指しが出たら、設計書ごと・名指しごとの数をここに書き、注記を足す差分と同じコミットで消す。
// 突き合わせの決まり (両方向に厳しい・1 つの設計書はこの一覧か設計の改定を待つ一覧のどちらか一方にだけ載せる) は
// tests/helpers/design-doc-pending-1598.ts。
import type { PendingEntry } from './design-doc-pending-1598';

export const PENDING_NOTE_MENTIONS: readonly PendingEntry[] = [
  // cross/23 §7.1 の、適用済みの migration (20261025130000_planned_meals_set_completed_rpc.sql) を逐語で写したコードブロックの 1 行。
  // #2164 で消したモバイルのホームの hook を、その migration を書いた時点の書き手として挙げる。写しは migration と逐語に揃えるので
  // 同じ行に注記を足せない (同じ冊の W-1 の行と §7.14 の段落は、同じ行に「消した」と書いてある)
  {
    file: 'docs/design/cross/23-planned-meals-score-integrity.md',
    kind: 'file',
    target: 'apps/mobile/src/hooks/useHomeData.ts',
    count: 1,
  },
];
