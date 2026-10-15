// ハンズオンツアー Step 2 (献立) の 2.6 の吹き出しに差し込むプロフィールの取得と整形 (#1660)
// Canonical: docs/design/family/09-onboarding-handson-tour/04-step2-menu.md §3.7 / §6
//
// Web (src/lib/handson-tour/tour-profile.ts の fetchMenuTourProfile) と同じ列から取る。
//   - アレルギー・苦手な食材: user_profiles.diet_flags (jsonb) の { allergies: string[], dislikes: string[] }
//   - 料理の経験: user_profiles.cooking_experience
// ツアーは体験モードなので、取得に失敗してもブロックしない。失敗したら既定値 (除外なし・beginner 扱い) で進み、
// 失敗は failure として返す (呼び出し側が記録する)。行が無いだけは失敗にしない。

import type { Step2ResultBubbleProfile } from '@homegohan/handson-tour-shared';

import { supabase } from '../lib/supabase';

export const EMPTY_MENU_TOUR_PROFILE: Step2ResultBubbleProfile = {
  allergies: [],
  dislikes: [],
  cooking_experience: null,
};

/** 取得の失敗 1 件分 (PostgREST のエラーコードだけを持つ。文面や値は持たない) */
export type MenuTourProfileFailure = {
  table: 'user_profiles';
  code: string | null;
};

export type MenuTourProfileFetchResult = {
  profile: Step2ResultBubbleProfile;
  failure: MenuTourProfileFailure | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** jsonb の配列を「空でない文字列だけの配列」にする。配列でなければ空 (Web の toStringList と同じ) */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** user_profiles の 1 行 (diet_flags, cooking_experience) を 2.6 の吹き出し用に整える */
export function toMenuTourProfile(row: unknown): Step2ResultBubbleProfile {
  if (!isRecord(row)) return EMPTY_MENU_TOUR_PROFILE;
  const dietFlags = isRecord(row.diet_flags) ? row.diet_flags : {};
  return {
    allergies: toStringList(dietFlags.allergies),
    dislikes: toStringList(dietFlags.dislikes),
    cooking_experience: typeof row.cooking_experience === 'string' ? row.cooking_experience : null,
  };
}

function failureCodeOf(error: unknown): string | null {
  return isRecord(error) && typeof error.code === 'string' && error.code !== '' ? error.code : null;
}

/** 2.6 の吹き出しに使うプロフィールを取る。例外は投げない */
export async function fetchMenuTourProfile(userId: string): Promise<MenuTourProfileFetchResult> {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('diet_flags,cooking_experience')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      return { profile: EMPTY_MENU_TOUR_PROFILE, failure: { table: 'user_profiles', code: failureCodeOf(error) } };
    }
    return { profile: toMenuTourProfile(data), failure: null };
  } catch (thrown) {
    return { profile: EMPTY_MENU_TOUR_PROFILE, failure: { table: 'user_profiles', code: failureCodeOf(thrown) } };
  }
}
