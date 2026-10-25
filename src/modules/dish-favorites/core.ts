// src/modules/dish-favorites/core.ts
// 献立の料理のお気に入り (docs/design/cross/22-dish-favorites.md)。定数・Zod の正典・純関数。
// このファイルは zod 以外を import しない (画面 (client) と route の両方から使う。DB の操作は ./server.ts)。
import { z } from 'zod';

// ───────────────────────────── 定数 (§13) ─────────────────────────────

/** 料理の名前の長さの上限 (文字)。本番の料理名の最大は 24 文字 (2026-10-25)。DB の CHECK dish_favorites_dish_name_length と同じ値 */
export const DISH_FAVORITE_NAME_MAX_CHARS = 100;
/** 役割 (main / side / soup / rice …) の長さの上限 (文字)。既存の値は 4〜5 文字の英語か 2 文字の日本語 */
export const DISH_FAVORITE_ROLE_MAX_CHARS = 20;
/** 材料の件数の上限。本番の最大は 14 件 */
export const DISH_FAVORITE_INGREDIENTS_MAX_ITEMS = 50;
/**
 * 材料 1 行 (文字列の要素) の長さの上限 (文字)。本番の材料の文字列は「鶏むね肉 200g」のような短い行と、材料全体を 1 つの長い文に
 * した 1 要素 (料理 371 件。どれも 200 文字超・最長 677 文字。2026-10-25) の 2 通り。最長の約 3 倍。写し全体は DISH_FAVORITE_DISH_MAX_BYTES が別に守る
 */
export const DISH_FAVORITE_INGREDIENT_MAX_CHARS = 2000;
/** 材料の構造の形の名前 (name) の長さの上限 (文字)。本番の最長は 11 文字。料理名の上限と同じ */
export const DISH_FAVORITE_INGREDIENT_NAME_MAX_CHARS = 100;
/** 材料の構造の形のメモ (note。「みじん切り」など) の長さの上限 (文字)。本番の最長は 19 文字 */
export const DISH_FAVORITE_INGREDIENT_NOTE_MAX_CHARS = 200;
/** 材料の分量 (amount_g) の単位。献立の生成は分量を g で書く (supabase/functions/_shared/meal-generator.ts のプロンプト) */
export const DISH_FAVORITE_INGREDIENT_AMOUNT_UNIT = 'g';
/** 作り方の手順の件数の上限。本番の最大は 6 手順 */
export const DISH_FAVORITE_STEPS_MAX_ITEMS = 30;
/** 作り方 1 手順の長さの上限 (文字) */
export const DISH_FAVORITE_STEP_MAX_CHARS = 1000;
/** 材料・作り方の markdown の長さの上限 (文字)。本番の最大は 290 文字 */
export const DISH_FAVORITE_MARKDOWN_MAX_CHARS = 8000;
/**
 * 写し (dish) の大きさの上限 (バイト。JSON.stringify の UTF-8 の長さ = dishJsonByteLength)。本番の 1 料理の最大は 3,904 バイト。
 * route (POST /api/favorites) がこの値で先に 400 にする。DB の CHECK はこれより緩い DISH_FAVORITE_DISH_DB_MAX_BYTES
 */
export const DISH_FAVORITE_DISH_MAX_BYTES = 32768;
/**
 * jsonb の文字列 (dish::text) が JSON.stringify より長くなる分の上限 (バイト)。DishSnapshotSchema の形で数えた上限は 27,759 バイト:
 *   - 数 80 個 (calories_kcal と栄養 29 項目の 30 個 + 構造の形の材料 50 件の amount_g): jsonb は数を指数を使わず全桁で書く
 *     (例: 5e-324 は 0.000…5 の 326 文字)。有限の double の全桁は 342 文字以下なので 80 × 342 = 27,360
 *   - 区切りの後の空白 (1 か所 1 バイト): 写しの鍵 36 個の「: 」と鍵の間 35 の「, 」・材料の要素の間 49・作り方の要素の間 29 で 149、
 *     構造の形の材料 1 件の中 (鍵 3 個の「: 」と鍵の間 2 の「, 」) が 5 × 50 = 250。計 399
 *   - 文字列の書き方 (エスケープ) は JSON.stringify と同じで、長さは変わらない
 * 余裕を見て 32768 にする
 */
