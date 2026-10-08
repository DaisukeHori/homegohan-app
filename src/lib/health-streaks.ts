import { addDays, formatLocalDate, parseLocalDate } from '@/lib/date-utils';
import { createLogger } from '@/lib/db-logger';

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
 *
 * #1223: 更新の原子化（同時リクエストによる lost update の防止）
 *   従来は「SELECT → JS で計算 → UPDATE .eq('id')」だったため、同じユーザーの
 *   リクエストがほぼ同時に 2 本届くと両方が同じ値を読み、片方の加算が消えていた
 *   （total_records のズレ・7/14/30/60/100 日バッジの付与漏れ）。
 *   DB 関数 (migration) なしで原子的にするため、計算を純粋関数 computeNextStreak に
 *   切り出し、書き込みは楽観的ロック (compare-and-swap) + 再読込リトライにする。
 *   方式は src/lib/plan/coupon.ts の incrementCouponUsesCount と同じ。
 *     - UPDATE は「読み込んだ時点の total_records のままの行」にだけ効く。
 *       0 行しか更新されなければ他のリクエストが先に書いたので、読み直して計算し直す。
 *     - この関数が書き込む全パスで total_records を +1 するため、
 *       total_records をそのまま版番号として使える（列の追加は不要）。
 *       読んだ後に行が削除・再作成された場合 (DELETE /api/health/streaks) は id が変わるので、
 *       id 条件で衝突として検出でき、古い値で書き戻してしまうことはない。
 *     - 初回 INSERT が UNIQUE(user_id, streak_type) 違反 (23505) になったら、
 *       他のリクエストが先に行を作ったので、読み直して更新パスに入る。
 */

const STREAK_TYPE = 'daily_record';
const BADGE_MILESTONES = [7, 14, 30, 60, 100] as const;

/**
 * 楽観的ロックが衝突したときに、読み直してやり直す最大回数。
 * 衝突したということは、その間に別のリクエストが 1 本成功している。
 * そのため、互いに重なって走るリクエストがこの本数以内なら、すべて成功する。
 */
export const MAX_STREAK_UPDATE_ATTEMPTS = 5;

/** PostgreSQL の unique_violation (health_streaks は UNIQUE(user_id, streak_type)) */
const PG_UNIQUE_VIOLATION = '23505';

const logger = createLogger('health-streaks');

type SupabaseLike = any;

/** computeNextStreak が参照する health_streaks の列。DB 上はどれも NULL を取り得る。 */
export interface StreakSnapshot {
  current_streak: number | null;
  longest_streak: number | null;
  last_activity_date: string | null;
  streak_start_date: string | null;
  achieved_badges: string[] | null;
  total_records: number | null;
}

/**
 * computeNextStreak が決めた「書き込む列」。
 * total_records は必ず含む（楽観的ロックの版番号を兼ねるため、書き込みのたびに +1 する）。
 */
export interface StreakPatch {
  current_streak?: number;
  longest_streak?: number;
  last_activity_date?: string;
  streak_start_date?: string | null;
  achieved_badges?: string[];
  total_records: number;
}

/**
 * 連続記録の次の状態を計算する純粋関数（DB にも時計にも触らない）。
 *
 * @param streak 現在の health_streaks 行。まだ行が無い（初回の記録）なら null
 * @param recordDate 記録日 (YYYY-MM-DD)
 * @returns 書き込む列。何も変えない（同じ日の記録）なら null。
 *   streak が null のときは行を新規作成するための全列を返す。
 */
export function computeNextStreak(
  streak: StreakSnapshot | null,
  recordDate: string,
): StreakPatch | null {
  if (!streak) {
    // 初回の記録: 1 日目として行を新規作成する
    return {
      current_streak: 1,
      longest_streak: 1,
      last_activity_date: recordDate,
      streak_start_date: recordDate,
      achieved_badges: [],
      total_records: 1,
    };
  }

  const lastDate = streak.last_activity_date;

  if (lastDate && recordDate === lastDate) {
    // 同じ日の記録は無視（streak・total_records とも変更なし）
    return null;
  }

  // total_records は NULL 許容列。NULL は 0 件として数える。
  const totalRecords = (streak.total_records ?? 0) + 1;

  if (lastDate && recordDate < lastDate) {
    // #1048 F2-03: 過去日付のバックフィル。既に前進済みの streak を巻き戻さない。
    return { total_records: totalRecords };
  }

  const yesterdayStr = formatLocalDate(addDays(parseLocalDate(recordDate), -1));

  let newStreak = streak.current_streak ?? 0;
  let newStreakStart = streak.streak_start_date;

  if (lastDate === yesterdayStr) {
    // 連続している
    newStreak += 1;
  } else {
    // 連続が途切れた
    newStreak = 1;
    newStreakStart = recordDate;
  }

  const longestStreak = Math.max(streak.longest_streak ?? 0, newStreak);

  // 読み込んだ行の配列を書き換えないよう、コピーしてからバッジを足す
  const achievedBadges: string[] = [...(streak.achieved_badges ?? [])];
  for (const milestone of BADGE_MILESTONES) {
    const badgeCode = `${milestone}_days`;
    if (newStreak >= milestone && !achievedBadges.includes(badgeCode)) {
      achievedBadges.push(badgeCode);
    }
  }

  return {
    current_streak: newStreak,
    longest_streak: longestStreak,
    last_activity_date: recordDate,
    streak_start_date: newStreakStart,
    achieved_badges: achievedBadges,
    total_records: totalRecords,
  };
}

