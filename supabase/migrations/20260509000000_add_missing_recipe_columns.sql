-- Issue #recipes-500: /api/recipes が 500 を返す問題を修正
-- 原因: recipes テーブルに category/cuisine_type/difficulty/tags/nutrition/tips/video_url/source_url/view_count
--       カラムが存在せず、API クエリが 500 エラーになる。
-- 対策: 各カラムを IF NOT EXISTS で安全に追加する。

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS category         TEXT         NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS cuisine_type     TEXT         NOT NULL DEFAULT 'japanese',
  ADD COLUMN IF NOT EXISTS difficulty       TEXT         NOT NULL DEFAULT 'easy',
  ADD COLUMN IF NOT EXISTS tags             TEXT[]       NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS nutrition        JSONB,
  ADD COLUMN IF NOT EXISTS tips             TEXT,
  ADD COLUMN IF NOT EXISTS video_url        TEXT,
  ADD COLUMN IF NOT EXISTS source_url       TEXT,
  ADD COLUMN IF NOT EXISTS view_count       INTEGER      NOT NULL DEFAULT 0;

-- インデックス（検索・フィルタ用）
CREATE INDEX IF NOT EXISTS idx_recipes_category     ON recipes (category);
CREATE INDEX IF NOT EXISTS idx_recipes_cuisine_type ON recipes (cuisine_type);
CREATE INDEX IF NOT EXISTS idx_recipes_difficulty   ON recipes (difficulty);
