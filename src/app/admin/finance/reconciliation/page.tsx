/**
 * /admin/finance/reconciliation — Stripe 整合チェック (課金は未開始のため準備中)
 *
 * DB と Stripe の突き合わせ (日次 cron) はまだ動いておらず、結果の元になる監査ログも一件も無い (#1125)。
 * 以前の画面は、「不一致件数 0」「整合OK」「不一致は検出されていません」を緑で出していた。
 * チェックが一度も動いていないのに「整合している」と読めてしまうため、取り除いた。
 * オーナー判断 (2026-10-08) で、課金が始まるまでは「課金は未開始のため準備中」と明示する。
 * 整合チェックの API (/api/admin/finance/reconciliation) はそのまま残してある。
 */
import { BillingNotStartedNotice } from "@/components/operator/finance/BillingNotStartedNotice";

export default function ReconciliationPage() {
  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Stripe 整合チェック</h1>
        <p className="text-sm text-slate-500 mt-1">DB ↔ Stripe の subscription status 差分 (日次 cron 結果)</p>
      </div>

      <BillingNotStartedNotice>
        <p>Stripe と DB の突き合わせは、課金（有料プランの決済）が始まってから行います。</p>
        <p>チェックがまだ動いていないため、いまは結果を表示できません。</p>
      </BillingNotStartedNotice>
    </div>
  );
}
