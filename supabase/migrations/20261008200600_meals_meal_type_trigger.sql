-- migration: 20261008200600_meals_meal_type_trigger.sql
-- #1103 (T45): 夜食 (midnight_snack) を正式な食事区分として、meals.meal_type の値を「書き込む値だけ」検査するトリガーで守る
--
-- 決定 (オーナー判断 2026-10-08): 食事区分は 朝食 breakfast・昼食 lunch・夕食 dinner・おやつ snack・夜食 midnight_snack の 5 値とし、
--   DB の検査と AI 相談の許可リスト (src/lib/ai/consultation-action-executor.ts の AI_ALLOWED_MEAL_TYPES) を 5 値にそろえる。
--   この migration は DB の検査のうち meals の分。AI 相談の許可リストとプロンプトは同じ PR のアプリのコードで 5 値にしている。
--
-- 背景 (本番の現状: supabase/baseline/prod_schema.sql。2026-10-07 の本番スナップショット):
--   - planned_meals.meal_type: 20261008110000 (#1205) のトリガー trg_planned_meals_validate_values が、5 値だけを通す。
--     この migration では触らない (5 値は夜食を含む。tests/integration/rls/planned-meals-value-checks.test.ts が確認している)。
--   - meals.meal_type: NOT NULL の text だけで、値の制約もトリガーも無い。どんな文字列でも保存できる。
--   - #221 (20260430160000_db_audit_fixes.sql) は planned_meals と meals の両方に meal_type の CHECK を足すはずで、
--     台帳では適用済みだが、本番のスナップショットには両方とも存在しない (本番とのずれ)。
--     しかも #221 の定義は 4 値 (夜食 midnight_snack を含まない) で、そのまま足すと夜食が弾かれる。
--     UI (ホーム・週間献立・モバイルの食事登録)、献立生成の Edge Function (supabase/functions/_shared/meal-generator.ts の
--     ALLOWED_MEAL_TYPES)、packages/shared の MealType は、夜食も 1 つの食事区分として扱う。5 値で検査する。
--   - meals への書き込み経路: RPC paste_meal_to_family (家族へのペースト。コピー元の行の meal_type をそのまま写す) だけ。
--     Web (src)・モバイル (apps/mobile)・Edge Function (supabase/functions)・scripts のコードは、meals を読むだけで、書かない。
--     ただし PostgREST は、ログインした本人に meals の INSERT / UPDATE を許している (RLS: meals_insert_owner / meals_update_owner)。
--     アプリを通らない書き込みでは想定外の値が入りうるため、DB 側でも止める。
--
-- 変更: meals に BEFORE INSERT OR UPDATE OF の行トリガーを 1 本足す。
--   トリガー  trg_meals_validate_meal_type
--             BEFORE INSERT OR UPDATE OF meal_type  ON public.meals  FOR EACH ROW
--   関数      public.validate_meals_meal_type()  (SECURITY INVOKER・search_path 空・plpgsql。表は読まない)
--   検査する内容: meal_type が breakfast / lunch / dinner / snack / midnight_snack の 5 値のどれかであること。
--     NULL はここでは見ない (meal_type は NOT NULL 列なので、NOT NULL 制約 23502 が従来どおり止める)。
--     大文字小文字・前後の空白・日本語 (「夜食」など) は別の値として扱い、拒否する (planned_meals と同じ)。
--   何を検査するか:
--     INSERT  書こうとしている meal_type。
--     UPDATE  meal_type の値が変わるとき (NEW.meal_type IS DISTINCT FROM OLD.meal_type) だけ。
--             値が変わらない更新は検査しない (行全体を送り返すクライアントや、memo・photo_url・paste_group_id だけを変える更新を止めない)。
--   違反したときは SQLSTATE 23514 (check_violation) で失敗し、メッセージに列名 ('meals.meal_type は ...') と
--   許可する 5 値と指定された値 (50 文字まで) を入れる。CHECK 制約の違反と同じエラーコードなので、PostgREST では 400、
--   supabase-js では error.code = '23514' になる。
--
-- CHECK 制約 (NOT VALID → 後で VALIDATE CONSTRAINT) にしなかった理由:
--   NOT VALID は「すでにある行を検査しない」だけで、その後の INSERT / UPDATE では行全体が検査される。
--   本番の meals の中身は事前に確認できない。5 値以外の meal_type を持つ行がすでにあると、その行は
--   memo や photo_url だけを更新しても 23514 で拒否されるようになり、利用者の画面や家族へのペーストを壊しかねない。
--   VALIDATE CONSTRAINT も、5 値以外が 1 行でもあると失敗して、デプロイを止める。
--   トリガーなら、書き込む値だけを検査するため、既存の行の扱いは今までと変わらない (planned_meals の #1205 と同じ考え方)。
--     - 本番に 5 値以外の行がすでにあっても、その行の meal_type 以外の更新は今までどおり通る。
--     - 5 値以外を「ほかの 5 値以外」に変える更新は止まる。5 値のどれかに直す更新は通る。
--     - この migration は既存の行を読まない (全行の走査も、VALIDATE の後続 migration もいらない)。
--     - 本番で事前に SELECT を流して確かめなくても、この migration は安全に適用できる。
--   このため、既存データの修正 (UPDATE / DELETE) はこの migration に含めない。
--
-- 既存の正当な書き込みへの影響: なし (正常な値は、どの経路でも 5 値に収まる)。
--   - 5 値以外の meal_type を持つ行をコピー元にした家族へのペースト (paste_meal_to_family) だけは、新しい行を作る INSERT が
--     23514 で失敗するようになる (新しい行に 5 値以外を入れないための意図した変化)。コピー元の行そのものは何も変わらない。
--     本番にそうした行があるかは、下の「参考」の SELECT (読み取り専用) で確かめられる。この migration の適用には不要。
--   - pg_restore などで session_replication_role = replica にすると、通常のトリガーは動かない (CHECK 制約と違い、復元は止まらない)。
--   - 検査の負荷: 行ごとに 1 回の比較をするだけ (表は読まない)。
--
-- 参考 (読み取り専用。この migration の適用には不要): 本番に 5 値以外の meal_type が残っていないかの確認。
--   is_official が false の行が無ければ、2 つの表とも 5 値だけが入っている。
--     SELECT 'planned_meals' AS table_name, meal_type,
--            meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack') AS is_official,
--            count(*) AS row_count
--     FROM public.planned_meals GROUP BY meal_type
--     UNION ALL
--     SELECT 'meals', meal_type,
--            meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'),
--            count(*)
--     FROM public.meals GROUP BY meal_type
--     ORDER BY table_name, is_official, row_count DESC;
--   5 値以外が無いと確かめられたあとで、トリガーを CHECK 制約に置き換えるかどうかは、別の migration で決める
--   (トリガーのままでも、新しい書き込みは守られる)。
--
-- ロック: CREATE TRIGGER は meals の SHARE ROW EXCLUSIVE ロック (読み取りは通すが、書き込みを待たせる) を一瞬取る。
--   長いトランザクションが残っていると、後ろに続く書き込みまで待たせてしまうため、10 秒でロック待ちを諦める
--   (SET LOCAL は migration のトランザクション内だけ有効。取れなかった場合は migration が失敗するので、時間をおいて再実行する)。
--
-- 冪等: CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER のため、2 回続けて適用してもエラーにならない。
-- 権限: 関数に GRANT / REVOKE はしない。トリガー関数は /rest/v1/rpc から直接呼べず (戻り値が trigger の関数は PostgREST に公開されない)、
--   トリガーとして動くときは EXECUTE 権限を確認されない。SECURITY INVOKER で他の表も読まないので、権限の昇格も無い
--   (planned_meals の validate_planned_meal_values と同じ扱い)。
-- 確認: tests/integration/rls/meals-meal-type-trigger.test.ts。この migration の前は、5 値以外の書き込みが通るため失敗し、
--   この migration の後は全件成功する (5 値以外を持つ既存の行を、meal_type 以外の列で更新できることも確かめる)。
-- ロールバック: supabase/rollbacks/20261008200600_meals_meal_type_trigger.down.sql
-- マージ順: migration は version の順にマージすること (この version: 20261008200600)。

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION "public"."validate_meals_meal_type"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SECURITY INVOKER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_check_meal_type boolean;
BEGIN
  -- INSERT は書く値を検査する。UPDATE は meal_type の値が変わるときだけ検査する。
  -- OLD は INSERT では使えないため、TG_OP で分けてから参照する。
  IF TG_OP = 'UPDATE' THEN
    v_check_meal_type := NEW.meal_type IS DISTINCT FROM OLD.meal_type;
  ELSE
    v_check_meal_type := true;
  END IF;

  -- meal_type: 5 値。NULL はここでは見ない (NOT NULL 制約が従来どおり止める)。
  IF v_check_meal_type
     AND NEW.meal_type IS NOT NULL
     AND NEW.meal_type NOT IN ('breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack') THEN
    RAISE EXCEPTION 'meals.meal_type は breakfast / lunch / dinner / snack / midnight_snack のいずれかで指定してください (指定された値: %)',
      left(NEW.meal_type, 50)
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'meals', COLUMN = 'meal_type';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION "public"."validate_meals_meal_type"() IS
  '#1103: meals.meal_type が breakfast / lunch / dinner / snack / midnight_snack の 5 値であることを、書き込む値だけ検査するトリガー関数 (INSERT は常に、UPDATE は値が変わるときだけ)。違反は SQLSTATE 23514。5 値以外を持つ既存の行は meal_type 以外の列を更新できる。';

CREATE OR REPLACE TRIGGER "trg_meals_validate_meal_type"
  BEFORE INSERT OR UPDATE OF "meal_type"
  ON "public"."meals"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."validate_meals_meal_type"();

COMMENT ON TRIGGER "trg_meals_validate_meal_type" ON "public"."meals" IS
  '#1103: meal_type が 5 値 (夜食 midnight_snack を含む) であることを、書き込む値だけ検査する。planned_meals の trg_planned_meals_validate_values と同じ 5 値。';
