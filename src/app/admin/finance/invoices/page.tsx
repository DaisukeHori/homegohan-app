/**
 * /admin/finance/invoices — 請求書一覧
 *
 * 請求書の元になる Stripe の Webhook の受信が無く、表は一件も埋まらない (#1125)。
 * #1911: 未完成の機能は画面に出さない (「準備中」とも出さない)。売上・経理のクイックリンクにも並べず、URL で開かれたら 404 にする。
 * 請求書の API (/api/admin/finance/invoices) と詳細画面 (invoices/[id]) はそのまま残してある。
 */
import { notFound } from "next/navigation";

export default function InvoicesPage(): never {
  notFound();
}
