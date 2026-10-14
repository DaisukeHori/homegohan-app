/**
 * GET  /api/admin/finance/exports — エクスポート一覧 (権限確認用)
 * POST /api/admin/finance/exports — CSV エクスポート生成
 * 権限: admin, super_admin, finance
 *       ただし export_type 'nps' (NPS 回答の書き出し) は admin, super_admin だけ。finance は 403 (#1311)
 *
 * E2E: w5-12-admin-adversarial F-24 (通常 user → 403)
 *
 * 期間 (from / to。画面の日付の入力。どちらの日も含む) は JST の暦日 (#1433)。
 *   - revenue (revenue_snapshots.date。date 型の列 = 暦日そのもの): 日付のまま .gte / .lte
 *   - invoices (received_at)・subscriptions (created_at)・nps (sent_at) は timestamptz の列なので、
 *     日付の文字列をそのまま渡さず (DB は UTC の 0 時 = JST 9 時と読み、開始日の JST 0:00〜8:59 の行と、
 *     終了日の JST 9:00 以降の行が落ちていた)、開始日の JST 0 時以上 (.gte)・終了日の翌日の JST 0 時未満 (.lt) で絞る
 * 本文の形が違う (存在しない日付・時刻つきの期間・知らない種別など) ときは 400 (DB を読まず、監査ログも作らない)。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole, type UserProfile } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { ExportRequestSchema } from '@/lib/admin/finance-schemas';
import { jstOptionalDayRangeTimestamps } from '@/lib/jst-day-ranges';

export const dynamic = 'force-dynamic';

/**
 * NPS 回答 (user_id とコメント付き) の書き出しを許すロール (#1311)。財務ロール (finance) は含めない。
 * NPS / CSAT の集計 API (GET /api/admin/finance/nps) と同じ扱い。
 * nps_surveys を読む RLS (nps_select_admin) は finance を許していないため、通しても空の CSV にしかならない。
 */
const NPS_EXPORT_ROLES = ['admin', 'super_admin'] as const;

export async function GET(_request: NextRequest) {
  let actor: UserProfile;
  try {
    actor = await requireRole(['admin', 'super_admin', 'finance']);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: { code: 'UNAUTHENTICATED', message: '認証が必要です' } },
        { status: 401 },
      );
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } },
        { status: 403 },
      );
    }
    throw err;
  }

  // エクスポート種別の一覧を返す (POST で実際の生成を行う)。
  // 呼んだ本人が書き出せる種別だけを返す: nps は admin / super_admin にだけ入れ、finance には出さない (#1311)。
  // 管理画面 (財務ダッシュボードのクイックリンク) は、この一覧に nps があるかで NPS / CSAT のリンクを出すか決める
  // (画面側で役割を判定し直すと、ここ・nps API の判定とずれるため)
  const canExportNps = NPS_EXPORT_ROLES.some((role) => actor.roles.includes(role));
  return NextResponse.json({
    data: {
      available_types: canExportNps
        ? ['revenue', 'invoices', 'subscriptions', 'nps']
        : ['revenue', 'invoices', 'subscriptions'],
    },
  });
}

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
    const supabase = await createClient();

    const body = await request.json() as unknown;
    const parsed = ExportRequestSchema.safeParse(body);
    // 存在しない日付・時刻つきの期間・知らない種別などは 400。DB は読まず、監査ログも作らない (#1433)
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const req = parsed.data;

    // #1311: NPS 回答の書き出しは admin / super_admin だけ。入口の許可ロール (finance を含む) とは別に絞る。
    // DB を読む前に確かめるので、finance には何も読まず、監査ログも作らない (403 は下の catch が返す)
    if (req.export_type === 'nps') {
      await requireRole(NPS_EXPORT_ROLES);
    }

    let csvContent = '';
    let filename = '';
    // timestamptz の列 (invoices / subscriptions / nps) を絞る時刻: 開始日の JST 0 時 (以上)・終了日の翌日の JST 0 時 (未満) (#1433)
    const { fromTimestamp, toTimestampExclusive } = jstOptionalDayRangeTimestamps(req.from, req.to);

    if (req.export_type === 'revenue') {
      let dbQuery = supabase
        .from('revenue_snapshots')
        .select('date, total_mrr_jpy, total_arr_jpy, personal_active_users, org_active_orgs, new_signups, cancellations, computed_at')
        .order('date', { ascending: false });
      // date 型の列 (JST の暦日) なので、日付のまま両端を含めて絞る
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
      if (fromTimestamp) dbQuery = dbQuery.gte('received_at', fromTimestamp);
      if (toTimestampExclusive) dbQuery = dbQuery.lt('received_at', toTimestampExclusive);
      const { data } = await dbQuery;
      const headers = ['id', 'event_type', 'processing_status', 'received_at', 'processed_at', 'error_message'];
      csvContent = toCsv(headers, (data ?? []) as Record<string, unknown>[]);
      filename = `invoices_${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (req.export_type === 'subscriptions') {
      let dbQuery = supabase
        .from('personal_subscriptions')
        .select('id, user_id, plan_key, status, starts_at, current_period_start, current_period_end, cancelled_at, created_at')
        .order('created_at', { ascending: false });
      if (fromTimestamp) dbQuery = dbQuery.gte('created_at', fromTimestamp);
      if (toTimestampExclusive) dbQuery = dbQuery.lt('created_at', toTimestampExclusive);
      const { data } = await dbQuery;
      const headers = ['id', 'user_id', 'plan_key', 'status', 'starts_at', 'current_period_start', 'current_period_end', 'cancelled_at', 'created_at'];
      csvContent = toCsv(headers, (data ?? []) as Record<string, unknown>[]);
      filename = `subscriptions_${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (req.export_type === 'nps') {
      let dbQuery = supabase
        .from('nps_surveys')
        .select('id, user_id, score, comment, plan_key, sent_at, responded_at')
        .order('sent_at', { ascending: false });
      if (fromTimestamp) dbQuery = dbQuery.gte('sent_at', fromTimestamp);
      if (toTimestampExclusive) dbQuery = dbQuery.lt('sent_at', toTimestampExclusive);
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
