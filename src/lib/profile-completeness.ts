/**
 * プロフィールの完成度 (user_profiles.profile_completeness。0〜100 の整数) の計算と、書いた後の行からの計算し直し (#2201 U4)。
 *
 * 計算は PUT /api/profile (src/app/api/profile/route.ts) が本文 (画面の編集の値。toUserProfile の形の camelCase) から行っていた
 * calculateProfileCompleteness をそのまま移したもの (欄・重み・判定は変えない)。今は PUT も本文ではなく書いた後の行から数える
 * (目標の体重だけを送る栄養の目標の画面の PUT で、ほかの欄が埋まっていても完成度が 5 になっていたため)。
 *
 * 問題 (直す前): profile_completeness を書くのは PUT /api/profile だけで、AI 相談の update_profile_preferences (身長・体重・年齢・
 * 体づくりの目標・健康の状態などを書く) と add_health_record (今日の体重を user_profiles.weight にも写す) は計算し直さなかった。
 * AI で身長・体重を入れると、帯 (ProfileReminderBanner) の未入力の一覧は消えるが「プロフィール完成度 X%」と帯は古いまま残った
 * (読み込み直しても同じ)。書いた後の行から計算し直す refreshProfileCompleteness を、書いたあとに呼ぶ。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { toUserProfile } from '@/lib/converter';
import type { DbUserProfile } from '@/types/database';

/** 完成度の満点 (百分率) */
const PROFILE_COMPLETENESS_FULL_PERCENT = 100;

/** 欄の値の数え方: 値がある (null・undefined・空文字・'unspecified' でない) / 1 つ以上の配列 / キーが 1 つ以上のオブジェクト */
type CompletenessFieldKind = 'value' | 'array' | 'object';

/**
 * 完成度に数える欄 (toUserProfile の形の camelCase) と重み。重みの合計に対する、埋まっている欄の重みの割合を百分率にする。
 * 重みは PUT /api/profile の以前の計算と同じ (分類ごとの重みはコメントの割合の目安)
 */
const PROFILE_COMPLETENESS_FIELDS: ReadonlyArray<{ key: string; weight: number; kind: CompletenessFieldKind }> = [
  // 基本情報
  { key: 'nickname', weight: 4, kind: 'value' },
  { key: 'age', weight: 4, kind: 'value' },
  { key: 'gender', weight: 4, kind: 'value' },
  { key: 'height', weight: 4, kind: 'value' },
  { key: 'weight', weight: 4, kind: 'value' },
  // 目標
  { key: 'goalText', weight: 5, kind: 'value' },
  { key: 'fitnessGoals', weight: 5, kind: 'array' },
  { key: 'targetWeight', weight: 5, kind: 'value' },
  // 仕事・生活
  { key: 'occupation', weight: 5, kind: 'value' },
  { key: 'workStyle', weight: 5, kind: 'value' },
  { key: 'weeklyExerciseMinutes', weight: 5, kind: 'value' },
  // 健康
  { key: 'healthConditions', weight: 5, kind: 'array' },
  { key: 'sleepQuality', weight: 5, kind: 'value' },
  { key: 'stressLevel', weight: 5, kind: 'value' },
  // 食事制限
  { key: 'dietFlags', weight: 5, kind: 'object' },
  { key: 'dietStyle', weight: 5, kind: 'value' },
  { key: 'dislikedCookingMethods', weight: 5, kind: 'array' },
  // 調理環境
  { key: 'cookingExperience', weight: 5, kind: 'value' },
  { key: 'weekdayCookingMinutes', weight: 5, kind: 'value' },
  // 嗜好
  { key: 'cuisinePreferences', weight: 5, kind: 'object' },
  { key: 'favoriteIngredients', weight: 5, kind: 'array' },
];

/** 値が「入っていない」とみなす文字列 (性別・年代の未選択) */
const UNSPECIFIED_VALUE = 'unspecified';

function isFilled(value: unknown, kind: CompletenessFieldKind): boolean {
  if (kind === 'array') return Array.isArray(value) && value.length > 0;
  if (kind === 'object') return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== '' && value !== UNSPECIFIED_VALUE;
}

