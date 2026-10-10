/**
 * GET /api/super-admin/audit-logs  — 監査ログ閲覧
 * operator/07-audit-monitoring.md §3-4 準拠
 * SELECT は super_admin のみ (admin が自分の操作を消せない設計)
 *
 * 期間 (from / to。画面の日付の入力。どちらの日も含む) は JST の暦日で絞る (#1433)。created_at は timestamptz なので、
 * 日付の文字列をそのまま渡さず (DB は UTC の 0 時 = JST 9 時と読み、JST の 0:00〜8:59 の行が落ちる)、
 * 終了日も 'T23:59:59Z' (UTC。JST では翌日の 8:59:59) で閉じず、JST 0 時の時刻にしてから .gte / .lt で絞る。
 */
import { NextRequest, NextResponse } from 'next/server';
import { jstOptionalDayRangeTimestamps } from '@/lib/jst-day-ranges';
import { createClient } from '@/lib/supabase/server';
import { requireRole } from '@/lib/auth/helpers';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { AuditLogQuerySchema } from '@/lib/super-admin/audit-logs-schemas';

export async function GET(request: NextRequest) {
  try {
    // super_admin のみ許可 (admin も不可)
    await requireRole(['super_admin']);
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);

    const parsed = AuditLogQuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { actor_id, target_id, action_type, severity, from, to, page, per_page } = parsed.data;

    let query = supabase
      .from('admin_audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * per_page, page * per_page - 1);

    if (actor_id) query = query.eq('actor_id', actor_id);
    if (target_id) query = query.eq('target_id', target_id);
    if (action_type) query = query.ilike('action_type', `%${action_type}%`);
    if (severity) query = query.eq('severity', severity);
    // 開始日の JST 0 時から、終了日の翌日の JST 0 時の手前まで (#1433)
    const { fromTimestamp, toTimestampExclusive } = jstOptionalDayRangeTimestamps(from, to);
    if (fromTimestamp) query = query.gte('created_at', fromTimestamp);
    if (toTimestampExclusive) query = query.lt('created_at', toTimestampExclusive);

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message: error.message } }, { status: 500 });
    }

    // CSV エクスポートモード
    const format = searchParams.get('format');
    if (format === 'csv') {
      const rows = (data ?? []).map((row) => [
        row.id,
        row.created_at,
        row.actor_email_snapshot ?? row.actor_id ?? '',
        row.actor_role_snapshot ?? '',
        row.action_type,
        row.target_type ?? '',
        row.target_id ?? '',
        row.severity,
        JSON.stringify(row.details),
        row.ip_address ?? '',
      ]);

      const header = ['id', 'created_at', 'actor_email', 'actor_role', 'action_type', 'target_type', 'target_id', 'severity', 'details', 'ip_address'];
      const csv = [header, ...rows].map((r) => r.join(',')).join('\n');

      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { total: count ?? 0, page, per_page },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
  }
}
