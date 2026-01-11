-- ============================================================
-- dataset_recipes テーブルの RLS ポリシー追加
-- 公開レシピデータは全ユーザーが読み取り可能
-- ============================================================

-- 既存のポリシーがあれば削除
DROP POLICY IF EXISTS "dataset_recipes_select_all" ON dataset_recipes;

-- SELECT ポリシー: 全ユーザーは読み取り可能（公開データ）
CREATE POLICY "dataset_recipes_select_all"
  ON dataset_recipes
  FOR SELECT
  TO authenticated, anon
  USING (true);

-- コメント追加
COMMENT ON POLICY "dataset_recipes_select_all" ON dataset_recipes IS
  '全ユーザーがレシピデータセットを読み取り可能（公開データ）';
