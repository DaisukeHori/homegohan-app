// src/lib/admin/subscription-status-labels.ts
// 運営の画面で、個人の契約の状態 (personal_subscriptions.status) を日本語の表示名で出すための表 (#2112 Z3)。
//
// 以前、運営の利用者の詳細 (src/app/admin/users/[id]/page.tsx) の「現在のサブスクリプション」は、状態を英字の内部の値 (past_due など) のまま出していた。
// 値の一覧は src/lib/billing/core.ts の SUBSCRIPTION_STATUSES (§6.2 の CHECK と同じ 8 値。core.ts は設計書の正典の写しなので、表は型だけを読んでここに置く)。
// キーの型を SubscriptionStatus にして、値を足すと表示名の漏れが型の誤りになる形にする (USER_LIST_STATUS_LABELS と同じ形)。
// 利用者の画面の文 (core.ts の BILLING_STATUS_TEXT。「お支払い方法をご確認ください」など) は利用者に向けた文なので、運営の画面は短い名前を使う。

import type { SubscriptionStatus } from '@/lib/billing/core';
import { labelOrRaw } from '@/lib/admin/value-labels';

/** 個人の契約の状態の、運営の画面の表示名 */
export const ADMIN_SUBSCRIPTION_STATUS_LABELS: Readonly<Record<SubscriptionStatus, string>> = {
  incomplete: '手続き未完了',
  trialing: '無料期間中',
  active: '有効',
  paused: '一時停止中',
  cancelled: '解約済み',
  expired: '期限切れ',
  past_due: '支払い遅延',
  grace: '猶予期間 (機能制限中)',
};

/** 個人の契約の状態の表示名。表に無い値 (将来の値・壊れた応答) はそのまま */
export function adminSubscriptionStatusLabel(status: string): string {
  return labelOrRaw(ADMIN_SUBSCRIPTION_STATUS_LABELS, status);
}
