-- #257: view_count 非アトミック更新 race 修正
-- SELECT + UPDATE の 2 ステップを単一 RPC に集約して race condition を排除する

CREATE OR REPLACE FUNCTION increment_recipe_view_count(recipe_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE recipes
  SET view_count = COALESCE(view_count, 0) + 1
  WHERE id = recipe_id;
$$;
