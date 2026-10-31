/**
 * GET /api/operator/membership/audit
 * membership_audit テーブル一覧 + フィルタ
 * 05-operator-emergency-ui.md §7 準拠
 *
 * 期間 (from / to。画面の日付の入力。どちらの日も含む) は JST の暦日で絞る (#1433)。created_at は timestamptz なので、
 * 日付の文字列をそのまま渡さず (DB は UTC の 0 時 = JST 9 時と読み、JST の 0:00〜8:59 の行が落ちる)、
 * 終了日も 'T23:59:59Z' (UTC。JST では翌日の 8:59:59) で閉じず、JST 0 時の時刻にしてから .gte / .lt で絞る。
 */
import { NextRequest, NextResponse } from 'next/server';
import { CalendarDateSchema } from '@/lib/calendar-date-schema';
import { jstOptionalDayRangeTimestamps } from '@/lib/jst-day-ranges';
import { createClient } from '@/lib/supabase/server';
import { requireSuperAdmin } from '@/lib/auth/operator-permissions';
import { authFailureNested } from '@/lib/api/error-responses';
import { z } from 'zod';
import { internalError } from '@/lib/api/errors';
import { listCountOptions, resolveBeyondLastPage } from '@/lib/api/list-range';
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  scope: z.enum(['organization', 'family']).optional(),
  action: z.string().optional(),
  // 期間の開始日・終了日 (YYYY-MM-DD の実在する日付。JST の暦日)。存在しない日付は 400 (#1433)
  from: CalendarDateSchema.optional(),
  to: CalendarDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
});

/** 一覧の構造化ログの function_name */
const LIST_ROUTE_NAME = 'GET /api/operator/membership/audit';

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin();
    const supabase = await createClient();

    const { searchParams } = new URL(request.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { scope, action, from, to, limit, page } = parsed.data;

    // 一覧と、範囲外のページのときの件数の数え直し (src/lib/api/list-range.ts) は、同じ絞り込み (selectMembershipAudit) から作る
    const selectMembershipAudit = (options: { head?: boolean } = {}) => {
      let query = supabase
        .from('membership_audit')
        .select('*', listCountOptions(options.head));

      if (scope) query = query.eq('scope', scope);
      if (action) query = query.ilike('action', `%${action}%`);
      // 開始日の JST 0 時から、終了日の翌日の JST 0 時の手前まで (#1433)
      const { fromTimestamp, toTimestampExclusive } = jstOptionalDayRangeTimestamps(from, to);
      if (fromTimestamp) query = query.gte('created_at', fromTimestamp);
      if (toTimestampExclusive) query = query.lt('created_at', toTimestampExclusive);

      return query;
    };

    const { data, error, count } = await resolveBeyondLastPage(
      // 記録した日時の新しい順。同じ日時は id の順で、ページの境目でも順が変わらない (#2134 U2。LIST_ORDERS.operatorMembershipAudit)
      await orderListBy(selectMembershipAudit(), LIST_ORDERS.operatorMembershipAudit)
        .range((page - 1) * limit, page * limit - 1),
      () => selectMembershipAudit({ head: true }),
      LIST_ROUTE_NAME,
    );

    if (error) {
      return internalError(LIST_ROUTE_NAME, error, {}, { shape: 'nested' });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { total: count ?? 0, page, limit },
    });
  } catch (err) {
    const authFailure = authFailureNested(err);
    if (authFailure) return authFailure;
    return internalError('GET /api/operator/membership/audit', err, {}, { shape: 'nested' });
  }
}
