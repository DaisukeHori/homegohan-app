/**
 * GET /api/admin/finance/invoices
 * 請求書一覧 (stripe_webhook_events 由来)
 * operator/02-api-spec.md §9
 * 権限: admin, super_admin, finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED, authFailureNested } from '@/lib/api/error-responses';
import { InvoiceQuerySchema } from '@/lib/admin/finance-schemas';
import { financeInvalidQueryResponse } from '@/lib/admin/finance-query-errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';

export const dynamic = 'force-dynamic';

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/admin/finance/invoices';

export async function GET(request: NextRequest) {
  try {
    await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = await createClient();

    const { searchParams } = new URL(request.url);
    // クエリの誤り (page / per_page が 1 以上の整数でない・status が一覧に無いなど) は、DB に触れずに 400 (#2101 X6。
    // 以前は .parse の例外が外側の catch に落ちて 500 になっていた)
    const queryResult = InvoiceQuerySchema.safeParse({
      page: searchParams.get('page') ?? undefined,
      per_page: searchParams.get('per_page') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
    });
    if (!queryResult.success) {
      return financeInvalidQueryResponse(queryResult.error.issues);
    }
    const query = queryResult.data;

    // stripe_webhook_events テーブルから invoice 関連イベントを取得。
    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectInvoiceEvents) から作る
    const selectInvoiceEvents = (options: { head?: boolean } = {}) => {
      let dbQuery = supabase
        .from('stripe_webhook_events')
        .select('*', listCountOptions(options.head))
        .in('event_type', ['invoice.paid', 'invoice.payment_failed', 'invoice.upcoming']);

      if (query.status) {
        dbQuery = dbQuery.eq('processing_status', query.status);
      }
      if (query.from) {
        dbQuery = dbQuery.gte('received_at', query.from);
      }
      if (query.to) {
        dbQuery = dbQuery.lte('received_at', query.to);
      }
      return dbQuery;
    };

    const offset = (query.page - 1) * query.per_page;
    const { data: events, count, error } = await resolveBeyondLastPage(
      await selectInvoiceEvents()
        .order('received_at', { ascending: false })
        .range(offset, offset + query.per_page - 1),
      () => selectInvoiceEvents({ head: true }),
      LIST_ROUTE_NAME,
    );

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
    const authFailure = authFailureNested(err, { code: AUTH_CODES_UNAUTHENTICATED_AND_OP_PERMISSION_DENIED });
    if (authFailure) return authFailure;
    return internalError('GET /api/admin/finance/invoices', err, { log_context: '[finance/invoices] unexpected error' }, { shape: 'nested' });
  }
}
