import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { HEALTH_RECORD_DATE_INVALID_MESSAGE, HEALTH_RECORD_DATE_REQUIRED_MESSAGE, HEALTH_RECORD_NO_FIELDS_MESSAGE, healthDateInvalidMessage } from '@/lib/health-api-messages';
import { RECORD_DATE_PATTERN, sanitizeHealthRecordPayload } from '@/lib/health-payloads';
import { isCalendarDate, todayLocal } from '@/lib/date-utils';
import { updateHealthStreak } from '@/lib/health-streaks';
import { clampIntParam } from '@/lib/http-params';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

// 健康記録の取得
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');
  // #265: limit に上限を設けて DoS を防ぐ
  // #1048 F2-11: 1年グラフ(365日)が start_date + limit=365 で取得するため、
  // 200 では末尾約165日が欠落していた。集計用途を考慮し上限を400に緩和。
  const limit = clampIntParam(searchParams.get('limit'), { min: 1, max: 400, default: 30 });

  // 日付は YYYY-MM-DD の実在する日付 (isCalendarDate の範囲の中) だけを受け付ける (#1482)。
  // 形を見ずに渡すと、2026-02-30 のような日付が DB の date 型への変換で失敗して 500 になる。空欄 (?start_date=) は以前どおり「指定なし」
  for (const [name, value] of [['start_date', startDate], ['end_date', endDate]] as const) {
    if (value && !isCalendarDate(value)) {
      return NextResponse.json({ error: healthDateInvalidMessage(name) }, { status: 400 });
    }
  }

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
    return internalError('GET /api/health/records', error, { userId: user.id, table: 'health_records' });
  }

  return NextResponse.json({ records: data });
}

// 健康記録の作成・更新（UPSERT）
export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
  }

  const { record_date, ...recordData } = body;

  if (typeof record_date !== 'string' || !record_date.trim()) {
    return NextResponse.json({ error: HEALTH_RECORD_DATE_REQUIRED_MESSAGE }, { status: 400 });
  }

  // #256: record_date フォーマット検証（YYYY-MM-DD のみ許可）
  // 存在しない日付 (2026-02-30 など) も、形だけでは通って DB の date 型への変換で 500 になるので isCalendarDate で弾く (#1463)
  // 検査した値 (前後の空白を除いた値) を、そのまま upsert・連続記録・プロフィールの体重の判定に使う (#1482。
  // 以前は trim する前の値を渡していて、前後に空白があると連続記録を黙って更新せず、今日の体重もプロフィールに写さなかった)
  const recordDate = record_date.trim();
  if (!RECORD_DATE_PATTERN.test(recordDate) || !isCalendarDate(recordDate)) {
    return NextResponse.json({ error: HEALTH_RECORD_DATE_INVALID_MESSAGE }, { status: 400 });
  }

  const { data: sanitizedRecordData, errors } = sanitizeHealthRecordPayload(recordData, {
    acceptLegacyNotes: true,
  });

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(sanitizedRecordData).length === 0) {
    return NextResponse.json({ error: HEALTH_RECORD_NO_FIELDS_MESSAGE }, { status: 400 });
  }

  // #1048 F2-19: 確認してから insert/update する check-then-act は同時リクエストで
  // UNIQUE(user_id, record_date) 違反 500 を起こし得るため upsert に統一する。
  const result = await supabase
    .from('health_records')
    .upsert(
      {
        user_id: user.id,
        record_date: recordDate,
        ...sanitizedRecordData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,record_date' },
    )
    .select()
    .single();

  if (result.error) {
    return internalError('POST /api/health/records', result.error, { userId: user.id, table: 'health_records' });
  }

  // 連続記録を更新
  await updateHealthStreak(supabase, user.id, recordDate);

  // user_profilesの体重も更新（最新の記録の場合）
  if ('weight' in sanitizedRecordData && sanitizedRecordData.weight !== null) {
    // #266: new Date() UTC ではなく JST の今日を使用
    const today = todayLocal();
    if (recordDate === today) {
      await supabase
        .from('user_profiles')
        .update({ weight: sanitizedRecordData.weight })
        .eq('id', user.id);
    }
  }

  return NextResponse.json({ record: result.data });
}
