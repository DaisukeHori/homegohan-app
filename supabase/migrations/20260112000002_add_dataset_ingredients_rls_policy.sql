-- dataset_ingredients テーブルにRLSポリシーを追加
-- 全ユーザー（認証済み・匿名）が読み取り可能にする

-- search_pathを設定
SET search_path TO public, extensions;

-- 認証済みユーザー用ポリシー
CREATE POLICY "Allow authenticated users to read dataset_ingredients"
  ON dataset_ingredients FOR SELECT
  TO authenticated
  USING (true);

-- 匿名ユーザー用ポリシー（service_roleからの呼び出し用）
CREATE POLICY "Allow anon users to read dataset_ingredients"
  ON dataset_ingredients FOR SELECT
  TO anon
  USING (true);
