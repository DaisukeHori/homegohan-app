/**
 * /admin/finance/revenue — 収益推移 (課金は未開始のため準備中)
 *
 * 収益の日次スナップショット (revenue_snapshots) を作る集計バッチがリポジトリに無く、表は一件も埋まらない (#1125)。
 * 以前の画面は、常に空の表と「データがありません」を出していた。
 * オーナー判断 (2026-10-08) で、課金が始まるまでは「課金は未開始のため準備中」と明示する。
 * 収益の API (/api/admin/finance/revenue) はそのまま残してある。
 */
import { BillingNotStartedNotice } from "@/components/operator/finance/BillingNotStartedNotice";

export default function RevenueListPage() {
  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">収益推移</h1>
        <p className="text-sm text-slate-500 mt-1">revenue_snapshots — 日次スナップショット</p>
      </div>

      <BillingNotStartedNotice>
        <p>収益の推移は、課金（有料プランの決済）が始まってから集計して表示します。</p>
        <p>集計する処理がまだ無いため、いまは、この画面に出せるデータがありません。</p>
      </BillingNotStartedNotice>
    </div>
  );
}
