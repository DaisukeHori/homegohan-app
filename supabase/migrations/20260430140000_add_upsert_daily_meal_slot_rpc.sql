-- Migration: upsert_daily_meal_slot RPC
-- Atomically upsert user_daily_meals + planned_meals in one transaction.
-- Resolves #193: save-meal 非アトミック 2 ステップ書き込み

CREATE OR REPLACE FUNCTION public.upsert_daily_meal_slot(
  p_user_id        UUID,
  p_day_date       DATE,
  p_meal_type      TEXT,
  p_planned_data   JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_daily_meal_id  UUID;
  v_planned_meal_id UUID;
  v_existing_id    UUID;
BEGIN
  -- 1. user_daily_meals を upsert
  INSERT INTO user_daily_meals (user_id, day_date, updated_at)
  VALUES (p_user_id, p_day_date, NOW())
  ON CONFLICT (user_id, day_date)
  DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_daily_meal_id;

  -- 2. 既存 planned_meal を確認
  SELECT id INTO v_existing_id
  FROM planned_meals
  WHERE daily_meal_id = v_daily_meal_id
    AND meal_type = p_meal_type
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- 既存レコードを更新
    UPDATE planned_meals
    SET
      dish_name        = p_planned_data->>'dish_name',
      ingredients      = (p_planned_data->'ingredients'),
      recipe_steps     = (p_planned_data->'recipe_steps'),
      dishes           = (p_planned_data->'dishes'),
      mode             = COALESCE(p_planned_data->>'mode', 'ai_creative'),
      is_simple        = COALESCE((p_planned_data->>'is_simple')::BOOLEAN, FALSE),
      display_order    = COALESCE((p_planned_data->>'display_order')::INT, 0),
      is_generating    = FALSE,
      calories_kcal    = (p_planned_data->>'calories_kcal')::NUMERIC,
      protein_g        = (p_planned_data->>'protein_g')::NUMERIC,
      fat_g            = (p_planned_data->>'fat_g')::NUMERIC,
      carbs_g          = (p_planned_data->>'carbs_g')::NUMERIC,
      sodium_g         = (p_planned_data->>'sodium_g')::NUMERIC,
      fiber_g          = (p_planned_data->>'fiber_g')::NUMERIC,
      image_url        = p_planned_data->>'image_url',
      updated_at       = NOW()
    WHERE id = v_existing_id
    RETURNING id INTO v_planned_meal_id;
  ELSE
    -- 新規挿入
    INSERT INTO planned_meals (
      daily_meal_id, meal_type, dish_name, ingredients, recipe_steps, dishes,
      mode, is_simple, display_order, is_generating, is_completed,
      calories_kcal, protein_g, fat_g, carbs_g, sodium_g, fiber_g,
      image_url, updated_at
    ) VALUES (
      v_daily_meal_id,
      p_meal_type,
      p_planned_data->>'dish_name',
      (p_planned_data->'ingredients'),
      (p_planned_data->'recipe_steps'),
      (p_planned_data->'dishes'),
      COALESCE(p_planned_data->>'mode', 'ai_creative'),
      COALESCE((p_planned_data->>'is_simple')::BOOLEAN, FALSE),
      COALESCE((p_planned_data->>'display_order')::INT, 0),
      FALSE,
      FALSE,
      (p_planned_data->>'calories_kcal')::NUMERIC,
      (p_planned_data->>'protein_g')::NUMERIC,
      (p_planned_data->>'fat_g')::NUMERIC,
      (p_planned_data->>'carbs_g')::NUMERIC,
      (p_planned_data->>'sodium_g')::NUMERIC,
      (p_planned_data->>'fiber_g')::NUMERIC,
      p_planned_data->>'image_url',
      NOW()
    )
    RETURNING id INTO v_planned_meal_id;
  END IF;

  RETURN jsonb_build_object(
    'daily_meal_id',  v_daily_meal_id,
    'planned_meal_id', v_planned_meal_id,
    'outcome',        CASE WHEN v_existing_id IS NOT NULL THEN 'updated' ELSE 'inserted' END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_daily_meal_slot(UUID, DATE, TEXT, JSONB) TO service_role;
