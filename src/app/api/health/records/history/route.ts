import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// 体重履歴を取得（直近N日間）
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '7');

  // 日数の制限（最大90日）
  const limitedDays = Math.min(Math.max(days, 1), 90);

  // N日前の日付を計算
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - limitedDays);
  const startDateStr = startDate.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('health_records')
    .select('record_date, weight, body_fat_percentage, muscle_mass')
    .eq('user_id', user.id)
    .gte('record_date', startDateStr)
    .not('weight', 'is', null)
    .order('record_date', { ascending: true });

  if (error) {
    console.error('Failed to fetch weight history:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data || []);
}
