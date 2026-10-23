/**
 * GET /api/admin/finance/invoices/[id]
 * 個別請求書詳細
 * operator/02-api-spec.md §9
 * 権限: admin, super_admin, finance
 *
 * #1326: 返すたびに admin.finance.invoice.view を監査ログに残す。対象は請求先のユーザー
 * (サブスクリプションから引けないときは対象なしで、Stripe のイベント ID を details に入れる)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { getStripeDashboardBase } from '@/lib/stripe/links';
import { recordAdminAudit } from '@/lib/admin/audit';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const actor = await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = await createClient();

    const { data: evt, error } = await supabase
      .from('stripe_webhook_events')
      .select('*')
      .eq('id', params.id)
      .single();

    if (error || !evt) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: '請求書が見つかりません' } },
        { status: 404 },
      );
    }

    const payload = (evt.payload as Record<string, unknown>) ?? {};
    const invoiceObj = (payload as { data?: { object?: Record<string, unknown> } })?.data?.object ?? {};

    const stripeCustomerId = (invoiceObj as { customer?: string })?.customer ?? null;
    const stripeSubscriptionId = (invoiceObj as { subscription?: string })?.subscription ?? null;

    // personal_subscriptions から user_id を取得 (stripe_subscription_id で結合)
    let userId: string | null = null;
    if (stripeSubscriptionId) {
      const { data: sub } = await supabase
        .from('personal_subscriptions')
        .select('user_id, plan_key')
        .eq('stripe_subscription_id', stripeSubscriptionId)
        .single();
      userId = sub?.user_id ?? null;
    }

    // Stripe Dashboard リンク生成 (返金の記録 API と同じモードのリンクにするため共通の判定を使う)
    const stripeBase = getStripeDashboardBase();

    // 返金の記録 (POST /api/admin/finance/refunds) に渡す請求書 ID。
    // イベントの object が請求書 (in_...) のときだけ。upcoming には ID が無く、請求書以外のイベントでは別の ID が入る
    const objectId = (invoiceObj as { id?: unknown })?.id;
    const stripeInvoiceId = typeof objectId === 'string' && objectId.startsWith('in_') ? objectId : null;

    const invoice = {
      id: evt.id,
      stripe_event_id: evt.id,
      event_type: evt.event_type,
      processing_status: evt.processing_status,
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_invoice_id: stripeInvoiceId,
      amount_paid: (invoiceObj as { amount_paid?: number })?.amount_paid ?? null,
      amount_due: (invoiceObj as { amount_due?: number })?.amount_due ?? null,
      currency: (invoiceObj as { currency?: string })?.currency ?? null,
      invoice_number: (invoiceObj as { number?: string })?.number ?? null,
      invoice_pdf: (invoiceObj as { invoice_pdf?: string })?.invoice_pdf ?? null,
      period_start: (invoiceObj as { period_start?: number })?.period_start
        ? new Date(((invoiceObj as { period_start: number }).period_start) * 1000).toISOString()
        : null,
      period_end: (invoiceObj as { period_end?: number })?.period_end
        ? new Date(((invoiceObj as { period_end: number }).period_end) * 1000).toISOString()
        : null,
      stripe_links: {
        customer: stripeCustomerId ? `${stripeBase}/customers/${stripeCustomerId}` : null,
        subscription: stripeSubscriptionId ? `${stripeBase}/subscriptions/${stripeSubscriptionId}` : null,
        invoice: (invoiceObj as { id?: string })?.id
          ? `${stripeBase}/invoices/${(invoiceObj as { id: string }).id}`
          : null,
      },
      received_at: evt.received_at,
      processed_at: evt.processed_at ?? null,
      error_message: evt.error_message ?? null,
    };

    // #1326: 請求書 (金額・請求先の Stripe ID) を返す前に、誰が誰の請求書を見たかを監査ログに残す。
    // 404 は上で返しているので、ここに来るのは情報を返すときだけ。target_id は uuid 列なので、
    // Stripe のイベント ID (evt_...) は details に入れる。details は ID と返した項目名だけで、金額などの値は入れない。
    // 記録に失敗しても閲覧は止めない (失敗は db-logger に error で残る)
    await recordAdminAudit({
      supabase,
      actorId: actor.id,
      actionType: 'admin.finance.invoice.view',
      targetId: userId,
      targetType: userId ? 'user' : 'stripe_event',
      details: { stripe_event_id: evt.id, viewed_fields: Object.keys(invoice) },
      request,
      routeName: 'api/admin/finance/invoices/[id] GET',
    });

    return NextResponse.json({ data: invoice });
  } catch (err) {
    const authFailure = authFailureNested(err, { code: AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/finance/invoices/[id]', err, { log_context: '[finance/invoices/[id]] unexpected error' }, { shape: 'nested' });
  }
}
