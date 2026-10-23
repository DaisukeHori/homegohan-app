import { NextRequest, NextResponse } from 'next/server';
import { isCalendarDate } from '@/lib/jst-day-ranges';
import { addDaysToDate } from '@/lib/date-utils';
import { createClient } from '@/lib/supabase/server';
import { internalError } from '@/lib/api/errors';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { HEALTH_DATE_PARAM_INVALID_MESSAGE, HEALTH_RECORD_NO_FIELDS_MESSAGE } from '@/lib/health-api-messages';
import { RECORD_DATE_PATTERN, sanitizeHealthRecordPayload } from '@/lib/health-payloads';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';

// 特定日の健康記録を取得
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { date } = await params;

  // #1048 F2-16: 不正な date パラメータは DB 側の型キャストエラー(500)や
  // 意図しないクエリになり得るため、事前にフォーマット検証して400を返す。
  // 前日を暦の計算で求めるので、存在しない日付 (2026-02-30 など) もここで弾く (#1433)
  if (!RECORD_DATE_PATTERN.test(date) || !isCalendarDate(date)) {
    return NextResponse.json({ error: HEALTH_DATE_PARAM_INVALID_MESSAGE }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('health_records')
    .select('*')
    .eq('user_id', user.id)
    .eq('record_date', date)
    .single();

  if (error && error.code !== 'PGRST116') {
    return internalError('GET /api/health/records/[date]', error, { userId: user.id, table: 'health_records' });
  }

  // 前日の記録も取得（比較用）
  // 前日は暦の計算で求める (#1433。new Date(date) + setDate (ローカル時刻) + toISOString (UTC) は実行環境のタイムゾーンで結果が変わる)
  const yesterdayStr = addDaysToDate(date, -1);

  const { data: previousRecord } = await supabase
    .from('health_records')
    .select('weight, body_fat_percentage, systolic_bp, diastolic_bp')
    .eq('user_id', user.id)
    .eq('record_date', yesterdayStr)
    .single();

  return NextResponse.json({ 
    record: data || null,
    previous: previousRecord || null,
  });
}

// 特定日の健康記録を更新
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { date } = await params;

  // #1048 F2-16: 不正な date パラメータは DB 側の型キャストエラー(500)になり得るため
  // 事前にフォーマット検証して400を返す。存在しない日付 (2026-02-30 など) も、形だけでは通って DB の date 型への変換で
  // 500 になるので、GET と同じく isCalendarDate で弾く (#1463)
  if (!RECORD_DATE_PATTERN.test(date) || !isCalendarDate(date)) {
    return NextResponse.json({ error: HEALTH_DATE_PARAM_INVALID_MESSAGE }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const { data: recordData, errors } = sanitizeHealthRecordPayload(body, {
    acceptLegacyNotes: true,
  });

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(recordData).length === 0) {
    return NextResponse.json({ error: HEALTH_RECORD_NO_FIELDS_MESSAGE }, { status: 400 });
  }

  // #1048 F2-19: 確認してから insert/update する check-then-act は同時リクエストで
  // UNIQUE(user_id, record_date) 違反 500 を起こし得るため upsert に統一する。
  const result = await supabase
    .from('health_records')
    .upsert(
      {
        user_id: user.id,
        record_date: date,
        ...recordData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,record_date' },
    )
    .select()
    .single();

  if (result.error) {
    return internalError('PUT /api/health/records/[date]', result.error, { userId: user.id, table: 'health_records' });
  }

  return NextResponse.json({ record: result.data });
}

// 特定日の健康記録を削除
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { date } = await params;

  // 存在しない日付は DB の date 型への変換で 500 になるので、GET・PUT と同じく 400 にする (#1463)
  if (!RECORD_DATE_PATTERN.test(date) || !isCalendarDate(date)) {
    return NextResponse.json({ error: HEALTH_DATE_PARAM_INVALID_MESSAGE }, { status: 400 });
  }

  const { error } = await supabase
    .from('health_records')
    .delete()
    .eq('user_id', user.id)
    .eq('record_date', date);

  if (error) {
    return internalError('DELETE /api/health/records/[date]', error, { userId: user.id, table: 'health_records' });
  }

  return NextResponse.json({ success: true });
}