export type UpdateHealthStreakResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * conflict: MAX_STREAK_UPDATE_ATTEMPTS 回やり直しても競合が解消しなかった
       * db_error: DB の読み書きがエラーになった（予期しない例外を含む）
       */
      reason: 'conflict' | 'db_error';
      message: string;
    };

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * 読み込み → computeNextStreak → compare-and-swap で書き込み、を成功するまで繰り返す。
 * ログは書かない（呼び出し元の updateHealthStreak がまとめて記録する）。
 */
async function updateWithOptimisticLock(
  supabase: SupabaseLike,
  userId: string,
  recordDate: string,
): Promise<UpdateHealthStreakResult> {
  for (let attempt = 0; attempt < MAX_STREAK_UPDATE_ATTEMPTS; attempt++) {
    const { data: streak, error: fetchError } = await supabase
      .from('health_streaks')
      .select('*')
      .eq('user_id', userId)
      .eq('streak_type', STREAK_TYPE)
      .maybeSingle();

    if (fetchError) {
      // 取得に失敗したのに INSERT へ進むと別の行を作ろうとしてしまうため、ここで終える
      return {
        ok: false,
        reason: 'db_error',
        message: `health_streaks の取得に失敗しました: ${describeError(fetchError)}`,
      };
    }

    const next = computeNextStreak(streak ?? null, recordDate);
    if (!next) {
      // 同じ日の記録: 何もしない
      return { ok: true };
    }

    if (!streak) {
      const { error: insertError } = await supabase.from('health_streaks').insert({
        user_id: userId,
        streak_type: STREAK_TYPE,
        ...next,
      });
      if (!insertError) {
        return { ok: true };
      }
      if (insertError.code === PG_UNIQUE_VIOLATION) {
        // 並行リクエストが先に行を作った: 読み直して更新パスに入る
        continue;
      }
      return {
        ok: false,
        reason: 'db_error',
        message: `health_streaks の作成に失敗しました: ${describeError(insertError)}`,
      };
    }

    // compare-and-swap: 読み込んだ時点の total_records のままの行だけを更新する。
    // total_records は NULL 許容列で、NULL は .eq() では一致しないため .is() を使う。
    let update = supabase
      .from('health_streaks')
      .update({ ...next, updated_at: new Date().toISOString() })
      .eq('id', streak.id);
    update =
      typeof streak.total_records === 'number'
        ? update.eq('total_records', streak.total_records)
        : update.is('total_records', null);

    const { data: updated, error: updateError } = await update.select('id');
    if (updateError) {
      return {
        ok: false,
        reason: 'db_error',
        message: `health_streaks の更新に失敗しました: ${describeError(updateError)}`,
      };
    }
    if (updated && updated.length > 0) {
      return { ok: true };
    }
    // 楽観的ロック衝突 (他リクエストが先に行を更新した): 読み直して計算し直す
  }

  return {
    ok: false,
    reason: 'conflict',
    message: `health_streaks の更新が ${MAX_STREAK_UPDATE_ATTEMPTS} 回やり直しても競合から抜けられませんでした`,
  };
}

/**
 * 記録日 recordDate の健康記録を連続記録(streak)へ反映する。
 *
 * 例外は投げない。呼び出し元（records / records/quick / AI アクション）は健康記録の
 * 保存に成功した後でこれを呼ぶ補助的な更新のため、失敗しても記録保存の応答は失敗にしない
 * （従来のエラー無視と同じ扱い）。失敗は戻り値 { ok: false } で返し、db-logger にも残す。
 */
export async function updateHealthStreak(
  supabase: SupabaseLike,
  userId: string,
  recordDate: string,
): Promise<UpdateHealthStreakResult> {
  let result: UpdateHealthStreakResult;
  try {
    result = await updateWithOptimisticLock(supabase, userId, recordDate);
  } catch (err) {
    result = { ok: false, reason: 'db_error', message: describeError(err) };
  }

  if (!result.ok) {
    logger
      .withUser(userId)
      .error('[health-streaks] 連続記録の更新に失敗しました', new Error(result.message), {
        reason: result.reason,
        record_date: recordDate,
      });
  }
  return result;
}
