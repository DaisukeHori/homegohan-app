import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { RECORD_DATE_PATTERN, sanitizeHealthRecordPayload } from '@/lib/health-payloads';

// 特定日の健康記録を取得
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { date } = await params;

  // #1048 F2-16: 不正な date パラメータは DB 側の型キャストエラー(500)や
  // 意図しないクエリになり得るため、事前にフォーマット検証して400を返す。
  if (!RECORD_DATE_PATTERN.test(date)) {
    return NextResponse.json({ error: 'date must be in YYYY-MM-DD format' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('health_records')
    .select('*')
    .eq('user_id', user.id)
    .eq('record_date', date)
    .single();

  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 前日の記録も取得（比較用）
  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { date } = await params;

  // #1048 F2-16: 不正な date パラメータは DB 側の型キャストエラー(500)になり得るため
  // 事前にフォーマット検証して400を返す。
  if (!RECORD_DATE_PATTERN.test(date)) {
    return NextResponse.json({ error: 'date must be in YYYY-MM-DD format' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const { data: recordData, errors } = sanitizeHealthRecordPayload(body, {
    acceptLegacyNotes: true,
  });

  if (errors.length > 0) {
    return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
  }

  if (Object.keys(recordData).length === 0) {
    return NextResponse.json({ error: 'No valid health record fields were provided' }, { status: 400 });
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
    return NextResponse.json({ error: result.error.message }, { status: 500 });
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { date } = await params;

  if (!RECORD_DATE_PATTERN.test(date)) {
    return NextResponse.json({ error: 'date must be in YYYY-MM-DD format' }, { status: 400 });
  }

  const { error } = await supabase
    .from('health_records')
    .delete()
    .eq('user_id', user.id)
    .eq('record_date', date);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