export const DISH_FAVORITE_DISH_JSONB_TEXT_EXTRA_MAX_BYTES = 32768;
/**
 * DB の CHECK dish_favorites_dish_size (octet_length(dish::text)) の値 (バイト)。安全弁で、route が通した写しは当たらない
 * (DISH_FAVORITE_DISH_MAX_BYTES + DISH_FAVORITE_DISH_JSONB_TEXT_EXTRA_MAX_BYTES。migration には 65536 と書く。C-3 が一致を見る)
 */
export const DISH_FAVORITE_DISH_DB_MAX_BYTES = DISH_FAVORITE_DISH_MAX_BYTES + DISH_FAVORITE_DISH_JSONB_TEXT_EXTRA_MAX_BYTES;
/**
 * 1 人が保存できるお気に入りの件数の既定の上限。保存の肥大化を防ぐ安全弁 (300 件 × 最大 32 KB でも 1 人 10 MB 以内。
 * 画面は 50 件ずつ読むので 6 ページ)。運用で変えるときは環境変数 DISH_FAVORITES_MAX_PER_USER (正の整数。読むのは ./server.ts)
 */
export const DISH_FAVORITES_MAX_PER_USER_DEFAULT = 300;
/** 一覧の limit の下限・上限・既定と offset の上限 (GET /api/favorites。#1226 のテストが固定している既存の値) */
export const DISH_FAVORITES_LIST_LIMIT_MIN = 1;
export const DISH_FAVORITES_LIST_LIMIT_MAX = 200;
export const DISH_FAVORITES_LIST_LIMIT_DEFAULT = 100;
export const DISH_FAVORITES_LIST_OFFSET_MAX = 100000;
/** 一覧の検索語 (q) の長さの上限 (文字)。料理名の上限と同じ */
export const DISH_FAVORITES_QUERY_MAX_CHARS = DISH_FAVORITE_NAME_MAX_CHARS;
/** お気に入りの画面が 1 回に読む件数 (既存の PAGE_SIZE) */
export const DISH_FAVORITES_PAGE_SIZE = 50;

/** 一覧の並び (GET /api/favorites の sort) */
export const DISH_FAVORITE_SORTS = ['newest', 'oldest', 'name'] as const;
export const DishFavoriteSortSchema = z.enum(DISH_FAVORITE_SORTS);
export type DishFavoriteSort = z.infer<typeof DishFavoriteSortSchema>;
export const DISH_FAVORITE_SORT_DEFAULT: DishFavoriteSort = 'newest';

// ───────────────────────────── 失敗の文とコード (§10) ─────────────────────────────

/** 400: 本文の料理 (dish) が正典の形でない */
export const DISH_FAVORITE_INVALID_MESSAGE = '料理の内容が正しくありません';
/** 400: 料理の名前が無い・空・長すぎる (status の name・POST の dish.name) */
export const DISH_FAVORITE_NAME_INVALID_MESSAGE = '料理の名前を指定してください';
/** 400 の code (src/lib/http-params.ts の INVALID_ID_PARAM_CODE と同じ語) */
export const DISH_FAVORITE_VALIDATION_CODE = 'VALIDATION_ERROR';
/** 409 の code: 保存できる件数の上限 (cross/04 §4.1 の CONFLICT_ 系。[NEW]) */
export const DISH_FAVORITES_LIMIT_CODE = 'CONFLICT_DISH_FAVORITES_LIMIT';
/** 409: 保存できる件数の上限に達した */
export function dishFavoritesLimitMessage(max: number): string {
  return `お気に入りに保存できる件数の上限 (${max} 件) に達しています。ほかのお気に入りを削除してからお試しください`;
}

// ───────────────────────────── 名前の正規化 ─────────────────────────────

/**
 * NULL 文字 (U+0000)。Postgres の text は保存できず、問い合わせの値 (eq・ilike) に入ると DB が拒んで route が 500 になる
 * (src/lib/api/null-character.ts と同じ理由)。本文は route が rejectNullCharacterBody で先に断る。URL の値 (status の name・一覧の q) はここで扱う
 */
const NULL_CHARACTER = '\u0000';

