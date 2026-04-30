import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * #133 CSV エクスポート
 * planned_meals を日付範囲で取得し CSV 形式で返す。
 * Content-Disposition: attachment で直接ダウンロードさせる。
 */

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // formula injection 防止: =, +, -, @ で始まる場合は ' を prepend (CVE 2014-6364 系)
  const safe = /^[=+\-@]/.test(str) ? `'${str}` : str;
  // ダブルクォート・カンマ・改行を含む場合はクォートで囲む
  if (safe.includes('"') || safe.includes(',') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function rowToCsv(cols: unknown[]): string {
  return cols.map(escapeCsv).join(',');
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');

  // 日付形式バリデーション: YYYY-MM-DD 形式かつ有効な日付のみ許可
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isValidDate = (s: string) => ISO_DATE_RE.test(s) && !isNaN(new Date(s).getTime());
  if (startDate && !isValidDate(startDate)) {
    return NextResponse.json({ error: 'Invalid start_date' }, { status: 400 });
  }
  if (endDate && !isValidDate(endDate)) {
    return NextResponse.json({ error: 'Invalid end_date' }, { status: 400 });
  }

  // user_daily_meals → planned_meals を JOIN
  let query = supabase
    .from('user_daily_meals')
    .select(`
      day_date,
      theme,
      is_cheat_day,
      planned_meals(
        id,
        meal_type,
        dish_name,
        description,
        calories_kcal,
        mode,
        source_type,
        is_completed,
        created_at
      )
    `)
    .eq('user_id', user.id)
    .order('day_date', { ascending: true });

  if (startDate) query = query.gte('day_date', startDate);
  if (endDate) query = query.lte('day_date', endDate);

  const { data: days, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // CSV 組み立て
  const headers = [
    'date',
    'meal_type',
    'dish_name',
    'description',
    'calories_kcal',
    'mode',
    'source_type',
    'is_completed',
    'day_theme',
    'is_cheat_day',
    'created_at',
  ];

  const rows: string[] = [headers.join(',')];

  for (const day of days ?? []) {
    const meals = (day.planned_meals as any[]) ?? [];
    if (meals.length === 0) {
      // 献立のない日も 1 行記録
      rows.push(rowToCsv([
        day.day_date, '', '', '', '', '', '', '', day.theme ?? '', day.is_cheat_day ?? false, '',
      ]));
    } else {
      for (const m of meals) {
        rows.push(rowToCsv([
          day.day_date,
          m.meal_type ?? '',
          m.dish_name ?? '',
          m.description ?? '',
          m.calories_kcal ?? '',
          m.mode ?? '',
          m.source_type ?? '',
          m.is_completed ?? false,
          day.theme ?? '',
          day.is_cheat_day ?? false,
          m.created_at ?? '',
        ]));
      }
    }
  }

  const csv = rows.join('\r\n');
  const today = new Date().toISOString().slice(0, 10);
  const filename = `homegohan-meals-${today}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
