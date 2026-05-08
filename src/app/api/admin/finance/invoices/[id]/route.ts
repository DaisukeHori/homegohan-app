/**
 * GET /api/admin/finance/invoices/[id]
 * 個別請求書詳細
 * operator/02-api-spec.md §9
 * 権限: admin, super_admin, finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = createClient();

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

    // Stripe Dashboard リンク生成
    const stripeBase = process.env.NODE_ENV === 'production'
      ? 'https://dashboard.stripe.com'
      : 'https://dashboard.stripe.com/test';

    const invoice = {
      id: evt.id,
      stripe_event_id: evt.id,
      event_type: evt.event_type,
      processing_status: evt.processing_status,
      user_id: userId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
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

    return NextResponse.json({ data: invoice });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: err.message } },
        { status: 403 },
      );
    }
    console.error('[finance/invoices/[id]] unexpected error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
