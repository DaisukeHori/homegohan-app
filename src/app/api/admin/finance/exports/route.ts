/**
 * POST /api/admin/finance/exports
 * CSV エクスポート生成
 * 権限: admin, super_admin, finance
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { ExportRequestSchema } from '@/lib/admin/finance-schemas';

/** 配列データを CSV 文字列に変換するシンプルなヘルパー */
function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const headerLine = headers.map(escape).join(',');
  const dataLines = rows.map((row) => headers.map((h) => escape(row[h])).join(','));
  return [headerLine, ...dataLines].join('\n');
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole(['admin', 'super_admin', 'finance']);
    const supabase = createClient();

    const body = await request.json() as unknown;
    const req = ExportRequestSchema.parse(body);

    let csvContent = '';
    let filename = '';

    if (req.export_type === 'revenue') {
      let dbQuery = supabase
        .from('revenue_snapshots')
        .select('date, total_mrr_jpy, total_arr_jpy, personal_active_users, org_active_orgs, new_signups, cancellations, computed_at')
        .order('date', { ascending: false });
      if (req.from) dbQuery = dbQuery.gte('date', req.from);
      if (req.to) dbQuery = dbQuery.lte('date', req.to);
      const { data } = await dbQuery;
      const headers = ['date', 'total_mrr_jpy', 'total_arr_jpy', 'personal_active_users', 'org_active_orgs', 'new_signups', 'cancellations', 'computed_at'];
      csvContent = toCsv(headers, (data ?? []) as Record<string, unknown>[]);
      filename = `revenue_${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (req.export_type === 'invoices') {
      let dbQuery = supabase
        .from('stripe_webhook_events')
        .select('id, event_type, processing_status, received_at, processed_at, error_message')
        .in('event_type', ['invoice.paid', 'invoice.payment_failed'])
        .order('received_at', { ascending: false });
      if (req.from) dbQuery = dbQuery.gte('received_at', req.from);
      if (req.to) dbQuery = dbQuery.lte('received_at', req.to);
      const { data } = await dbQuery;
      const headers = ['id', 'event_type', 'processing_status', 'received_at', 'processed_at', 'error_message'];
      csvContent = toCsv(headers, (data ?? []) as Record<string, unknown>[]);
      filename = `invoices_${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (req.export_type === 'subscriptions') {
      let dbQuery = supabase
        .from('personal_subscriptions')
        .select('id, user_id, plan_key, status, starts_at, current_period_start, current_period_end, cancelled_at, created_at')
        .order('created_at', { ascending: false });
      if (req.from) dbQuery = dbQuery.gte('created_at', req.from);
      if (req.to) dbQuery = dbQuery.lte('created_at', req.to);
      const { data } = await dbQuery;
      const headers = ['id', 'user_id', 'plan_key', 'status', 'starts_at', 'current_period_start', 'current_period_end', 'cancelled_at', 'created_at'];
      csvContent = toCsv(headers, (data ?? []) as Record<string, unknown>[]);
      filename = `subscriptions_${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (req.export_type === 'nps') {
      let dbQuery = supabase
        .from('nps_surveys')
        .select('id, user_id, score, comment, plan_key, sent_at, responded_at')
        .order('sent_at', { ascending: false });
      if (req.from) dbQuery = dbQuery.gte('sent_at', req.from);
      if (req.to) dbQuery = dbQuery.lte('sent_at', req.to);
      const { data } = await dbQuery;
      const headers = ['id', 'user_id', 'score', 'comment', 'plan_key', 'sent_at', 'responded_at'];
      csvContent = toCsv(headers, (data ?? []) as Record<string, unknown>[]);
      filename = `nps_${new Date().toISOString().slice(0, 10)}.csv`;
    }

    // 監査ログ記録 (破壊的操作ではないが export はログ対象とする)
    try {
      await supabase.from('admin_audit_logs').insert({
        actor_id: user.id,
        action_type: 'admin.finance.export',
        target_type: 'finance_data',
        severity: 'info',
        details: {
          export_type: req.export_type,
          from: req.from,
          to: req.to,
        },
        ip_address: null,
      });
    } catch {
      // graceful: ログ失敗でもエクスポートは返す
    }

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
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
    console.error('[finance/exports] unexpected error:', err);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}
