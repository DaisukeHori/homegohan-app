-- migration: 20261008110000_planned_meals_value_checks.sql
-- #1205: planned_meals の栄養素 4 列 (calories_kcal / protein_g / fat_g / carbs_g) と meal_type の値の範囲を、
--        「書き込む値だけ」を検査するトリガーで守る
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
--     そのまま足すと夜食が弾かれる。ここでは 5 値で検査する。
--   - 書き込み経路は Next.js の API だけではない。モバイルは Supabase クライアントで planned_meals へ直接 INSERT し
--     (apps/mobile/app/meals/new.tsx)、献立生成の Edge Function は service_role で書く (supabase/functions/_shared/save-meal.ts)。
--     アプリ層の確認 (src/lib/planned-meal-validation.ts) だけでは防げないため、DB 側でも止める。
--
-- 変更: planned_meals に BEFORE INSERT OR UPDATE OF の行トリガーを 1 本足す。
--   トリガー  trg_planned_meals_validate_values
--             BEFORE INSERT OR UPDATE OF meal_type, calories_kcal, protein_g, fat_g, carbs_g
--   関数      public.validate_planned_meal_values()  (SECURITY INVOKER・search_path 空・plpgsql。表は読まない)
--   検査する範囲 (NULL は従来どおり許す。meal_type は NOT NULL 列なので、NULL は NOT NULL 制約が従来どおり止める):
--     calories_kcal  0 〜 20000
--     protein_g      0 〜 2000
--     fat_g          0 〜 2000
--     carbs_g        0 〜 2000
--     meal_type      breakfast / lunch / dinner / snack / midnight_snack の 5 値
--   NaN は numeric の比較で「最大」として扱われ、'Infinity' は上限を超え、'-Infinity' は 0 未満になるため、
--   どれも範囲の確認で弾かれる (特別な式は要らない)。
--   上限はアプリ層 (calories 5000 / protein 500 / fat 300 / carbs 800) より緩くしてある。
--   Edge Function の生成結果や過去の正当な値を DB 側の確認で弾かないための余裕で、
--   負の値・NaN・桁外れの値といった壊れた値だけを止める。
--   何を検査するか:
--     INSERT  書こうとしている値 (上の 5 列) すべて。
--     UPDATE  値が変わる列だけ (NEW.列 IS DISTINCT FROM OLD.列)。値が変わらない列は検査しない。
--   違反したときは SQLSTATE 23514 (check_violation) で失敗し、メッセージに列名 ('planned_meals.calories_kcal は ...') と
--   指定された値を入れる。CHECK 制約の違反と同じエラーコードなので、PostgREST では 400、supabase-js では error.code = '23514' になる。
--   (モバイルの食事登録はこのメッセージをそのままアラートに出す。)
--
-- CHECK 制約ではなくトリガーにした理由:
--   最初の版 (main にはマージされていない) は、同じ範囲の CHECK 制約 5 本を NOT VALID で足していた。
--   NOT VALID は「すでにある行を検査しない」だけで、その後の INSERT / UPDATE では行全体が検査される。
--   本番のデータを事前に確認できない以上、すでに範囲外の値を持つ行があると、その行はどの列の更新でも
--   (「完食」の切り替えや、ほかの列の更新でも) 23514 で拒否されるようになり、利用者の画面を壊しかねない。
--   トリガーなら、書き込む値だけを検査するため、既存の行の扱いは今までと変わらない。
--     - 本番に範囲外の値の行がすでにあっても、その行の is_completed の切り替えなどは今までどおり通る。
--     - 範囲外の値を持つ列を「ほかの範囲外の値」に変える更新は止まる。範囲内の値に直す・NULL にする更新は通る。
--     - この migration は既存の行を読まない (全行の走査も、NOT VALID / VALIDATE CONSTRAINT もいらない)。
--     - 本番で事前に SELECT を流して確かめる必要はない。
--   このため、既存データの修正 (UPDATE / DELETE) はこの migration に含めない。
--
-- 既存の正当な書き込みへの影響: なし (正常な値は、どの経路でも上の範囲に収まる)。
--   - 献立生成 (Edge Function): 栄養素は 1 食あたりの合計で、食材ごとの量に上限があり (nutrition-pipeline.ts の getIngredientAmountCap)、
--     calories_kcal は整数に四捨五入して書く。meal_type は 5 値だけ (supabase/functions/_shared/meal-generator.ts の ALLOWED_MEAL_TYPES)。
--   - Web / モバイルの食事登録・編集 (API 経由): meal_type は packages/shared の MealType (5 値)。栄養素は API の確認 (0 〜 5000 など) を通った値。
--   - モバイルの直接 INSERT (meals/new.tsx): 入力欄の値や写真解析の合計をそのまま書く。負の値や 20000 kcal を超える値は、
--     これまで黙って保存されていたが、この migration 以降は保存に失敗する (意図した変化)。
--   - 検査の負荷: 行ごとに数回の比較をするだけ (表は読まない)。
--   - pg_restore などで session_replication_role = replica にすると、通常のトリガーは動かない (CHECK 制約と違い、復元は止まらない)。
--
-- ロック: CREATE TRIGGER は planned_meals の SHARE ROW EXCLUSIVE ロック (読み取りは通すが、書き込みを待たせる) を一瞬取る。
--   長いトランザクションが残っていると、後ろに続く書き込みまで待たせてしまうため、10 秒でロック待ちを諦める
--   (SET LOCAL は migration のトランザクション内だけ有効。取れなかった場合は migration が失敗するので、時間をおいて再実行する)。
--
-- 冪等: CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER のため、2 回続けて適用してもエラーにならない。
-- 権限: 関数に GRANT / REVOKE はしない (トリガー関数は直接呼び出せない)。
-- 確認: tests/integration/rls/planned-meals-value-checks.test.ts。この migration の前は、範囲外の書き込みが通るため失敗し、
--   この migration の後は全件成功する (範囲外の値を持つ既存の行を、無関係な列で更新できることも確かめる)。
-- ロールバック: supabase/rollbacks/20261008110000_planned_meals_value_checks.down.sql
--   (最初の版の CHECK 制約をローカルで当てた DB が残っていた場合は、それも外す)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION "public"."validate_planned_meal_values"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SECURITY INVOKER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_check_meal_type     boolean;
  v_check_calories_kcal boolean;
  v_check_protein_g     boolean;
  v_check_fat_g         boolean;
  v_check_carbs_g       boolean;
