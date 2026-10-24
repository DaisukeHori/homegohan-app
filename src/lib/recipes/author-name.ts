// src/lib/recipes/author-name.ts
// レシピ・レシピのコメントの API (GET/POST /api/recipes・/api/recipes/[id]・/api/recipes/[id]/comments) が返す authorName (#1649)。
//
// 作者の表示名は、user_profiles.nickname を normalizeProfileName で整えたもの (空・空白だけ・仮置きの 'Guest' は「名前が無い」)。
// 他人の名前は SECURITY DEFINER の関数 recipe_author_display_names (src/lib/recipes/viewer-lookups.ts) が、公開の作者で
// 名前を出す設定の人についてだけ返す (docs/design/cross/21-recipe-author-display-name.md)。返らなかった作者・名前が無い作者は
// 既定の呼称 '匿名' にする。
import { normalizeProfileName } from '@/lib/profile-name';

/** 作者の名前が無いときに返す呼称 (Web のレシピの画面がそのまま出す) */
export const RECIPE_AUTHOR_FALLBACK_NAME = '匿名';

/** プロフィールの編集画面の「名前を出す」の切り替え (user_profiles.show_recipe_author_name) のラベル */
export const RECIPE_AUTHOR_NAME_SETTING_LABEL = '公開したレシピとコメントに、ニックネームを作者名として表示する';

/** 同じ切り替えの注記 (オフにしたときの見え方) */
export const RECIPE_AUTHOR_NAME_SETTING_NOTE = `オフにすると、他の人には「${RECIPE_AUTHOR_FALLBACK_NAME}」と表示されます。あなた自身の画面には、自分の名前が表示されます。`;

/** 関数が返した表示名 (または user_profiles.nickname) から、API が返す作者名を作る */
export function recipeAuthorName(nickname: unknown): string {
  return normalizeProfileName(nickname) ?? RECIPE_AUTHOR_FALLBACK_NAME;
}
