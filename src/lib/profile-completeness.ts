/**
 * プロフィールの完成度 (user_profiles.profile_completeness。0〜100 の整数) の計算と、書いた後の行からの計算し直し (#2201 U4)。
 *
 * 数え方 (#2283 判断待ち 7 の選択 B): 利用者が入れた値だけを数える。既定値で埋まった欄は数えない。
 *   - 行の列をそのまま読む (toUserProfile の形にしない)。toUserProfile は未入力の欄を既定値 (食事のスタイル 'normal'・
 *     料理の経験 'beginner'・平日の調理の時間 30・週の運動の時間 0) で埋めるため、それを通すと未入力も「入力済み」になった
 *   - 列の既定値 (USER_PROFILE_COLUMN_DEFAULTS。行を作ると DB が入れる) と同じ値は入っていないと数える。
 *     DB は利用者が選んだ値と既定値を区別して持たないため、利用者が既定値と同じ値を選んだ欄も数えない
 *   - 名前は、アプリが行を作るときに入れる仮置き (PROFILE_NAME_PLACEHOLDER) と空白だけを入っていないと数える (normalizeProfileName)
 *   - アプリが既定値のある列から作って書く欄 (オンボーディングの完了の体づくりの目標・目標の文・週の運動の時間) は、書く側が
 *     元の質問に答えたときだけ書く (src/lib/onboarding-derived-columns.ts)。作った値 (例: 既定値の日数 3 × 60 = 180) は列の既定値と
 *     違うため、ここでは見分けられない
 * 欄と重みは以前の PUT /api/profile の計算と同じ (変えたのは「入っている」の判定だけ)。
 *
 * 問題 (#2201 U4 の直す前): profile_completeness を書くのは PUT /api/profile だけで、AI 相談の update_profile_preferences (身長・体重・年齢・
 * 体づくりの目標・健康の状態などを書く) と add_health_record (今日の体重を user_profiles.weight にも写す) は計算し直さなかった。
 * AI で身長・体重を入れると、帯 (ProfileReminderBanner) の未入力の一覧は消えるが「プロフィール完成度 X%」と帯は古いまま残った
 * (読み込み直しても同じ)。書いた後の行から計算し直す refreshProfileCompleteness を、書いたあとに呼ぶ。
 * PUT も本文ではなく書いた後の行から数える (目標の体重だけを送る栄養の目標の画面の PUT で、ほかの欄が埋まっていても完成度が 5 になっていたため)。
 *
 * 完成度は、読んだときの完成度のままの行にだけ書く (syncProfileCompletenessOfRow。#2206 G4)。条件なしで書くと、読んでから
 * 書くまでに別の書き手が計算し直した新しい値を、古い行から数えた値で上書きしえた。
 * モバイルのオンボーディングの途中保存 (画面から直接 user_profiles に書く) は、保存のあとに POST /api/profile/completeness を呼ぶ。
 * 完成度は書くときにだけ計算し直す (読む側は保存した値を出す)。古い数え方で保存した値は、その利用者の次の書き込みで書き直る
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeProfileName } from '@homegohan/shared';
import type { DbUserProfile } from '@/types/database';

/** 完成度の満点 (百分率) */
const PROFILE_COMPLETENESS_FULL_PERCENT = 100;

/**
 * user_profiles の列の既定値のうち、完成度に数える列にあって「何か入っている」に見えるもの
 * (supabase/migrations/20251126124224_create_meal_planner_tables.sql の CREATE TABLE user_profiles の DEFAULT。行を作ると DB が入れる)。
 * 完成度はこれと同じ値を入っていないと数える (#2283)。ほかの数える列の既定値は無い (NULL) か空の配列 (入っていないと数える)。
 * migration の DEFAULT との一致は tests/profile-completeness-column-defaults-2283.test.ts が検査する
 */
export const USER_PROFILE_COLUMN_DEFAULTS = {
  weekly_exercise_minutes: 0,
  diet_style: 'normal',
  cooking_experience: 'beginner',
  weekday_cooking_minutes: 30,
  cuisine_preferences: { chinese: 3, western: 3, japanese: 4 },
} as const;

/** 列の既定値 (USER_PROFILE_COLUMN_DEFAULTS の値) */
type ColumnDefaultValue = (typeof USER_PROFILE_COLUMN_DEFAULTS)[keyof typeof USER_PROFILE_COLUMN_DEFAULTS];

/**
 * 欄の値の数え方: 値がある (null・undefined・空文字・'unspecified' でない) / 1 つ以上の配列 / キーが 1 つ以上のオブジェクト /
 * 名前 (normalizeProfileName が null でない。空白だけ・仮置きの名前は入っていない)
 */
type CompletenessFieldKind = 'value' | 'array' | 'object' | 'name';

/** 完成度に数える欄。column は user_profiles の列、key は画面の形 (toUserProfile の camelCase) の名前 */
type CompletenessField = {
  column: keyof DbUserProfile;
  key: string;
  weight: number;
  kind: CompletenessFieldKind;
  /** 列の既定値。これと同じ値は入っていないと数える (#2283) */
  columnDefault?: ColumnDefaultValue;
};