BEGIN
  -- どの列を検査するか。INSERT は書く値すべて、UPDATE は値が変わる列だけ。
  -- OLD は INSERT では使えないため、TG_OP で分けてから参照する。
  IF TG_OP = 'UPDATE' THEN
    v_check_meal_type     := NEW.meal_type     IS DISTINCT FROM OLD.meal_type;
    v_check_calories_kcal := NEW.calories_kcal IS DISTINCT FROM OLD.calories_kcal;
    v_check_protein_g     := NEW.protein_g     IS DISTINCT FROM OLD.protein_g;
    v_check_fat_g         := NEW.fat_g         IS DISTINCT FROM OLD.fat_g;
    v_check_carbs_g       := NEW.carbs_g       IS DISTINCT FROM OLD.carbs_g;
  ELSE
    v_check_meal_type     := true;
    v_check_calories_kcal := true;
    v_check_protein_g     := true;
    v_check_fat_g         := true;
    v_check_carbs_g       := true;
  END IF;

  -- meal_type: 5 値。NULL はここでは見ない (NOT NULL 制約が従来どおり止める)。
  IF v_check_meal_type
     AND NEW.meal_type IS NOT NULL
     AND NEW.meal_type NOT IN ('breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack') THEN
    RAISE EXCEPTION 'planned_meals.meal_type は breakfast / lunch / dinner / snack / midnight_snack のいずれかで指定してください (指定された値: %)',
      left(NEW.meal_type, 50)
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'planned_meals', COLUMN = 'meal_type';
  END IF;

  -- calories_kcal (integer): 0 〜 20000。NULL は未入力として許す。
  IF v_check_calories_kcal
     AND NEW.calories_kcal IS NOT NULL
     AND NOT (NEW.calories_kcal >= 0 AND NEW.calories_kcal <= 20000) THEN
    RAISE EXCEPTION 'planned_meals.calories_kcal は 0 以上 20000 以下で指定してください (指定された値: %)',
      NEW.calories_kcal
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'planned_meals', COLUMN = 'calories_kcal';
  END IF;

  -- protein_g (numeric): 0 〜 2000。NaN / Infinity / -Infinity も範囲外として弾かれる。
  IF v_check_protein_g
     AND NEW.protein_g IS NOT NULL
     AND NOT (NEW.protein_g >= 0 AND NEW.protein_g <= 2000) THEN
    RAISE EXCEPTION 'planned_meals.protein_g は 0 以上 2000 以下で指定してください (指定された値: %)',
      left(NEW.protein_g::text, 40)
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'planned_meals', COLUMN = 'protein_g';
  END IF;

  -- fat_g (numeric): 0 〜 2000
  IF v_check_fat_g
     AND NEW.fat_g IS NOT NULL
     AND NOT (NEW.fat_g >= 0 AND NEW.fat_g <= 2000) THEN
    RAISE EXCEPTION 'planned_meals.fat_g は 0 以上 2000 以下で指定してください (指定された値: %)',
      left(NEW.fat_g::text, 40)
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'planned_meals', COLUMN = 'fat_g';
  END IF;

  -- carbs_g (numeric): 0 〜 2000
  IF v_check_carbs_g
     AND NEW.carbs_g IS NOT NULL
     AND NOT (NEW.carbs_g >= 0 AND NEW.carbs_g <= 2000) THEN
    RAISE EXCEPTION 'planned_meals.carbs_g は 0 以上 2000 以下で指定してください (指定された値: %)',
      left(NEW.carbs_g::text, 40)
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'planned_meals', COLUMN = 'carbs_g';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."validate_planned_meal_values"() IS
  '#1205: planned_meals の meal_type と栄養素 4 列の範囲を、書き込む値だけ検査するトリガー関数 (INSERT は全部、UPDATE は値が変わる列だけ)。違反は SQLSTATE 23514。既存の範囲外の行は他の列を更新できる。';

CREATE OR REPLACE TRIGGER "trg_planned_meals_validate_values"
  BEFORE INSERT OR UPDATE OF "meal_type", "calories_kcal", "protein_g", "fat_g", "carbs_g"
  ON "public"."planned_meals"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."validate_planned_meal_values"();

COMMENT ON TRIGGER "trg_planned_meals_validate_values" ON "public"."planned_meals" IS
  '#1205: meal_type と栄養素 4 列 (calories_kcal / protein_g / fat_g / carbs_g) の範囲を、書き込む値だけ検査する。';
