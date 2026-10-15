// Step 2 サブステップ 2.6 (結果カード) の吹き出し本文を組み立てる (#1660)
// Canonical: docs/design/family/09-onboarding-handson-tour/04-step2-menu.md §3.7 (個人情報展開) / §6 (NULL・空配列フォールバック)
//            docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §2.3 (cooking_experience セクション)
//
// 吹き出しの文 (result_bubble_full / result_bubble_no_exclude) には {exclude_list} と {cooking_experience_text} があり、
// 埋めずに出すと利用者に「{cooking_experience_text}」の文字がそのまま見える (#1660 でモバイルがそうなっていた)。
// Web とモバイルが同じ埋め方をするよう、ここに 1 つだけ置く。

import { HANDSON_TOUR_I18N_JA } from './i18n';
import { personalize } from './personalize';

/** user_profiles.cooking_experience の取りうる値 (設計書 04 §6) */
export const COOKING_EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;

export type CookingExperienceLevel = (typeof COOKING_EXPERIENCE_LEVELS)[number];

/** cooking_experience が NULL (未回答) や想定外の値のときの扱い。設計書 04 §6「cooking_experience = NULL → beginner 扱い」 */
export const DEFAULT_COOKING_EXPERIENCE: CookingExperienceLevel = 'beginner';

/** 除外の一覧に出す件数の上限。設計書 04 §3.7「最大 3 件表示」 */
export const STEP2_EXCLUDE_LIST_MAX = 3;

/** 除外の一覧の区切り。設計書 04 §3.7 の excludeList.join('・') */
export const STEP2_EXCLUDE_LIST_SEPARATOR = '・';

/** 2.6 の吹き出しに使うプロフィール (アレルギー・苦手な食材・料理の経験) */
export type Step2ResultBubbleProfile = {
  allergies: readonly string[];
  dislikes: readonly string[];
  cooking_experience: string | null | undefined;
};

/** 吹き出しの文言 (JA / EN のどちらでも渡せる) */
export type Step2ResultBubbleTexts = {
  step2: {
    readonly result_bubble_full: string;
    readonly result_bubble_no_exclude: string;
  };
  cooking_experience: Readonly<Record<CookingExperienceLevel, string>>;
};

const DEFAULT_TEXTS: Step2ResultBubbleTexts = {
  step2: HANDSON_TOUR_I18N_JA.tour.step2,
  cooking_experience: HANDSON_TOUR_I18N_JA.tour.cooking_experience,
};

function isCookingExperienceLevel(value: unknown): value is CookingExperienceLevel {
  return (COOKING_EXPERIENCE_LEVELS as readonly unknown[]).includes(value);
}

/** cooking_experience の値を 3 段階のどれかにする。NULL・空・想定外の値は beginner (設計書 04 §6) */
export function toCookingExperienceLevel(value: unknown): CookingExperienceLevel {
  return isCookingExperienceLevel(value) ? value : DEFAULT_COOKING_EXPERIENCE;
}

/** {cooking_experience_text} に入れる文 (例: beginner → "初心者でも作れる") */
export function cookingExperienceText(
  value: unknown,
  texts: Step2ResultBubbleTexts['cooking_experience'] = DEFAULT_TEXTS.cooking_experience,
): string {
  return texts[toCookingExperienceLevel(value)];
}

/** {exclude_list} に入れる食材 (アレルギー → 苦手な食材の順に、最大 STEP2_EXCLUDE_LIST_MAX 件) */
export function step2ExcludeList(profile: Pick<Step2ResultBubbleProfile, 'allergies' | 'dislikes'>): string[] {
  return [...profile.allergies, ...profile.dislikes].slice(0, STEP2_EXCLUDE_LIST_MAX);
}

/**
 * 2.6 の吹き出しの本文を返す。placeholder はすべて埋まる。
 *   - 除外する食材あり: "{exclude_list} は除外、{cooking_experience_text} の手順"
 *   - 除外する食材なし: "{cooking_experience_text} の手順"
 */
export function buildStep2ResultBubbleBody(
  profile: Step2ResultBubbleProfile,
  texts: Step2ResultBubbleTexts = DEFAULT_TEXTS,
): string {
  const excludeList = step2ExcludeList(profile);
  const cooking_experience_text = cookingExperienceText(profile.cooking_experience, texts.cooking_experience);

  if (excludeList.length > 0) {
    return personalize(texts.step2.result_bubble_full, {
      exclude_list: excludeList.join(STEP2_EXCLUDE_LIST_SEPARATOR),
      cooking_experience_text,
    });
  }
  return personalize(texts.step2.result_bubble_no_exclude, { cooking_experience_text });
}
