// src/schemas/membership/family-menu.ts
// 週間献立の「家族の表示」で読む、家族のメンバーの献立の Zod と型 (#1584 の 1・設計書 docs/design/family/10-family-menu-view.md §13)。
// このファイルはブラウザからも読むので、サーバー専用のものを import しない (import するのは zod と @homegohan/shared だけ)。
import { z } from 'zod';
import { MEAL_ORDER, type MealType } from '@homegohan/shared';

/** YYYY-MM-DD の形 (実在する日付かは route が isCalendarDate で見る) */
export const FamilyMenuCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 食事の区分。手書きの一覧を持たず、正本 MEAL_ORDER (@homegohan/shared) で判定する (#1446) */
export const FamilyMenuMealTypeSchema = z.custom<MealType>(
  (value) => typeof value === 'string' && (MEAL_ORDER as readonly string[]).includes(value),
  { message: 'meal_type' },
);

/**
 * 家族の献立の 1 食。画面に要る列だけ (メモ・生成のメタデータ・栄養の詳細は入れない)。
 * 料理は名前の並び (dish_names) だけで、dishes の料理ごとの栄養・材料・作り方・画像の情報は入れない。
 * 画像の URL (planned_meals.image_url) も入れない (他のメンバーの写真の URL を配らない。設計書 Q-8)
 */
export const FamilyMenuMealSchema = z
  .object({
    id: z.string().uuid(),
    meal_type: FamilyMenuMealTypeSchema,
    dish_name: z.string(),
    dish_names: z.array(z.string()),
    is_simple: z.boolean(),
    calories_kcal: z.number().int().nullable(),
    cooking_time_minutes: z.number().int().nullable(),
    display_order: z.number().int(),
    is_completed: z.boolean(),
  })
  .strict();

export const FamilyMenuDaySchema = z
  .object({ day_date: FamilyMenuCalendarDateSchema, meals: z.array(FamilyMenuMealSchema) })
  .strict();

/** 見てよいメンバー 1 人分。献立が無い週でも members には入る (days: []) */
export const FamilyMenuMemberSchema = z
  .object({ member_id: z.string().uuid(), user_id: z.string().uuid(), days: z.array(FamilyMenuDaySchema) })
  .strict();

/** GET /api/family/menu の応答の data */
export const FamilyMenuDataSchema = z
  .object({
    family_id: z.string().uuid().nullable(),
    start_date: FamilyMenuCalendarDateSchema,
    end_date: FamilyMenuCalendarDateSchema,
    members: z.array(FamilyMenuMemberSchema),
  })
  .strict();

export const FamilyMenuResponseSchema = z.object({ data: FamilyMenuDataSchema });

/**
 * family_menu_planned_meals が返す jsonb の配列の 1 要素 (1 食)。関数は行の集合でなく配列 1 つを返す
 * (行の集合は PostgREST の max_rows (Supabase の既定 1,000 行) で黙って打ち切られるため。docs/design/family/10-family-menu-view.md §11.1)。
 * 鍵は関数の to_jsonb(r) の r の列と同じ 12 個 (画像の URL は持たない。tests/family-menu-view-migration-contract.test.ts の C-6 が突き合わせる)。
 * null になりうる鍵は planned_meals の DDL どおり nullable (groupFamilyMenuRows が DDL の DEFAULT で埋める)。
 * strict にしない: 知らない鍵は捨てて読む (応答には groupFamilyMenuRows が名指しした鍵しか入らない)
 */
export const FamilyMenuRpcRowSchema = z.object({
  member_id: z.string().uuid(),
  user_id: z.string().uuid(),
  day_date: FamilyMenuCalendarDateSchema,
  id: z.string().uuid(),
  /** 未知の区分は groupFamilyMenuRows が捨てる (ここでは落とさない) */
  meal_type: z.string(),
  dish_name: z.string(),
  /** 関数が ARRAY(…) で作るので null にならない (料理が無ければ空の配列) */
  dish_names: z.array(z.string()),
  is_simple: z.boolean().nullable(),
  calories_kcal: z.number().int().nullable(),
  cooking_time_minutes: z.number().int().nullable(),
  display_order: z.number().int().nullable(),
  is_completed: z.boolean().nullable(),
});

/** family_menu_planned_meals の返り値 (jsonb の配列)。route が safeParse し、合わなければ 500 (RPC_FAILED) */
export const FamilyMenuRpcRowsSchema = z.array(FamilyMenuRpcRowSchema);

export type FamilyMenuMeal = z.infer<typeof FamilyMenuMealSchema>;
export type FamilyMenuDay = z.infer<typeof FamilyMenuDaySchema>;
export type FamilyMenuMember = z.infer<typeof FamilyMenuMemberSchema>;
export type FamilyMenuData = z.infer<typeof FamilyMenuDataSchema>;
export type FamilyMenuRpcRow = z.infer<typeof FamilyMenuRpcRowSchema>;
