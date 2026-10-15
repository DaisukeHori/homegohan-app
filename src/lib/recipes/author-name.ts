// src/lib/recipes/author-name.ts
// レシピ・レシピのコメントの API (GET/POST /api/recipes・/api/recipes/[id]・/api/recipes/[id]/comments) が返す authorName (#1649)。
//
// 作者の名前は user_profiles.nickname。名前が無い人 (空・空白だけ・仮置きの 'Guest'。判定は normalizeProfileName) は
// 既定の呼称 '匿名' にする。以前は `nickname || '匿名'` で、仮置きの 'Guest' をそのまま作者名として返していた。
import { normalizeProfileName } from '@/lib/profile-name';

/** 作者の名前が無いときに返す呼称 (Web のレシピの画面がそのまま出す) */
export const RECIPE_AUTHOR_FALLBACK_NAME = '匿名';

/** user_profiles.nickname から、API が返す作者名を作る */
export function recipeAuthorName(nickname: unknown): string {
  return normalizeProfileName(nickname) ?? RECIPE_AUTHOR_FALLBACK_NAME;
}
