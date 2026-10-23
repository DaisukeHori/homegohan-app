import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { Tables } from '@homegohan/shared';
import { internalError } from '@/lib/api/errors';
import { isCalendarDate } from '@/lib/jst-day-ranges';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { invalidCalendarDateMessage } from '@/lib/api/user-api-error-messages';

/** 400 の文での期間の始まりと終わりの名前 (query の start_date / end_date) */
const START_DATE_LABEL = '開始日 (start_date)';
const END_DATE_LABEL = '終了日 (end_date)';

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
    return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');

  // 日付形式バリデーション: YYYY-MM-DD の実在する日付 (受け付ける範囲の中) だけを許可する。
  // 以前は new Date(s) で確かめていたので、2026-02-30 が 3/2 に繰り上がって通り、DB の date 型への変換で 500 になっていた (#1463)
  if (startDate && !isCalendarDate(startDate)) {
    return NextResponse.json({ error: invalidCalendarDateMessage(START_DATE_LABEL) }, { status: 400 });
  }
  if (endDate && !isCalendarDate(endDate)) {
    return NextResponse.json({ error: invalidCalendarDateMessage(END_DATE_LABEL) }, { status: 400 });
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
    return internalError('GET /api/export/meals', error, { userId: user.id });
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
    const meals = (day.planned_meals as Pick<Tables<"planned_meals">, "id" | "meal_type" | "dish_name" | "description" | "calories_kcal" | "mode" | "source_type" | "is_completed" | "created_at">[]) ?? [];
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
