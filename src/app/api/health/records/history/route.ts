import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { addDays, formatLocalDate } from '@/lib/date-utils';
import { clampIntParam } from '@/lib/http-params';

// 体重履歴を取得（直近N日間）
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  // #1048 F2-16: days=abc 等の不正値は parseInt が NaN を返し、
  // 後続の Date 演算で RangeError（未処理例外→500）になっていた。
  // clampIntParam で安全にフォールバック・クランプする（日数の制限は最大90日）。
  const limitedDays = clampIntParam(searchParams.get('days'), { min: 1, max: 90, default: 7 });

  // N日前の日付を計算
  const startDateStr = formatLocalDate(addDays(new Date(), -limitedDays));

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
