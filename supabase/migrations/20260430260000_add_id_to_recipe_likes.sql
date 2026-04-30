-- Issue #302: GET /api/favorites が HTTP 500 を返す修正 (根本原因)
-- 本番 DB の recipe_likes テーブルには id カラムが存在しない。
-- CREATE TABLE IF NOT EXISTS によるスキップで既存テーブルにカラムが追加されなかった。
-- gen_random_uuid() で id を追加し、PRIMARY KEY に昇格させる。

-- 1. id カラムを追加 (既存の行には uuid を自動生成)
ALTER TABLE recipe_likes
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- 2. 既存行の id が NULL の場合に uuid を埋める
UPDATE recipe_likes SET id = gen_random_uuid() WHERE id IS NULL;

-- 3. NOT NULL 制約を追加
ALTER TABLE recipe_likes ALTER COLUMN id SET NOT NULL;

-- 4. PRIMARY KEY として設定 (重複防止)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'recipe_likes' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE recipe_likes ADD PRIMARY KEY (id);
  END IF;
END $$;