/** プロフィール (toUserProfile の形の camelCase) の完成度 (0〜100 の整数) */
export function calculateProfileCompleteness(profile: Readonly<Record<string, unknown>>): number {
  let totalWeight = 0;
  let earnedWeight = 0;
  for (const field of PROFILE_COMPLETENESS_FIELDS) {
    totalWeight += field.weight;
    if (isFilled(profile[field.key], field.kind)) earnedWeight += field.weight;
  }
  return Math.round((earnedWeight / totalWeight) * PROFILE_COMPLETENESS_FULL_PERCENT);
}

/**
 * user_profiles の行 (select('*')) から完成度を計算する。画面の編集の値と同じ形 (toUserProfile) にしてから数える
 * (プロフィールの画面は toUserProfile の値を編集して全部の欄を PUT に送るので、本文から数えていた以前の PUT と同じ値になる)。
 * 列が欠けた行 (古い行・一部の列) は、欠けた列を toUserProfile の既定値で数える
 */
export function profileCompletenessOfRow(row: Partial<DbUserProfile>): number {
  return calculateProfileCompleteness({ ...toUserProfile(row as DbUserProfile) });
}

/** refreshProfileCompleteness の結果 */
export type ProfileCompletenessRefreshOutcome =
  | { status: 'updated'; completeness: number }
  | { status: 'unchanged'; completeness: number }
  | { status: 'not_found' }
  | { status: 'error'; error: unknown };

/** syncProfileCompletenessOfRow の結果 (row は応答に返す行。書けたときは新しい完成度を入れた行、書けなかったときは渡した行のまま) */
export type ProfileCompletenessRowSync<Row extends Partial<DbUserProfile>> = {
  row: Row;
  outcome: Exclude<ProfileCompletenessRefreshOutcome, { status: 'not_found' }>;
};

/**
 * 書いた後の行 (update / insert の .select().single() が返した行) から完成度を計算し、行の profile_completeness と違えば書く (#2201 U4)。
 * PUT /api/profile・POST /api/profile のように書き込みが行を返す経路は、読み直さずにこれを使う
 * (本文から数えると、目標の体重だけの PUT のような部分の本文で、ほかの欄が埋まっていても完成度が本文の欄の分だけになる)。
 * 例外は投げず、結果を返す (呼び出し側は、欄の書き込みそのものは成功として扱い、失敗はログに残すだけ)
 */
export async function syncProfileCompletenessOfRow<Row extends Partial<DbUserProfile>>(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
  row: Row,
): Promise<ProfileCompletenessRowSync<Row>> {
  try {
    const completeness = profileCompletenessOfRow(row);
    if (row.profile_completeness === completeness) return { row, outcome: { status: 'unchanged', completeness } };
    const { error: writeError } = await supabase.from('user_profiles').update({ profile_completeness: completeness }).eq('id', userId);
    if (writeError) return { row, outcome: { status: 'error', error: writeError } };
    return { row: { ...row, profile_completeness: completeness }, outcome: { status: 'updated', completeness } };
  } catch (error) {
    return { row, outcome: { status: 'error', error } };
  }
}

/**
 * user_profiles の今の行 (書いた後の行) を読み、完成度を計算し直して、変わっていれば profile_completeness を書く (#2201 U4)。
 * 書き込みが行を返さない経路 (欄だけを update する health の records / quick / goals・AI 相談・オンボーディングなど) が使う。
 * 例外は投げず、結果を返す (呼び出し側は、欄の書き込みそのものは成功として扱い、失敗はログに残すだけ)。
 * supabase は利用者のセッションのクライアント (本人の行だけの RLS のもとで読み書きする)
 */
export async function refreshProfileCompleteness(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
): Promise<ProfileCompletenessRefreshOutcome> {
  try {
    const { data: row, error: readError } = await supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle();
    if (readError) return { status: 'error', error: readError };
    if (!row) return { status: 'not_found' };
    const profileRow: Partial<DbUserProfile> = row;
    const { outcome } = await syncProfileCompletenessOfRow(supabase, userId, profileRow);
    return outcome;
  } catch (error) {
    return { status: 'error', error };
  }
}
