import { addDays, formatLocalDate, parseLocalDate } from '@/lib/date-utils';

/**
 * #1048 F2-03: health_records の連続記録(streak)更新を共通化する。
 *
 * records/route.ts と records/quick/route.ts に同一ロジックが重複していたため、
 * ここに一本化する。あわせて「過去日付のバックフィルで streak が壊れる」バグを修正する。
 *
 * 修正内容:
 *   - recordDate が last_activity_date と同じ日 → 何もしない（重複カウント防止、既存動作を維持）
 *   - recordDate が last_activity_date より過去（バックフィル）
 *     → current_streak / longest_streak / last_activity_date / streak_start_date /
 *       achieved_badges は一切変更せず、total_records のみ加算する。
 *       （前進済みの streak を過去日の登録で巻き戻さないため）
 *   - recordDate が last_activity_date より未来（通常の新規記録）
 *     → 従来通り、連続日数の前進 / リセットを判定する。
 */

const STREAK_TYPE = 'daily_record';
const BADGE_MILESTONES = [7, 14, 30, 60, 100] as const;

type SupabaseLike = any;

export async function updateHealthStreak(
  supabase: SupabaseLike,
  userId: string,
  recordDate: string,
): Promise<void> {
  const { data: streak } = await supabase
    .from('health_streaks')
    .select('*')
    .eq('user_id', userId)
    .eq('streak_type', STREAK_TYPE)
    .single();

  if (!streak) {
    await supabase
      .from('health_streaks')
      .insert({
        user_id: userId,
        streak_type: STREAK_TYPE,
        current_streak: 1,
        longest_streak: 1,
        last_activity_date: recordDate,
        streak_start_date: recordDate,
        achieved_badges: [],
        total_records: 1,
      });
    return;
  }

  const lastDate: string | null = streak.last_activity_date;

  if (lastDate && recordDate === lastDate) {
    // 同じ日の記録は無視（streak・total_records とも変更なし）
    return;
  }

  if (lastDate && recordDate < lastDate) {
    // #1048 F2-03: 過去日付のバックフィル。既に前進済みの streak を巻き戻さない。
    await supabase
      .from('health_streaks')
      .update({
        total_records: streak.total_records + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', streak.id);
    return;
  }

  const yesterdayStr = formatLocalDate(addDays(parseLocalDate(recordDate), -1));

  let newStreak = streak.current_streak;
  let newStreakStart = streak.streak_start_date;

  if (lastDate === yesterdayStr) {
    // 連続している
    newStreak += 1;
  } else {
    // 連続が途切れた
    newStreak = 1;
    newStreakStart = recordDate;
  }

  const longestStreak = Math.max(streak.longest_streak, newStreak);

  const achievedBadges: string[] = streak.achieved_badges || [];
  for (const milestone of BADGE_MILESTONES) {
    const badgeCode = `${milestone}_days`;
    if (newStreak >= milestone && !achievedBadges.includes(badgeCode)) {
      achievedBadges.push(badgeCode);
    }
  }

  await supabase
    .from('health_streaks')
    .update({
      current_streak: newStreak,
      longest_streak: longestStreak,
      last_activity_date: recordDate,
      streak_start_date: newStreakStart,
      achieved_badges: achievedBadges,
      total_records: streak.total_records + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', streak.id);
}
