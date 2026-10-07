-- migration: 20261007160500_planned_meals_value_checks.sql
-- #1205: planned_meals の栄養素 4 列 (calories_kcal / protein_g / fat_g / carbs_g) と meal_type に CHECK 制約を付ける (NOT VALID)
--
-- 背景 (本番の現状: supabase/baseline/prod_schema.sql の planned_meals。2026-10-06 の本番スナップショット):
--   - 栄養素の 4 列は型だけで範囲の制約が無い (calories_kcal は integer、protein_g / fat_g / carbs_g は numeric)。
--     負の値や桁外れの値がそのまま保存でき、numeric 型は 'NaN' / 'Infinity' も値として受け付ける
--     (PostgREST に文字列 "NaN" を送ると入る。tests/integration/rls/planned-meals-value-checks.test.ts で確認)。
--     摂取カロリーの合計・ホーム画面・エクスポート・組織統計が、こうした値で静かに狂う。
--   - meal_type は NOT NULL の text だけで、値の制約が無い。
--     #221 (20260430160000_db_audit_fixes.sql) の planned_meals_meal_type_check は台帳では適用済みだが、
--     本番のスナップショットには存在しない (本番とのずれ)。さらに #221 の定義は 4 値 (夜食 midnight_snack を含まない) で、
--     UI (home・週間献立・モバイルの食事登録) と献立生成の Edge Function は midnight_snack も書くため、
--     そのまま足すと夜食が弾かれる。ここでは 5 値で作る。
--   - 書き込み経路は Next.js の API だけではない。モバイルは Supabase クライアントで planned_meals へ直接 INSERT し
--     (apps/mobile/app/meals/new.tsx)、献立生成の Edge Function は service_role で書く (supabase/functions/_shared/save-meal.ts)。
--     アプリ層の確認 (src/lib/planned-meal-validation.ts) だけでは防げないため、DB 側でも止める。
--
-- 変更: planned_meals に次の CHECK 制約を NOT VALID で追加する。NULL は従来どおり許す (未入力の栄養素)。
--   planned_meals_calories_kcal_range  calories_kcal を 0 〜 20000
--   planned_meals_protein_g_range      protein_g を 0 〜 2000
--   planned_meals_fat_g_range          fat_g を 0 〜 2000
--   planned_meals_carbs_g_range        carbs_g を 0 〜 2000
--   planned_meals_meal_type_check      meal_type を breakfast / lunch / dinner / snack / midnight_snack の 5 値
--   NaN は numeric の比較で「最大」として扱われ、'Infinity' は上限を超え、'-Infinity' は 0 未満になるため、
--   どれも範囲の確認で弾かれる (特別な式は要らない)。
--   上限はアプリ層 (calories 5000 / protein 500 / fat 300 / carbs 800) より緩くしてある。
--   Edge Function の生成結果や過去の正当な値を DB 側の確認で弾かないための余裕で、
--   負の値・NaN・桁外れの値といった壊れた値だけを止める。
--
-- NOT VALID にする理由と影響:
--   本番の既存行がこの制約を満たすことをここでは証明できないため、NOT VALID で追加する。
--   - 全行の走査はしない (ロックは一瞬で終わる)。既存の行は検査されない。
--   - 新しく書く行 (INSERT) と、更新する行 (UPDATE) が検査の対象になる。
--     UPDATE は更新後の行全体が検査されるため、すでに範囲外の値を持つ行は、
--     どの列を更新しても (is_completed の切り替えなどでも) 拒否される。
--     そのため、マージ前に PR 本文の確認用 SQL (読み取り専用) で、該当する行が 0 件であることを確認する。
--   - VALIDATE CONSTRAINT は行わない。データを確認した後の別の migration で行う。
--
-- 既存の正当な書き込みへの影響: なし (正常な値は、どの経路でも上の範囲に収まる)。
--   - 献立生成 (Edge Function): 栄養素は 1 食あたりの合計で、食材ごとの量に上限があり (nutrition-pipeline.ts の getIngredientAmountCap)、
--     calories_kcal は整数に四捨五入して書く。meal_type は 5 値だけ (supabase/functions/_shared/meal-generator.ts の ALLOWED_MEAL_TYPES)。
--   - Web / モバイルの食事登録・編集 (API 経由): meal_type は packages/shared の MealType (5 値)。栄養素は API の確認 (0 〜 5000 など) を通った値。
--   - モバイルの直接 INSERT (meals/new.tsx): 入力欄の値や写真解析の合計をそのまま書く。負の値や 20000 kcal を超える値は、
--     これまで黙って保存されていたが、この migration 以降は保存に失敗する (意図した変化)。
--
-- ロック: ALTER TABLE ... ADD CONSTRAINT は planned_meals の ACCESS EXCLUSIVE ロックが要る。
--   長いトランザクションが残っていると、後ろに続く読み書きまで待たせてしまうため、10 秒でロック待ちを諦める
--   (SET LOCAL は migration のトランザクション内だけ有効。取れなかった場合は migration が失敗するので、時間をおいて再実行する)。
--
-- 冪等: DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/planned-meals-value-checks.test.ts。修正前は拒否されるはずの書き込みが通るため失敗し、この migration の後は全件成功する。
-- ロールバック: supabase/rollbacks/20261007160500_planned_meals_value_checks.down.sql

SET LOCAL lock_timeout = '10s';

-- calories_kcal (integer): 0 〜 20000
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_calories_kcal_range";
ALTER TABLE "public"."planned_meals"
  ADD CONSTRAINT "planned_meals_calories_kcal_range"
  CHECK (("calories_kcal" IS NULL) OR (("calories_kcal" >= 0) AND ("calories_kcal" <= 20000)))
  NOT VALID;

-- protein_g (numeric): 0 〜 2000
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_protein_g_range";
ALTER TABLE "public"."planned_meals"
  ADD CONSTRAINT "planned_meals_protein_g_range"
  CHECK (("protein_g" IS NULL) OR (("protein_g" >= 0) AND ("protein_g" <= 2000)))
  NOT VALID;

-- fat_g (numeric): 0 〜 2000
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_fat_g_range";
ALTER TABLE "public"."planned_meals"
  ADD CONSTRAINT "planned_meals_fat_g_range"
  CHECK (("fat_g" IS NULL) OR (("fat_g" >= 0) AND ("fat_g" <= 2000)))
  NOT VALID;

-- carbs_g (numeric): 0 〜 2000
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_carbs_g_range";
ALTER TABLE "public"."planned_meals"
  ADD CONSTRAINT "planned_meals_carbs_g_range"
  CHECK (("carbs_g" IS NULL) OR (("carbs_g" >= 0) AND ("carbs_g" <= 2000)))
  NOT VALID;

-- meal_type (text, NOT NULL): 5 値。#221 の planned_meals_meal_type_check (4 値) と同じ名前で、夜食を含む 5 値で作る。
ALTER TABLE "public"."planned_meals" DROP CONSTRAINT IF EXISTS "planned_meals_meal_type_check";
ALTER TABLE "public"."planned_meals"
  ADD CONSTRAINT "planned_meals_meal_type_check"
  CHECK ("meal_type" IN ('breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'))
  NOT VALID;
