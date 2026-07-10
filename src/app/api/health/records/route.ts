import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { RECORD_DATE_PATTERN, sanitizeHealthRecordPayload } from '@/lib/health-payloads';
import { todayLocal } from '@/lib/date-utils';
import { updateHealthStreak } from '@/lib/health-streaks';
import { clampIntParam } from '@/lib/http-params';

// 健康記録の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');
  // #265: limit に上限を設けて DoS を防ぐ
  // #1048 F2-11: 1年グラフ(365日)が start_date + limit=365 で取得するため、
  // 200 では末尾約165日が欠落していた。集計用途を考慮し上限を400に緩和。
  const limit = clampIntParam(searchParams.get('limit'), { min: 1, max: 400, default: 30 });

  let query = supabase
    .from('health_records')
    .select('*')
    .eq('user_id', user.id)
    .order('record_date', { ascending: false })
    .limit(limit);

  if (startDate) {
    query = query.gte('record_date', startDate);
  }
  if (endDate) {
    query = query.lte('record_date', endDate);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ records: data });
}

// 健康記録の作成・更新（UPSERT）
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const { record_date, ...recordData } = body;

  if (typeof record_date !== 'string' || !record_date.trim()) {
    return NextResponse.json({ error: 'record_date is required' }, { status: 400 });
  }

  // #256: record_date フォーマット検証（YYYY-MM-DD のみ許可）
  if (!RECORD_DATE_PATTERN.test(record_date.trim())) {
    return NextResponse.json({ error: 'record_date must be in YYYY-MM-DD format' }, { status: 400 });
  }

  const { data: sanitizedRecordData, errors } = sanitizeHealthRecordPayload(recordData, {
    acceptLegacyNotes: true,
  });

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(sanitizedRecordData).length === 0) {
    return NextResponse.json({ error: 'No valid health record fields were provided' }, { status: 400 });
  }

  // #1048 F2-19: 確認してから insert/update する check-then-act は同時リクエストで
  // UNIQUE(user_id, record_date) 違反 500 を起こし得るため upsert に統一する。
  const result = await supabase
    .from('health_records')
    .upsert(
      {
        user_id: user.id,
        record_date,
        ...sanitizedRecordData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,record_date' },
    )
    .select()
    .single();

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }

  // 連続記録を更新
  await updateHealthStreak(supabase, user.id, record_date);

  // user_profilesの体重も更新（最新の記録の場合）
  if ('weight' in sanitizedRecordData && sanitizedRecordData.weight !== null) {
    // #266: new Date() UTC ではなく JST の今日を使用
    const today = todayLocal();
    if (record_date === today) {
      await supabase
        .from('user_profiles')
        .update({ weight: sanitizedRecordData.weight })
        .eq('id', user.id);
    }
  }

  return NextResponse.json({ record: result.data });
}
