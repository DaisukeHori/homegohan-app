/**
 * 売上・経理の画面の「課金は未開始のため準備中」の案内 (#1125)
 *
 * 課金 (Stripe の決済・Webhook の受信・収益の集計バッチ) がまだ動いていないため、請求書・収益推移・
 * Stripe との整合チェックには、集まったデータが一件も無い。空の表や「不一致 0 件・整合OK」を出すと、
 * 課金が動いていて問題が無いように見えてしまうため、「準備中」と明示する。
 */
import type { ReactNode } from 'react';
import { PreparingNotice } from '@/components/operator/PreparingNotice';

/** 画面に出す主なメッセージ (ダッシュボードのカードにも使う) */
export const BILLING_NOT_STARTED_MESSAGE = '課金は未開始のため準備中';

export function BillingNotStartedNotice({ children }: { children?: ReactNode }) {
  return (
    <PreparingNotice title={BILLING_NOT_STARTED_MESSAGE} tone="light">
      {children}
    </PreparingNotice>
  );
}