/**
 * 完成度に数える欄と重み。重みの合計に対する、埋まっている欄の重みの割合を百分率にする。
 * 欄と重みは PUT /api/profile の以前の計算と同じ (分類ごとの重みはコメントの割合の目安)
 */
const PROFILE_COMPLETENESS_FIELDS: ReadonlyArray<CompletenessField> = [
  // 基本情報
  { column: 'nickname', key: 'nickname', weight: 4, kind: 'name' },
  { column: 'age', key: 'age', weight: 4, kind: 'value' },
  { column: 'gender', key: 'gender', weight: 4, kind: 'value' },
  { column: 'height', key: 'height', weight: 4, kind: 'value' },
  { column: 'weight', key: 'weight', weight: 4, kind: 'value' },
  // 目標
  { column: 'goal_text', key: 'goalText', weight: 5, kind: 'value' },
  { column: 'fitness_goals', key: 'fitnessGoals', weight: 5, kind: 'array' },
  { column: 'target_weight', key: 'targetWeight', weight: 5, kind: 'value' },
  // 仕事・生活
  { column: 'occupation', key: 'occupation', weight: 5, kind: 'value' },
  { column: 'work_style', key: 'workStyle', weight: 5, kind: 'value' },
  {
    column: 'weekly_exercise_minutes',
    key: 'weeklyExerciseMinutes',
    weight: 5,
    kind: 'value',
    columnDefault: USER_PROFILE_COLUMN_DEFAULTS.weekly_exercise_minutes,
  },
  // 健康
  { column: 'health_conditions', key: 'healthConditions', weight: 5, kind: 'array' },
  { column: 'sleep_quality', key: 'sleepQuality', weight: 5, kind: 'value' },
  { column: 'stress_level', key: 'stressLevel', weight: 5, kind: 'value' },
  // 食事制限
  { column: 'diet_flags', key: 'dietFlags', weight: 5, kind: 'object' },
  { column: 'diet_style', key: 'dietStyle', weight: 5, kind: 'value', columnDefault: USER_PROFILE_COLUMN_DEFAULTS.diet_style },
  { column: 'disliked_cooking_methods', key: 'dislikedCookingMethods', weight: 5, kind: 'array' },
  // 調理環境
  {
    column: 'cooking_experience',
    key: 'cookingExperience',
    weight: 5,
    kind: 'value',
    columnDefault: USER_PROFILE_COLUMN_DEFAULTS.cooking_experience,
  },
  {
    column: 'weekday_cooking_minutes',
    key: 'weekdayCookingMinutes',
    weight: 5,
    kind: 'value',
    columnDefault: USER_PROFILE_COLUMN_DEFAULTS.weekday_cooking_minutes,
  },
  // 嗜好
  {
    column: 'cuisine_preferences',
    key: 'cuisinePreferences',
    weight: 5,
    kind: 'object',
    columnDefault: USER_PROFILE_COLUMN_DEFAULTS.cuisine_preferences,
  },
  { column: 'favorite_ingredients', key: 'favoriteIngredients', weight: 5, kind: 'array' },
];

/** 完成度に数える列 (user_profiles の列名) */
export const PROFILE_COMPLETENESS_COLUMNS: ReadonlyArray<keyof DbUserProfile> = PROFILE_COMPLETENESS_FIELDS.map((field) => field.column);

/** 値が「入っていない」とみなす文字列 (性別・年代の未選択) */
const UNSPECIFIED_VALUE = 'unspecified';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 値が列の既定値と同じか。オブジェクト (jsonb) はキーの順に関わらず、キーの集まりと各値が同じなら同じ */
function equalsColumnDefault(value: unknown, columnDefault: ColumnDefaultValue): boolean {
  if (!isPlainObject(columnDefault)) return value === columnDefault;
  if (!isPlainObject(value)) return false;
  const defaultEntries = Object.entries(columnDefault);
  return Object.keys(value).length === defaultEntries.length && defaultEntries.every(([key, expected]) => value[key] === expected);
}

function isFilled(value: unknown, field: CompletenessField): boolean {
  if (field.columnDefault !== undefined && equalsColumnDefault(value, field.columnDefault)) return false;
  if (field.kind === 'name') return normalizeProfileName(value) !== null;
  if (field.kind === 'array') return Array.isArray(value) && value.length > 0;
  if (field.kind === 'object') return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== '' && value !== UNSPECIFIED_VALUE;
}

/** 欄ごとの値 (valueOf) から完成度 (0〜100 の整数) を計算する */
function completenessOf(valueOf: (field: CompletenessField) => unknown): number {
  let totalWeight = 0;
  let earnedWeight = 0;
  for (const field of PROFILE_COMPLETENESS_FIELDS) {
    totalWeight += field.weight;
    if (isFilled(valueOf(field), field)) earnedWeight += field.weight;
  }
  return Math.round((earnedWeight / totalWeight) * PROFILE_COMPLETENESS_FULL_PERCENT);
}

