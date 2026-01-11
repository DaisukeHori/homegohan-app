-- ============================================================
-- dataset_recipes RLS ポリシー修正：anonロールを追加
-- ============================================================

-- 既存のポリシーを削除
DROP POLICY IF EXISTS "dataset_recipes_select_all" ON dataset_recipes;

-- SELECT ポリシー: 全ユーザーは読み取り可能（公開データ）
CREATE POLICY "dataset_recipes_select_all"
  ON dataset_recipes
  FOR SELECT
  TO authenticated, anon
  USING (true);
