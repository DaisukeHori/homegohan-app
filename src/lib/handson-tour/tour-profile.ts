/**
 * ハンズオンツアー (Step1 写真 / Step2 献立) の吹き出しに差し込むプロフィール情報の取得と整形 (#1040 / #1306)。
 *
 * 以前のページは存在しない列 (user_profiles.allergies / dislikes / target_kcal_per_day) を select しており、
 * PostgREST が 42703 で失敗しても error を見ずに握りつぶしていたため、ニックネームを含む
 * パーソナライズが全員分「空」のままだった。実際の保存先は次のとおり。
 *   - アレルギー・苦手な食材: user_profiles.diet_flags (jsonb) の { allergies: string[], dislikes: string[] }
 *     (書き込み: /api/onboarding/progress, /api/profile)
 *   - 目標カロリー: nutrition_targets.daily_calories
 *     (書き込み: /api/onboarding/complete がオンボーディング完了時に計算して保存する。user_id は UNIQUE)
 *
 * ツアーは体験モードなので、取得に失敗してもブロックしない。失敗した項目は既定値 (空) のまま進み、
 * 失敗の内容は failures として返す (呼び出し側が tour-profile-report.ts で計測・ログに残す)。
 * 「行が無い」(オンボーディングの栄養目標計算に失敗した人など) は失敗ではなく、既定値で進む。
 *
 * 結合テスト (tests/integration/rls/handson-tour-profile-read.test.ts) からも読み込むため、
 * `@/` エイリアスや共通パッケージには依存させない。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** 取得に使う Supabase クライアント (ブラウザ用 createClient() の戻り値をそのまま渡せる) */
export type TourProfileClient = Pick<SupabaseClient, 'from'>;

export type TourProfileTable = 'user_profiles' | 'nutrition_targets';

/** 取得に失敗した問い合わせ 1 件分 */
export type TourProfileFetchFailure = {
  table: TourProfileTable;
  /** PostgREST / Postgres のエラーコード (例: 42703 = 存在しない列)。無ければ null */
  code: string | null;
  message: string;
};

export type TourProfileFetchResult<T> = {
  /** 取得できた分を反映したプロフィール (取れなかった項目は既定値) */
  profile: T;
  /** 失敗した問い合わせ。行が無かっただけ (data が null) は含めない */
  failures: TourProfileFetchFailure[];
};

/** Step2 (献立) の吹き出しに使うプロフィール */
export type MenuTourProfile = {
  nickname: string | null;
  allergies: readonly string[];
  dislikes: readonly string[];
  cooking_experience: string | null;
};

/** Step1 (写真) の吹き出しに使うプロフィール */
export type PhotoTourProfile = {
  nickname: string | null;
  /** 1 日の目標カロリー (kcal)。未計算・不正な値なら null */
  target_kcal: number | null;
};

export const EMPTY_MENU_TOUR_PROFILE: MenuTourProfile = {
  nickname: null,
  allergies: [],
  dislikes: [],
  cooking_experience: null,
};

export const EMPTY_PHOTO_TOUR_PROFILE: PhotoTourProfile = {
  nickname: null,
  target_kcal: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** jsonb の配列を「空でない文字列だけの配列」にする。配列でなければ空 */
export function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** user_profiles の 1 行 (nickname, diet_flags, cooking_experience) を Step2 用に整える */
export function toMenuTourProfile(row: unknown): MenuTourProfile {
  if (!isRecord(row)) return EMPTY_MENU_TOUR_PROFILE;
  const dietFlags = isRecord(row.diet_flags) ? row.diet_flags : {};
  return {
    nickname: toNullableString(row.nickname),
    allergies: toStringList(dietFlags.allergies),
    dislikes: toStringList(dietFlags.dislikes),
    cooking_experience: toNullableString(row.cooking_experience),
  };
}

/** nutrition_targets.daily_calories (integer) を目標カロリーにする。数値でない・0 以下は null (0 除算を避ける) */
export function toTargetKcal(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** user_profiles の 1 行 (nickname) と nutrition_targets の 1 行 (daily_calories) を Step1 用に整える */
export function toPhotoTourProfile(profileRow: unknown, targetRow: unknown): PhotoTourProfile {
  return {
    nickname: isRecord(profileRow) ? toNullableString(profileRow.nickname) : null,
    target_kcal: isRecord(targetRow) ? toTargetKcal(targetRow.daily_calories) : null,
  };
}

function toFailure(table: TourProfileTable, thrownOrError: unknown): TourProfileFetchFailure {
  const info = isRecord(thrownOrError) ? thrownOrError : null;
  const code = info && typeof info.code === 'string' && info.code !== '' ? info.code : null;
  const message = info && typeof info.message === 'string' && info.message !== '' ? info.message : String(thrownOrError);
  return { table, code, message };
}

/** 問い合わせを 1 件実行する。error も例外も failure にまとめ、決して throw しない */
async function runQuery(
  table: TourProfileTable,
  run: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ data: unknown; failure: TourProfileFetchFailure | null }> {
  try {
    const { data, error } = await run();
    if (error) return { data: null, failure: toFailure(table, error) };
    return { data: data ?? null, failure: null };
  } catch (thrown) {
    return { data: null, failure: toFailure(table, thrown) };
  }
}

function collectFailures(...results: Array<{ failure: TourProfileFetchFailure | null }>): TourProfileFetchFailure[] {
  return results.flatMap((result) => (result.failure ? [result.failure] : []));
}

/**
 * Step2 (献立) 用: ニックネーム・アレルギー/苦手な食材 (diet_flags)・料理経験を 1 回の問い合わせで取得する。
 * `.maybeSingle()` なので、行が無い場合も error にならず既定値になる。
 */
export async function fetchMenuTourProfile(
  supabase: TourProfileClient,
  userId: string,
): Promise<TourProfileFetchResult<MenuTourProfile>> {
  const result = await runQuery('user_profiles', () =>
    supabase
      .from('user_profiles')
      .select('nickname, diet_flags, cooking_experience')
      // user_profiles の PK は `id` (`user_id` 列は存在しない。#1057)
      .eq('id', userId)
      .maybeSingle(),
  );
  return { profile: toMenuTourProfile(result.data), failures: collectFailures(result) };
}

/**
 * Step1 (写真) 用: ニックネーム (user_profiles) と目標カロリー (nutrition_targets) を並行して取得する。
 * どちらかが失敗しても、取れたほうは使う。
 */
export async function fetchPhotoTourProfile(
  supabase: TourProfileClient,
  userId: string,
): Promise<TourProfileFetchResult<PhotoTourProfile>> {
  const [profileResult, targetResult] = await Promise.all([
    runQuery('user_profiles', () =>
      supabase
        .from('user_profiles')
        .select('nickname')
        .eq('id', userId)
        .maybeSingle(),
    ),
    runQuery('nutrition_targets', () =>
      supabase
        .from('nutrition_targets')
        .select('daily_calories')
        .eq('user_id', userId)
        .maybeSingle(),
    ),
  ]);
  return {
    profile: toPhotoTourProfile(profileResult.data, targetResult.data),
    failures: collectFailures(profileResult, targetResult),
  };
}
