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
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { z } from 'zod';
import { internalError } from '@/lib/api/errors';

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

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin();
    const supabase = createClient();

    const { searchParams } = new URL(request.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: '入力値が不正です', details: parsed.error.flatten() } },
        { status: 400 },
      );
    }

    const { scope, action, from, to, limit, page } = parsed.data;

    let query = supabase
      .from('membership_audit')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (scope) query = query.eq('scope', scope);
    if (action) query = query.ilike('action', `%${action}%`);
    // 開始日の JST 0 時から、終了日の翌日の JST 0 時の手前まで (#1433)
    const { fromTimestamp, toTimestampExclusive } = jstOptionalDayRangeTimestamps(from, to);
    if (fromTimestamp) query = query.gte('created_at', fromTimestamp);
    if (toTimestampExclusive) query = query.lt('created_at', toTimestampExclusive);

    const { data, error, count } = await query;

    if (error) {
      return internalError('GET /api/operator/membership/audit', error, {}, { shape: 'nested' });
    }

    return NextResponse.json({
      data: data ?? [],
      meta: { total: count ?? 0, page, limit },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 });
    }
    return internalError('GET /api/operator/membership/audit', err, {}, { shape: 'nested' });
  }
}