/**
 * 画面の形 (toUserProfile の camelCase) のプロフィールの完成度 (0〜100 の整数)。判定は profileCompletenessOfRow と同じ
 * (toUserProfile が未入力の欄に入れる既定値は列の既定値と同じなので、入っていないと数える)
 */
export function calculateProfileCompleteness(profile: Readonly<Record<string, unknown>>): number {
  return completenessOf((field) => profile[field.key]);
}

/**
 * user_profiles の行 (select('*')) から完成度を計算する。列をそのまま読む (列が無い・null は入っていない)。
 * 書く経路 (PUT・POST /api/profile・health・オンボーディング・AI 相談・POST /api/profile/completeness) はどれもこれで数えるので、
 * Web とモバイル (途中保存のあとに POST /api/profile/completeness を呼ぶ) で同じ値になる
 */
export function profileCompletenessOfRow(row: Partial<DbUserProfile>): number {
  return completenessOf((field) => row[field.column]);
}

/** refreshProfileCompleteness の結果 */
export type ProfileCompletenessRefreshOutcome =
  | { status: 'updated'; completeness: number }
  | { status: 'unchanged'; completeness: number }
  | { status: 'not_found' }
  | { status: 'error'; error: unknown };

/**
 * syncProfileCompletenessOfRow の結果 (row は応答に返す行。書けたときは新しい完成度を入れた行、一度も書けなかったときは渡した行のまま。
 * 一度書けた後に失敗したときは、最後に分かった DB の完成度を入れた行。#2227 H4)
 */
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
 *   - PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS 回で書けなければ諦める (error)。上限は書き込みの回数で、最後の書き込みの
 *     あとの数え直しは回数に数えない (最後の試みで書けて数え直しも同じなら updated。#2227 H4)
 * 一度書けた後に失敗した (書き込み・読み直しの失敗・行の消失・上限) ときも、応答の行の完成度は、渡した行の古い値ではなく
 * 最後に分かった DB の完成度 (書いた値。そのあと読み直したならその行の値) にする (#2227 H4)
 * 例外は投げず、結果を返す (呼び出し側は、欄の書き込みそのものは成功として扱い、失敗はログに残すだけ)
 */
export async function syncProfileCompletenessOfRow<Row extends Partial<DbUserProfile>>(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
  row: Row,
): Promise<ProfileCompletenessRowSync<Row>> {
  let current: Partial<DbUserProfile> = row;
  let wrote = false;
  /** 応答に返す行 (完成度を最後に分かった DB の値にする)。一度も書いていなければ渡した行のまま */
  const rowWithStored = (stored: number | null): Row =>
    row.profile_completeness === stored ? row : { ...row, profile_completeness: stored };
  /** 失敗したときの結果 (一度書けた後なら、行の完成度は最後に分かった DB の値) */
  const failed = (error: unknown): ProfileCompletenessRowSync<Row> => ({
    row: wrote ? rowWithStored(current.profile_completeness ?? null) : row,
    outcome: { status: 'error', error },
  });
  /** 今の行 (current) の完成度が計算と同じなら、終わりの結果。違えば null (書く必要がある) */
  const settledOf = (): ProfileCompletenessRowSync<Row> | null => {
    const completeness = profileCompletenessOfRow(current);
    if ((current.profile_completeness ?? null) !== completeness) return null;
    const outcome = wrote ? { status: 'updated' as const, completeness } : { status: 'unchanged' as const, completeness };
    return { row: rowWithStored(completeness), outcome };
  };
  try {
    for (let attempt = 1; attempt <= PROFILE_COMPLETENESS_WRITE_MAX_ATTEMPTS; attempt += 1) {
      const settled = settledOf();
      if (settled) return settled;
      const completeness = profileCompletenessOfRow(current);
      const stored = current.profile_completeness ?? null;
      const update = supabase.from('user_profiles').update({ profile_completeness: completeness }).eq('id', userId);
      const conditioned = stored === null ? update.is('profile_completeness', null) : update.eq('profile_completeness', stored);
      const { data: written, error: writeError } = await conditioned.select('*').maybeSingle();
      if (writeError) return failed(writeError);
      if (written) {
        wrote = true;
        current = written;
        continue;
      }
      // 0 行: 読んでから書くまでに別の書き手が完成度を書いた。今の行を読み直して数え直す
      const { data: reread, error: readError } = await supabase.from('user_profiles').select('*').eq('id', userId).maybeSingle();
      if (readError) return failed(readError);
      if (!reread) return failed(new ProfileCompletenessRowMissingError());
      current = reread;
    }
    // 最後の試みのあとの数え直し (回数に数えない)。最後の試みで書けて同じなら updated、読み直した行が正しければ unchanged / updated
    return settledOf() ?? failed(new ProfileCompletenessWriteExhaustedError());
  } catch (error) {
    return failed(error);
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
