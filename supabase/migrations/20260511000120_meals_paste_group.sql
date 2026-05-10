-- migration: 20260511000120_meals_paste_group.sql
-- (設計書 01-data-model.md §4 + §4.1)
-- 番号: 設計書指定 000020 → 000120 にシフト

ALTER TABLE meals
  ADD COLUMN IF NOT EXISTS paste_group_id UUID;

-- 同一ペーストグループの全レコードに対して bulk update 可能にする index
CREATE INDEX IF NOT EXISTS idx_meals_paste_group ON meals(paste_group_id) WHERE paste_group_id IS NOT NULL;

-- meals の閲覧 RLS — 自分 + 家族 (share_meals=TRUE のメンバ) の meals を見る
CREATE OR REPLACE FUNCTION public.can_view_user_meals(p_target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT
    auth.uid() = p_target_user_id
    OR EXISTS (
      SELECT 1 FROM family_members vm
      JOIN family_members tm ON vm.family_id = tm.family_id
      WHERE vm.user_id = auth.uid() AND vm.status = 'active'
        AND tm.user_id = p_target_user_id AND tm.status = 'active'
        AND tm.share_meals = TRUE
    );
$$;

REVOKE EXECUTE ON FUNCTION public.can_view_user_meals FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_view_user_meals TO authenticated;

-- meals RLS の SELECT policy を上記関数で置換
DROP POLICY IF EXISTS meals_select_owner ON meals;
DROP POLICY IF EXISTS meals_select_family ON meals;
CREATE POLICY meals_select_owner_or_family ON meals
  FOR SELECT USING (public.can_view_user_meals(meals.user_id));

-- INSERT/UPDATE/DELETE は本人 (またはペースト関数経由) のみ
DROP POLICY IF EXISTS meals_modify_owner ON meals;
CREATE POLICY meals_insert_owner ON meals
  FOR INSERT WITH CHECK (meals.user_id = auth.uid());
CREATE POLICY meals_update_owner ON meals
  FOR UPDATE USING (meals.user_id = auth.uid());
CREATE POLICY meals_delete_owner ON meals
  FOR DELETE USING (meals.user_id = auth.uid());

-- ペースト RPC
CREATE OR REPLACE FUNCTION public.paste_meal_to_family(
  p_source_meal_id UUID,
  p_target_user_ids UUID[]
) RETURNS UUID  -- paste_group_id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_source meals;
  v_paste_group_id UUID;
  v_target UUID;
  v_caller_family_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_source FROM meals WHERE id = p_source_meal_id;
  IF v_source.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'NOT_MEAL_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT family_id INTO v_caller_family_id FROM user_profiles WHERE id = auth.uid();
  IF v_caller_family_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  v_paste_group_id := COALESCE(v_source.paste_group_id, gen_random_uuid());

  -- source 自身を group に紐付け (まだなら)
  IF v_source.paste_group_id IS NULL THEN
    UPDATE meals SET paste_group_id = v_paste_group_id WHERE id = p_source_meal_id;
  END IF;

  FOREACH v_target IN ARRAY p_target_user_ids LOOP
    -- target が同 family のメンバか検証
    IF NOT EXISTS (
      SELECT 1 FROM family_members
      WHERE family_id = v_caller_family_id AND user_id = v_target AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
    END IF;

    -- meals テーブル実カラム: id, user_id, eaten_at, meal_type, photo_url, memo, created_at, updated_at, paste_group_id
    -- 設計書の「全カラム」コピーを実スキーマに合わせて実装
    INSERT INTO meals (
      user_id, paste_group_id, eaten_at, meal_type, photo_url, memo
    )
    SELECT
      v_target, v_paste_group_id, eaten_at, meal_type, photo_url, memo
    FROM meals WHERE id = p_source_meal_id;
  END LOOP;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', v_caller_family_id, 'paste_executed', auth.uid(),
          jsonb_build_object('source_meal_id', p_source_meal_id,
                             'paste_group_id', v_paste_group_id,
                             'target_count', array_length(p_target_user_ids, 1)));

  RETURN v_paste_group_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.paste_meal_to_family FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paste_meal_to_family TO authenticated;
