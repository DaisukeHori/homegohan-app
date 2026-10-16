// tests/helpers/design-doc-pending-revisions-1598.ts
// #1598 の続きで消した画面・ファイルを、設計書がまだ名指ししている行のうち、注記では直らないもの (設計の判断を変えるもの)。
// いまは無い。設計の改定が要る名指しが出たら、設計書ごと・名指しごとの数をここに書き、改定と同じコミットで消す。
// 突き合わせの決まりは tests/helpers/design-doc-pending-1598.ts。
import type { PendingEntry } from './design-doc-pending-1598';

export const PENDING_REVISION_MENTIONS: readonly PendingEntry[] = [];
