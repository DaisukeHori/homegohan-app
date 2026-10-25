// src/lib/recipes/recipe-body.ts
// レシピの作成 (POST /api/recipes)・更新 (PUT /api/recipes/[id]) の本文の名前 (name) の検査 (#1917 の続き)。
//
// recipes.name は NOT NULL の text (supabase/baseline/prod_schema.sql の recipes)。以前の POST は本文の name を確かめずに
// そのまま insert し、name の無い本文 ({}・[] など) が NOT NULL 違反の DB の失敗になって 500 を返していた。
// PUT も name: null・'' を送ると同じ失敗になる (null は NOT NULL 違反)。どちらも DB に渡す前に 400 で断る。
import { z } from 'zod';

/** 400: レシピの名前 (name) が無い・空・空白だけ・文字列でない */
export const RECIPE_NAME_REQUIRED_MESSAGE = 'レシピの名前 (name) を入力してください';

/** 名前として受け付ける値か (1 文字以上の文字列で、空白だけではない)。値は削らずにそのまま保存する (従来どおり) */
export function isRecipeName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * POST /api/recipes の本文の必須の項目。オブジェクト (配列でない) で、name が isRecipeName を満たすこと。
 * ほかの項目は従来どおり route が既定の値で埋める (ここでは見ない)
 */
export const RecipeCreateBodySchema = z.object({
  name: z.string().refine(isRecipeName),
});