/** 料理の表示名: 空白 (全角を含む) の連続を 1 つの半角空白にまとめ、前後を除く。幅と大文字小文字はそのまま */
export function displayDishNameOf(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 同じ料理の判定の鍵: 表示名を NFKC に正規化 (全角英数と半角カナをそろえる) し、小文字にする。DB の dish_name_key */
export function dishNameKeyOf(raw: string): string {
  return displayDishNameOf(raw).normalize('NFKC').toLowerCase();
}

/**
 * 料理の名前 (NULL 文字を含む値は通さない。入力は表示名に正規化してから長さを見る)。
 * 表示名と鍵 (dishNameKeyOf。NFKC は文字を増やすことがある: 「㌀」(U+3300) は「アパート」の 4 文字) の両方が
 * 1〜DISH_FAVORITE_NAME_MAX_CHARS 文字 (UTF-16 の長さ) のものだけを通す。DB の CHECK (char_length。コードポイントの数) には当たらない
 */
export const DishNameSchema = z
  .string()
  .refine((raw) => !raw.includes(NULL_CHARACTER))
  .transform(displayDishNameOf)
  .pipe(
    z
      .string()
      .min(1)
      .max(DISH_FAVORITE_NAME_MAX_CHARS)
      .refine((name) => dishNameKeyOf(name).length <= DISH_FAVORITE_NAME_MAX_CHARS),
  );

/**
 * 一覧の検索語 (GET /api/favorites の q): NULL 文字を除き、前後の空白を除いて、先頭 DISH_FAVORITES_QUERY_MAX_CHARS 文字で切る。
 * 無い (null) ・空なら空 (絞らない)。一覧の route は不正な値を 400 にせず丸める (limit / offset / sort と同じ。§10)
 */
export function dishFavoritesQueryOf(raw: string | null): string {
  return (raw ?? '').split(NULL_CHARACTER).join('').trim().slice(0, DISH_FAVORITES_QUERY_MAX_CHARS);
}

// ───────────────────────────── 写し (DishSnapshot) の Zod ─────────────────────────────

/** 栄養の 1 項目: 0 以上の有限の数か null (z.number() は NaN / Infinity を通さない) */
const nutrientSchema = z.number().min(0).nullable().default(null);

/** 栄養の項目 (types/domain.ts の DishDetail と同じ名前・単位。calories_kcal は別に持つ) */
const nutrientShape = {
  protein_g: nutrientSchema,
  fat_g: nutrientSchema,
  carbs_g: nutrientSchema,
  sodium_g: nutrientSchema,
  sugar_g: nutrientSchema,
  fiber_g: nutrientSchema,
  fiber_soluble_g: nutrientSchema,
  fiber_insoluble_g: nutrientSchema,
  potassium_mg: nutrientSchema,
  calcium_mg: nutrientSchema,
  phosphorus_mg: nutrientSchema,
  magnesium_mg: nutrientSchema,
  iron_mg: nutrientSchema,
  zinc_mg: nutrientSchema,
  iodine_ug: nutrientSchema,
  cholesterol_mg: nutrientSchema,
  vitamin_a_ug: nutrientSchema,
  vitamin_b1_mg: nutrientSchema,
  vitamin_b2_mg: nutrientSchema,
  vitamin_b6_mg: nutrientSchema,
  vitamin_b12_ug: nutrientSchema,
  vitamin_c_mg: nutrientSchema,
  vitamin_d_ug: nutrientSchema,
  vitamin_e_mg: nutrientSchema,
  vitamin_k_ug: nutrientSchema,
  folic_acid_ug: nutrientSchema,
  saturated_fat_g: nutrientSchema,
  monounsaturated_fat_g: nutrientSchema,
  polyunsaturated_fat_g: nutrientSchema,
} as const;

export type DishFavoriteNutrientKey = keyof typeof nutrientShape;
/** 栄養の項目名の一覧 (29 項目。calories_kcal を除く。写しを作る・RecipeModal の形にするときに回す) */
export const DISH_FAVORITE_NUTRIENT_KEYS = Object.keys(nutrientShape) as ReadonlyArray<DishFavoriteNutrientKey>;

const textLine = (maxChars: number) => z.string().trim().min(1).max(maxChars);

/** 空白だけの文字列を null にそろえる、上限つきの任意の文字列 (役割・材料のメモ) */
const optionalText = (maxChars: number) =>
  z
    .string()
    .trim()
    .max(maxChars)
    .nullable()
    .default(null)
    .transform((value) => (value ? value : null));

/**
 * 材料 1 件の構造の形。献立の生成 (Edge Function) が書く { name, amount_g, note } (§3.4 F-31)。
 * amount_g は g の数 (0 以上の有限の数) か null。ほかのキーは落とす (z.object の既定)
 */
export const DishIngredientItemSchema = z.object({
  name: textLine(DISH_FAVORITE_INGREDIENT_NAME_MAX_CHARS),
  amount_g: z.number().min(0).nullable().default(null),
  note: optionalText(DISH_FAVORITE_INGREDIENT_NOTE_MAX_CHARS),
});
export type DishIngredientItem = z.infer<typeof DishIngredientItemSchema>;

/** 材料 1 件: 1 行の文字列 (「鶏むね肉 200g」・材料全体の長い 1 行) か構造の形 (F-31 の 3 つの形をどれも受ける) */
export const DishIngredientSchema = z.union([textLine(DISH_FAVORITE_INGREDIENT_MAX_CHARS), DishIngredientItemSchema]);
export type DishIngredient = z.infer<typeof DishIngredientSchema>;
export type DishIngredientInput = z.input<typeof DishIngredientSchema>;

/** 料理の写し。dish_favorites.dish の形 (正典)。画像は持たない */
export const DishSnapshotSchema = z.object({
  name: DishNameSchema,
  role: optionalText(DISH_FAVORITE_ROLE_MAX_CHARS),
  calories_kcal: nutrientSchema,
  ...nutrientShape,
  ingredients: z.array(DishIngredientSchema).max(DISH_FAVORITE_INGREDIENTS_MAX_ITEMS).default([]),
  ingredients_md: z.string().max(DISH_FAVORITE_MARKDOWN_MAX_CHARS).nullable().default(null),
  recipe_steps: z.array(textLine(DISH_FAVORITE_STEP_MAX_CHARS)).max(DISH_FAVORITE_STEPS_MAX_ITEMS).default([]),
  recipe_steps_md: z.string().max(DISH_FAVORITE_MARKDOWN_MAX_CHARS).nullable().default(null),
});
export type DishSnapshot = z.infer<typeof DishSnapshotSchema>;
export type DishSnapshotInput = z.input<typeof DishSnapshotSchema>;

/** UUID の形 (src/lib/http-params.ts の isUuid と同じ。版と変種のビットは見ない) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().regex(UUID_PATTERN);

/** POST /api/favorites の本文 */
export const SaveDishFavoriteBodySchema = z.object({
  dish: DishSnapshotSchema,
  source_planned_meal_id: uuidSchema.nullable().default(null),
});
export type SaveDishFavoriteBody = z.infer<typeof SaveDishFavoriteBodySchema>;

/** API が返すお気に入りの 1 件 (dish_favorites の行から user_id と dish_name_key を除いたもの) */
export const DishFavoriteSchema = z.object({
  id: uuidSchema,
  dish_name: z.string(),
  dish: DishSnapshotSchema,
  source_planned_meal_id: uuidSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DishFavorite = z.infer<typeof DishFavoriteSchema>;

/** dish_favorites の行 (server.ts が select した行の検証に使う) */
export const DishFavoriteRowSchema = DishFavoriteSchema.extend({
  user_id: uuidSchema,
  dish_name_key: z.string(),
});
export type DishFavoriteRow = z.infer<typeof DishFavoriteRowSchema>;

/** 行から API の形へ (user_id と dish_name_key を落とす) */
export function toDishFavorite(row: DishFavoriteRow): DishFavorite {
  return {
    id: row.id,
    dish_name: row.dish_name,
    dish: row.dish,
    source_planned_meal_id: row.source_planned_meal_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 写しの JSON の大きさ (バイト。JSON.stringify の UTF-8 の長さ)。route が DISH_FAVORITE_DISH_MAX_BYTES と比べる (DB の CHECK はこれより緩い) */
export function dishJsonByteLength(dish: DishSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(dish)).length;
}

// ───────────────────────────── 献立の料理 → 写し ─────────────────────────────

/** 旧形式の短いキー (src/app/(main)/menus/weekly/_state/types.ts の LegacyDishDetail)。新形式が無いときに読む */
const LEGACY_NUTRIENT_KEYS: Readonly<Partial<Record<DishFavoriteNutrientKey | 'calories_kcal', string>>> = {
  calories_kcal: 'cal',
  protein_g: 'protein',
  fat_g: 'fat',
  carbs_g: 'carbs',
  fiber_g: 'fiber',
  sugar_g: 'sugar',
  sodium_g: 'sodium',
  potassium_mg: 'potassium',
  calcium_mg: 'calcium',
  phosphorus_mg: 'phosphorus',
  iron_mg: 'iron',
  zinc_mg: 'zinc',
  cholesterol_mg: 'cholesterol',
  vitamin_a_ug: 'vitaminA',
  vitamin_b1_mg: 'vitaminB1',
  vitamin_b2_mg: 'vitaminB2',
  vitamin_b6_mg: 'vitaminB6',
  vitamin_b12_ug: 'vitaminB12',
  vitamin_c_mg: 'vitaminC',
  vitamin_d_ug: 'vitaminD',
  vitamin_e_mg: 'vitaminE',
  vitamin_k_ug: 'vitaminK',
  folic_acid_ug: 'folicAcid',
};

/** 0 以上の有限の数か、それを表す文字列なら数。それ以外 (無い・負・NaN・文字列でない) は null (写しに入れない) */
function nonNegativeNumberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 文字列の配列から、空でない文字列だけを前後の空白を除いて集める。配列でなければ空 (作り方に使う) */
function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 空でない文字列ならそれ、そうでなければ null */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * 材料の配列を写す (§3.4 F-31 の形をどれも受ける)。配列でなければ空。
 *   - 文字列: 前後の空白を除き、空でなければそのまま 1 行として (短い行も長い 1 行も)
 *   - オブジェクト: name が空でない文字列なら { name (前後の空白を除く), amount_g (0 以上の数か null), note (空でない文字列か null) }
 *   - それ以外 (数・null・配列・name の無いオブジェクト): 捨てる
 */
function ingredientListOf(value: unknown): DishIngredientInput[] {
  if (!Array.isArray(value)) return [];
  const items: DishIngredientInput[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const line = item.trim();
      if (line !== '') items.push(line);
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Readonly<Record<string, unknown>>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name === '') continue;
    items.push({ name, amount_g: nonNegativeNumberOrNull(record.amount_g), note: stringOrNull(record.note) });
  }
  return items;
}

/** 新形式のキーを優先し、無ければ旧形式のキーを読む (menus/weekly/page.tsx の normalizedDish と同じ規則) */
function nutrientOf(dish: Readonly<Record<string, unknown>>, key: DishFavoriteNutrientKey | 'calories_kcal'): number | null {
  const current = nonNegativeNumberOrNull(dish[key]);
  if (current !== null) return current;
  const legacyKey = LEGACY_NUTRIENT_KEYS[key];
  return legacyKey === undefined ? null : nonNegativeNumberOrNull(dish[legacyKey]);
}

/**
 * 献立の画面が持つ料理 (selectedRecipeData.dishes[0]。DishDetail / LegacyDishDetail の形) を、POST /api/favorites の dish に写す。
 * 検証はしない (サーバーが DishSnapshotSchema で検証して 400 を返す)。name は dish.name が無ければ nameFallback (モーダルの見出し)。
 */
export function dishSnapshotFromMenuDish(dish: Readonly<Record<string, unknown>>, nameFallback = ''): DishSnapshotInput {
  const nutrients = Object.fromEntries(DISH_FAVORITE_NUTRIENT_KEYS.map((key) => [key, nutrientOf(dish, key)])) as Record<
    DishFavoriteNutrientKey,
    number | null
  >;
  return {
    name: typeof dish.name === 'string' && dish.name.trim() !== '' ? dish.name : nameFallback,
    role: stringOrNull(dish.role),
    calories_kcal: nutrientOf(dish, 'calories_kcal'),
    ...nutrients,
    ingredients: ingredientListOf(dish.ingredients),
    ingredients_md: stringOrNull(dish.ingredientsMd),
    recipe_steps: stringListOf(dish.recipeSteps),
    recipe_steps_md: stringOrNull(dish.recipeStepsMd),
  };
}

/**
 * 献立の料理の材料 (DishDetail.ingredients。型は string[] だが実データは構造の形もある。F-10・F-31) を、ingredientInputsOf に渡せる形にそろえる。
 * 読み方は dishSnapshotFromMenuDish の ingredientListOf と同じ (文字列は前後の空白を除き空なら捨てる・構造の形は name が空でなければ
 * { name, amount_g (0 以上の数か null), note (空でない文字列か null) }・それ以外は捨てる)。長さの上限では切らない (検証はしない)。
 * 献立の画面の「材料を買い物リストに追加」が使う (#2023・§21 Q-8)
 */
export function menuDishIngredientsOf(value: unknown): DishIngredient[] {
  return ingredientListOf(value).map((item) =>
    typeof item === 'string' ? item : { name: item.name, amount_g: item.amount_g ?? null, note: item.note ?? null },
  );
}

// ───────────────────────────── 写し → 画面 ─────────────────────────────

/** 構造の形の分量の表示 (「200g」)。amount_g が null なら null */
function amountTextOf(item: DishIngredientItem): string | null {
  return item.amount_g === null ? null : `${item.amount_g}${DISH_FAVORITE_INGREDIENT_AMOUNT_UNIT}`;
}

/**
 * 材料 1 件の表示の 1 行。文字列はそのまま、構造の形は「名前 分量g (メモ)」(分量・メモは無ければ付けない)。
 * RecipeModal の formatIngredientsToMarkdown は材料を文字列の配列として扱う (ingredients_md が無いときの表) ので、画面にはこの行を渡す
 */
export function ingredientLineOf(item: DishIngredient): string {
  if (typeof item === 'string') return item;
  const amount = amountTextOf(item);
  const parts = [item.name, amount, item.note === null ? null : `(${item.note})`].filter((part): part is string => part !== null);
  return parts.join(' ');
}

/**
 * お気に入りの 1 件を、献立の RecipeModal の selectedRecipeData の形にする
 * (role・calories_kcal・栄養は直下、材料と作り方は dishes[0] の ingredientsMd / recipeStepsMd と直下の ingredients / recipeSteps。画像は無し)。
 * 材料は ingredientLineOf の 1 行の文字列の配列にする (RecipeModal は文字列の配列として読む)
 */
export function recipeModalDataOf(favorite: DishFavorite): Record<string, unknown> {
  const { dish } = favorite;
  const nutrients = Object.fromEntries(DISH_FAVORITE_NUTRIENT_KEYS.map((key) => [key, dish[key]]));
  const ingredientLines = dish.ingredients.map(ingredientLineOf);
  const dishForModal: Record<string, unknown> = {
    name: dish.name,
    role: dish.role ?? undefined,
    calories_kcal: dish.calories_kcal,
    ...nutrients,
    ingredients: ingredientLines,
    recipeSteps: dish.recipe_steps,
    ingredientsMd: dish.ingredients_md ?? undefined,
    recipeStepsMd: dish.recipe_steps_md ?? undefined,
  };
  return { ...dishForModal, imageUrl: null, dishes: [dishForModal], allIngredients: ingredientLines };
}

/** 買い物リストに足す 1 件 (POST /api/shopping-list/add-recipe の ingredients の要素) */
export interface ShoppingIngredientInput {
  name: string;
  amount: string | null;
}

/** 「鶏むね肉 200g」を { name: '鶏むね肉', amount: '200g' } に分ける (menus/weekly/page.tsx の addRecipeToShoppingList が関数の中に直に書く正規表現と同じ文字列。F-32) */
const INGREDIENT_AMOUNT_PATTERN = /^(.+?)\s+(\d+.*|少々|適量|適宜)$/;

/**
 * 写しの材料を買い物リストの入力にする。構造の形は { name, amount: '<amount_g>g' (null なら null) } (メモは送らない)。
 * 文字列は INGREDIENT_AMOUNT_PATTERN で名前と分量に分け、分けられなければ { name: 行, amount: null } (長い 1 行もこの規則のまま。分け方は献立の画面と同じ)。
 * 重複は除かない: 献立の画面の new Set は同じ料理の材料の列を 2 回集めた分を戻すためのもので (F-32)、ここは写しの材料を 1 回だけ読む。
 */
export function ingredientInputsOf(ingredients: ReadonlyArray<DishIngredient>): ShoppingIngredientInput[] {
  return ingredients.map((item) => {
    if (typeof item !== 'string') return { name: item.name, amount: amountTextOf(item) };
    const match = INGREDIENT_AMOUNT_PATTERN.exec(item);
    return match ? { name: match[1], amount: match[2] } : { name: item, amount: null };
  });
}
