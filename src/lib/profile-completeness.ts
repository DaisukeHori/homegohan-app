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
 *
 * 完成度は、読んだときの完成度のままの行にだけ書く (syncProfileCompletenessOfRow。#2206 G4)。条件なしで書くと、読んでから
 * 書くまでに別の書き手が計算し直した新しい値を、古い行から数えた値で上書きしえた。
 * モバイルのオンボーディングの途中保存 (画面から直接 user_profiles に書く) は、保存のあとに POST /api/profile/completeness を呼ぶ。
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
 * 完成度を条件つきで書く回数の上限。読んでから書くまでに別の書き手が完成度を書くと 0 行になり、読み直して数え直す。
 * 同時の書き込みが続いても終わるようにする (献立の料理の楽観的な排他の MEAL_DISH_WRITE_MAX_ATTEMPTS と同じ回数)。
 * 上限まで書けなかったときは諦める (そのあいだに書いた別の書き手が、書いた後の行から計算し直す)
 */
export const PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS = 5;

/** 完成度を書くあいだに、別の書き手が書き続けて PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS 回で書けなかった */
export class ProfileCompletenessWriteExhaustedError extends Error {
  constructor() {
    super(`profile completeness kept changing while writing (${PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS} attempts)`);
    this.name = 'ProfileCompletenessWriteExhaustedError';
  }
}

/** 完成度を書くあいだに、user_profiles の行が無くなった (退会など) */
export class ProfileCompletenessRowMissingError extends Error {
  constructor() {
    super('user profile row disappeared while writing profile completeness');
    this.name = 'ProfileCompletenessRowMissingError';
  }
}

/**
 * 書いた後の行 (update / insert の .select().single() が返した行) から完成度を計算し、行の profile_completeness と違えば書く (#2201 U4)。
 * PUT /api/profile・POST /api/profile のように書き込みが行を返す経路は、読み直さずにこれを使う
 * (本文から数えると、目標の体重だけの PUT のような部分の本文で、ほかの欄が埋まっていても完成度が本文の欄の分だけになる)。
 *
 * 書くときは、読んだときの完成度のままの行にだけ書く (楽観的な排他。#2206 G4)。条件なしで書くと、読んでから書くまでに
 * 別の書き手 (PUT /api/profile など) が欄を書いて計算し直した新しい完成度を、古い行から数えた値で上書きしえた。
 *   - 書けたら、書いた後の行 (書いた時点の全部の欄) から数え直し、同じなら終わる。違えば (読んでから書くまでに欄が
 *     書き換わっていた) その行の完成度を条件にもう一度書く
 *   - 0 行なら (別の書き手が先に完成度を書いた) 今の行を読み直して数え直す
 *   - PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS 回で書けなければ諦める (error)
 * 例外は投げず、結果を返す (呼び出し側は、欄の書き込みそのものは成功として扱い、失敗はログに残すだけ)
 */
export async function syncProfileCompletenessOfRow<Row extends Partial<DbUserProfile>>(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
  row: Row,
): Promise<ProfileCompletenessRowSync<Row>> {
  try {
    let current: Partial<DbUserProfile> = row;
    let wrote = false;
    for (let attempt = 1; attempt <= PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS; attempt += 1) {
      const completeness = profileCompletenessOfRow(current);
      const stored = current.profile_completeness ?? null;
      if (stored === completeness) {
        const outcome = wrote ? { status: 'updated' as const, completeness } : { status: 'unchanged' as const, completeness };
        const syncedRow = row.profile_completeness === completeness ? row : { ...row, profile_completeness: completeness };
        return { row: syncedRow, outcome };
      }
      const update = supabase.from('user_profiles').update({ profile_completeness: completeness }).eq('id', userId);
      const conditioned = stored === null ? update.is('profile_completeness', null) : update.eq('profile_completeness', stored);
      const { data: written, error: writeError } = await conditioned.select('*').maybeSingle();
      if (writeError) return { row, outcome: { status: 'error', error: writeError } };
      if (written) {
        wrote = true;
        current = written;
        continue;
      }
      // 0 行: 読んでから書くまでに別の書き手が完成度を書いた。今の行を読み直して数え直す
      const { data: reread, error: readError } = await supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle();
      if (readError) return { row, outcome: { status: 'error', error: readError } };
      if (!reread) return { row, outcome: { status: 'error', error: new ProfileCompletenessRowMissingError() } };
      current = reread;
    }
    return { row, outcome: { status: 'error', error: new ProfileCompletenessWriteExhaustedError() } };
  } catch (error) {
    return { row, outcome: { status: 'error', error } };
  }
}

/**
 * user_profiles の今の行 (書いた後の行) を読み、完成度を計算し直して、変わっていれば profile_completeness を書く (#2201 U4)。
 * 書き込みが行を返さない経路 (欄だけを update する health の records / quick / goals・AI 相談・オンボーディング・
 * モバイルの途中保存のあとの POST /api/profile/completeness など) が使う。書き方は syncProfileCompletenessOfRow と同じ (条件つき)。
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
