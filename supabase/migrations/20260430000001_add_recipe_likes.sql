-- recipe_likes: ユーザーがレシピにいいねできるテーブル
-- recipe_id は dish.name (テキスト) を使用

CREATE TABLE IF NOT EXISTS recipe_likes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipe_id   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, recipe_id)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_recipe_likes_user_id   ON recipe_likes (user_id);
CREATE INDEX IF NOT EXISTS idx_recipe_likes_recipe_id ON recipe_likes (recipe_id);

-- RLS
ALTER TABLE recipe_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own recipe likes"
  ON recipe_likes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own recipe likes"
  ON recipe_likes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own recipe likes"
  ON recipe_likes FOR DELETE
  USING (auth.uid() = user_id);
