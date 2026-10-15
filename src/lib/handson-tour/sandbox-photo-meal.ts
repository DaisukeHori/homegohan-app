import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ハンズオンツアー Step 1 の「お試しの記録」(POST /api/meal-plans/add-from-photo の sandbox: true) を保存する (#1604)。
 *
 * 保存先は meals (is_sandbox = true) の 1 行。設計書 09-onboarding-handson-tour の 13-integration §2.7 /
 * 08-state-db の状態遷移表 (Step 1 完了 → meals INSERT (is_sandbox=true)) / 03-step1 §3.9 の決めどおり。
 *
 * user_daily_meals (+ planned_meals) には書かない。理由:
 *   - user_daily_meals は UNIQUE(user_id, day_date) で、本物の記録の経路 (add-from-photo の通常経路・
 *     meal-plans/meals・upsert_daily_meal_slot・AI の献立生成など) は is_sandbox を見ずにその日の行を使い回す。
 *     今日のお試しの日を作ると、同じ日に記録した本物の食事がお試しの日にぶら下がり、
 *     バッジ・健康の気づき・組織チャレンジ・集計から外れ、90 日後のお試しの掃除で消える。
 *   - uniq_user_sandbox_daily_meal (利用者ごとに is_sandbox = true の日は 1 行) があるので、
 *     ツアーを途中でやめて別の日にやり直すと、2 行目の insert が一意違反になって保存が必ず失敗する。
 * meals は読む側がすべて is_sandbox = false で絞っている (user_has_non_sandbox_activity・count_meals_per_user・
 * 比較ランキングの集計) ので、本物の記録と混ざらない。
 *
 * やり直し (設計書 01-trigger-flow §7.4 / 08-state-db §4.2: 中断した利用者は Step 0 から再開) で 2 回目の保存が来たら、
 * 利用者のお試しの行 (uniq_user_sandbox_meal で 1 行だけ) を使い回して、食べた時刻などを今回の値に更新する。
 * 二重に送られて insert が競合したとき (一意違反) も、先に入った行を使う。
 */

/** PostgreSQL の一意制約違反 (unique_violation)。uniq_user_sandbox_meal に当たったとき */
const PG_UNIQUE_VIOLATION = '23505';

/** 料理名をつないで memo に入れるときの区切り (add-from-photo の通常経路の dish_name と同じ) */
const DISH_NAME_SEPARATOR = '、';

export type SandboxPhotoMealInput = {
  /** 食事の種類 (呼び出し側で validatePlannedMealInput を通したもの) */
  mealType: string;
  /** 料理名 (memo に入れる) */
  dishNames: string[];
  /** 写真の URL (ツアーはサンプルなので null) */
  imageUrl: string | null;
};

export type SandboxPhotoMealResult =
  | { ok: true; mealId: string; reused: boolean }
  | { ok: false; stage: 'select' | 'update' | 'insert'; error: unknown };

type ErrorWithCode = { code?: unknown };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as ErrorWithCode).code === PG_UNIQUE_VIOLATION;
}

async function findSandboxMealId(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ id: string | null; error: unknown }> {
  const { data, error } = await supabase
    .from('meals')
    .select('id')
    .eq('user_id', userId)
    .eq('is_sandbox', true)
    .maybeSingle();
  if (error) return { id: null, error };
  const id = (data as { id?: unknown } | null)?.id;
  return { id: typeof id === 'string' ? id : null, error: null };
}

/**
 * @param supabase ログイン中の利用者のセッションで作ったクライアント (RLS の meals_*_owner を通す)
 * @param userId   認証済みの利用者の id
 * @param now      食べた時刻 (設計書 03-step1 §3.7 の eaten_at = 保存した「今」)。テストで固定するための引数
 */
export async function saveSandboxPhotoMeal(
  supabase: SupabaseClient,
  userId: string,
  input: SandboxPhotoMealInput,
  now: Date = new Date(),
): Promise<SandboxPhotoMealResult> {
  const fields = {
    eaten_at: now.toISOString(),
    meal_type: input.mealType,
    photo_url: input.imageUrl,
    memo: input.dishNames.length > 0 ? input.dishNames.join(DISH_NAME_SEPARATOR) : null,
  };

  const existing = await findSandboxMealId(supabase, userId);
  if (existing.error) return { ok: false, stage: 'select', error: existing.error };

  if (existing.id) {
    const { error: updateError } = await supabase
      .from('meals')
      .update(fields)
      .eq('id', existing.id)
      .eq('user_id', userId);
    if (updateError) return { ok: false, stage: 'update', error: updateError };
    return { ok: true, mealId: existing.id, reused: true };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('meals')
    .insert({ ...fields, user_id: userId, is_sandbox: true })
    .select('id')
    .single();

  if (insertError) {
    if (isUniqueViolation(insertError)) {
      // 同時に送られたもう 1 回の保存が先にお試しの行を作った。その行を使う (内容は同じ本文)
      const raced = await findSandboxMealId(supabase, userId);
      if (raced.id) return { ok: true, mealId: raced.id, reused: true };
      return { ok: false, stage: 'insert', error: raced.error ?? insertError };
    }
    return { ok: false, stage: 'insert', error: insertError };
  }

  const insertedId = (inserted as { id?: unknown } | null)?.id;
  if (typeof insertedId !== 'string') {
    return { ok: false, stage: 'insert', error: new Error('meals insert returned no id') };
  }
  return { ok: true, mealId: insertedId, reused: false };
}
