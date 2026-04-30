-- Issue #302: GET /api/favorites が HTTP 500 を返す修正
-- recipe_likes.recipe_uuid カラムが本番 DB に存在しない場合に 500 が発生するため、
-- IF NOT EXISTS で冪等的に追加して確実に存在を保証する。

ALTER TABLE recipe_likes
  ADD COLUMN IF NOT EXISTS recipe_uuid UUID REFERENCES recipes(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_recipe_likes_recipe_uuid ON recipe_likes (recipe_uuid);
