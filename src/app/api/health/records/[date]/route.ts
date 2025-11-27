import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

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
  const body = await request.json();

  // 既存レコードを確認
  const { data: existing } = await supabase
    .from('health_records')
    .select('id')
    .eq('user_id', user.id)
    .eq('record_date', date)
    .single();

  let result;
  
  if (existing) {
    result = await supabase
      .from('health_records')
      .update({
        ...body,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();
  } else {
    result = await supabase
      .from('health_records')
      .insert({
        user_id: user.id,
        record_date: date,
        ...body,
      })
      .select()
      .single();
  }

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

