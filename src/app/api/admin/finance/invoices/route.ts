/**
 * GET /api/admin/finance/invoices
 * 請求書一覧 (stripe_webhook_events 由来)
 * operator/02-api-spec.md §9
 * 権限: admin, super_admin, finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { InvoiceQuerySchema } from '@/lib/admin/finance-schemas';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = await createClient();

    const { searchParams } = new URL(request.url);
    const query = InvoiceQuerySchema.parse({
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
    });

    // stripe_webhook_events テーブルから invoice 関連イベントを取得
    let dbQuery = supabase
      .from('stripe_webhook_events')
      .select('*', { count: 'exact' })
      .in('event_type', ['invoice.paid', 'invoice.payment_failed', 'invoice.upcoming'])
      .order('received_at', { ascending: false });

    if (query.status) {
      dbQuery = dbQuery.eq('processing_status', query.status);
    }
    if (query.from) {
      dbQuery = dbQuery.gte('received_at', query.from);
    }
    if (query.to) {
      dbQuery = dbQuery.lte('received_at', query.to);
    }

    const offset = (query.page - 1) * query.per_page;
    dbQuery = dbQuery.range(offset, offset + query.per_page - 1);

    const { data: events, count, error } = await dbQuery;

    if (error) {
      throw new Error(error.message);
    }

    // payload から invoice 情報を抽出
    const invoices = (events ?? []).map((evt) => {
      const payload = (evt.payload as Record<string, unknown>) ?? {};
      const invoiceObj = (payload as { data?: { object?: Record<string, unknown> } })?.data?.object ?? {};

      return {
        id: evt.id,
        stripe_event_id: evt.id,
        event_type: evt.event_type,
        user_id: null,
        stripe_customer_id: (invoiceObj as { customer?: string })?.customer ?? null,
        stripe_subscription_id: (invoiceObj as { subscription?: string })?.subscription ?? null,
        amount_paid: (invoiceObj as { amount_paid?: number })?.amount_paid ?? null,
        currency: (invoiceObj as { currency?: string })?.currency ?? null,
        status: evt.processing_status,
        invoice_number: (invoiceObj as { number?: string })?.number ?? null,
        period_start: (invoiceObj as { period_start?: number })?.period_start
          ? new Date(((invoiceObj as { period_start: number }).period_start) * 1000).toISOString()
          : null,
        period_end: (invoiceObj as { period_end?: number })?.period_end
          ? new Date(((invoiceObj as { period_end: number }).period_end) * 1000).toISOString()
          : null,
        received_at: evt.received_at,
        processed_at: evt.processed_at ?? null,
      };
    });

    return NextResponse.json({
      data: invoices,
      meta: {
        total: count ?? 0,
        page: query.page,
        per_page: query.per_page,
      },
    });
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
    console.error('[finance/invoices] unexpected error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
