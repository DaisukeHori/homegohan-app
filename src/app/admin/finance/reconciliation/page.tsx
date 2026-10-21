/**
 * /admin/finance/reconciliation — Stripe 整合チェック
 *
 * DB と Stripe の突き合わせ (日次 cron) が動いておらず、結果の元になる監査ログも無い (#1125)。
 * #1911: 未完成の機能は画面に出さない (「準備中」とも出さない)。売上・経理のクイックリンクにも並べず、URL で開かれたら 404 にする。
 * 整合チェックの API (/api/admin/finance/reconciliation) はそのまま残してある。
 */
import { notFound } from "next/navigation";

export default function ReconciliationPage(): never {
  notFound();
}
