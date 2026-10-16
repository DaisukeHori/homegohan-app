-- migration: 20261016241000_family_menu_view_functions.sql
-- Issue #1584 の 1: 週間献立の「家族の表示」で、家族のメンバーの献立を読み取り専用で見る。
--
-- 背景: user_daily_meals / planned_meals の RLS は本人の行だけ (ALL 1 本ずつ)。家族の献立を読む経路が無く、
--   family_members.share_menu (設定画面の「週間献立を家族に見せる」) を読む RLS・関数・API も無かった。
-- 変更 (関数 2 本の新設だけ。表・列・ポリシー・既存の行は変えない):
--   1. family_menu_visible_members(): ログイン中の利用者が献立を見てよい家族のメンバー (member_id, user_id)。判定はここ 1 か所:
--        同じ家族 / 家族が active / 自分も相手も status = 'active' / 相手にアカウントがある (user_id IS NOT NULL) /
--        相手の share_menu = TRUE / 自分以外。
--   2. family_menu_planned_meals(p_start_date, p_end_date): 1 のメンバーの献立を、画面に要る鍵だけの jsonb の配列 1 つで返す
--        (1 要素 = 1 食。行の集合で返すと PostgREST の max_rows (Supabase の既定 1,000 行) で黙って打ち切られ、
--        31 日の範囲で家族の献立が欠ける (1 日の食事の数に上限は無い)。#1498 の llm_usage_summary と同じく 1 つの値で返す。
--        メモ・生成のメタデータ・栄養の詳細は返さない。料理は dishes から名前だけを取り出した dish_names で返し、
--        料理ごとの栄養・材料・作り方・画像の URL と生成の情報は返さない)。砂場 (user_daily_meals.is_sandbox = TRUE) は除く。
--        画像の URL (planned_meals.image_url) は返さない (要素に鍵が無い。他のメンバーの写真の URL を配らない。
--        署名の API は本人の写真にだけ署名する #1365 の決まりを広げない)。
--        範囲は含む日数で FAMILY_MENU_RANGE_MAX_DAYS (= 31。src/lib/membership/family-menu.ts と同じ値) まで。
--   RLS を広げない理由: user_daily_meals / planned_meals を利用者のクライアントで読むファイルは 29 本あり、
--   多くが user_id の絞りを RLS に頼っている (家族の SELECT ポリシーを足すと、それらに家族の行が混ざる)。
-- 実行権限: PUBLIC / anon / authenticated / service_role から外し、authenticated と service_role にだけ GRANT
--   (#1103 の規律。tests/integration/security/anon-definer-execute.test.ts の決定表に 2 行足す)。
-- 冪等: CREATE OR REPLACE と REVOKE / GRANT は、2 回続けて適用しても同じ結果になる。
-- 既存データへの影響: なし。
-- 戻し方: supabase/rollbacks/20261016241000_family_menu_view_functions.down.sql
-- 確かめるテスト: tests/family-menu-view-migration-contract.test.ts (ファイルの突き合わせ)・
--   tests/integration/rls/family-menu-visibility.test.ts (実 DB)

CREATE OR REPLACE FUNCTION public.family_menu_visible_members()
RETURNS TABLE (member_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT tm.id, tm.user_id
  FROM public.family_members vm
  JOIN public.family_groups fg ON fg.id = vm.family_id AND fg.status = 'active'
  JOIN public.family_members tm ON tm.family_id = vm.family_id
  WHERE vm.user_id = auth.uid()
    AND vm.status = 'active'
    AND tm.status = 'active'
    AND tm.user_id IS NOT NULL
    AND tm.user_id <> auth.uid()
    AND tm.share_menu = TRUE
  ORDER BY tm.joined_at, tm.id;
$$;

COMMENT ON FUNCTION public.family_menu_visible_members() IS
  '#1584: ログイン中の利用者が献立を見てよい家族のメンバー (自分以外・同じ active な家族・相手が active でアカウントを持ち share_menu = TRUE)。family_menu_planned_meals と GET /api/family/menu が使う';

CREATE OR REPLACE FUNCTION public.family_menu_planned_meals(p_start_date date, p_end_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  -- 含む日数の上限 = FAMILY_MENU_RANGE_MAX_DAYS (31)。tests/family-menu-view-migration-contract.test.ts が TS の定数と突き合わせる
  IF p_start_date IS NULL OR p_end_date IS NULL
     OR p_end_date < p_start_date
     OR (p_end_date - p_start_date) + 1 > 31 THEN
    RAISE EXCEPTION 'FAMILY_MENU_RANGE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  -- 行の集合でなく jsonb の配列 1 つで返す (行の集合は PostgREST の max_rows で黙って打ち切られる)。
  -- 要素の鍵は下の r の列 (12 個。画像の URL (image_url) は持たない)。tests/family-menu-view-migration-contract.test.ts (C-6) が FamilyMenuRpcRowSchema の鍵と突き合わせる
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.member_id, r.day_date, r.meal_type, r.display_order, r.id)
    FROM (
      SELECT m.member_id, m.user_id, d.day_date,
             pm.id, pm.meal_type, pm.dish_name,
             -- 料理は名前だけ。配列 (順を保つ) と、古い形のキーつきのオブジェクトの値の両方から、文字列で空でない name を取り出す
             ARRAY(
               SELECT e.elem ->> 'name'
               FROM (
                 SELECT a.elem, a.ord
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(pm.dishes) = 'array' THEN pm.dishes ELSE '[]'::jsonb END)
                      WITH ORDINALITY AS a(elem, ord)
                 UNION ALL
                 SELECT o.elem, o.ord
                 FROM jsonb_each(CASE WHEN jsonb_typeof(pm.dishes) = 'object' THEN pm.dishes ELSE '{}'::jsonb END)
                      WITH ORDINALITY AS o(dish_key, elem, ord)
               ) AS e
               WHERE jsonb_typeof(e.elem) = 'object'
                 AND jsonb_typeof(e.elem -> 'name') = 'string'
                 AND e.elem ->> 'name' <> ''
               ORDER BY e.ord
             ) AS dish_names,
             pm.is_simple, pm.calories_kcal, pm.cooking_time_minutes, pm.display_order, pm.is_completed
      FROM public.family_menu_visible_members() AS m
      JOIN public.user_daily_meals AS d
        ON d.user_id = m.user_id
       AND d.day_date BETWEEN p_start_date AND p_end_date
       AND d.is_sandbox = FALSE
      JOIN public.planned_meals AS pm ON pm.daily_meal_id = d.id
    ) AS r
  ), '[]'::jsonb);
END $$;

COMMENT ON FUNCTION public.family_menu_planned_meals(date, date) IS
  '#1584: family_menu_visible_members() のメンバーの献立を jsonb の配列 1 つで返す (行の集合は PostgREST の max_rows で打ち切られるため。要素は画面に要る鍵だけ・料理は名前だけ・画像の URL は返さない・砂場を除く・含む日数 31 日まで・献立が無ければ空の配列)。GET /api/family/menu が使う';

REVOKE ALL ON FUNCTION public.family_menu_visible_members()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.family_menu_visible_members()
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.family_menu_planned_meals(date, date)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.family_menu_planned_meals(date, date)
  TO authenticated, service_role;
