/**
 * /admin/finance/invoices — 請求書一覧 (課金は未開始のため準備中)
 *
 * 請求書の元データは Stripe の Webhook (stripe_webhook_events) だが、Webhook を受け取る処理がリポジトリに無く、
 * 表は一件も埋まらない (#1125)。以前の画面は、常に空の表と「データがありません」を出していた。
 * オーナー判断 (2026-10-08) で、課金が始まるまでは「課金は未開始のため準備中」と明示する。
 * 請求書の API (/api/admin/finance/invoices) と詳細画面 (invoices/[id]) はそのまま残してある。
 */
import { BillingNotStartedNotice } from "@/components/operator/finance/BillingNotStartedNotice";

export default function InvoicesPage() {
  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">請求書一覧</h1>
        <p className="text-sm text-slate-500 mt-1">stripe_webhook_events — invoice イベント</p>
      </div>

      <BillingNotStartedNotice>
        <p>請求書は、課金（有料プランの決済）が始まってから表示されます。</p>
        <p>Stripe からの通知を受け取る処理がまだ無いため、いまは、この画面に出せるデータがありません。</p>
      </BillingNotStartedNotice>
    </div>
  );
}
