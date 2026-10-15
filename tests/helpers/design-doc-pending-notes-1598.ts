// tests/helpers/design-doc-pending-notes-1598.ts
// #1598 の続きで消した画面・ファイルを、設計書がまだ注記なしで名指ししている行のうち、同じ行に「削除した」と注記すれば済むもの。
// いまは無い。注記を待つ名指しが出たら、設計書ごと・名指しごとの数をここに書き、注記を足す差分と同じコミットで消す。
// 突き合わせの決まり (両方向に厳しい・1 つの設計書はこの一覧か設計の改定を待つ一覧のどちらか一方にだけ載せる) は
// tests/helpers/design-doc-pending-1598.ts。
import type { PendingEntry } from './design-doc-pending-1598';

export const PENDING_NOTE_MENTIONS: readonly PendingEntry[] = [];
