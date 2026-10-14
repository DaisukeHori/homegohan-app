/**
 * Stripe ダッシュボードへのリンク生成
 * operator/05-stripe-integration.md §6.2 準拠
 *
 * 請求書詳細 API (/api/admin/finance/invoices/[id]) と返金の記録 API
 * (/api/admin/finance/refunds) が同じモード (本番 / テスト) のリンクを返すよう、
 * 判定をここに 1 か所にまとめている。
 */

/**
 * ダッシュボードのベース URL。
 * 本番ビルド (NODE_ENV=production) は本番モード、それ以外はテストモード (/test) を指す。
 */
export function getStripeDashboardBase(): string {
  return process.env.NODE_ENV === 'production'
    ? 'https://dashboard.stripe.com'
    : 'https://dashboard.stripe.com/test';
}

/** 決済 (Charge) のページ。返金はこのページの「返金」ボタンから行う */
export function stripePaymentUrl(chargeId: string): string {
  return `${getStripeDashboardBase()}/payments/${encodeURIComponent(chargeId)}`;
}

/** 請求書 (Invoice) のページ */
export function stripeInvoiceUrl(invoiceId: string): string {
  return `${getStripeDashboardBase()}/invoices/${encodeURIComponent(invoiceId)}`;
}
