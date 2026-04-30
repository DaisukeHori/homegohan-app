-- Phase 1: recipe_likes スキーマ拡張 + like_count atomic 更新
-- Issues: #112 (recipe_id TEXT → UUID 参照整合性), #117 (like_count race condition)

-- 1. recipes テーブルに like_count 列を追加（まだなければ）
ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0;

-- 2. recipe_likes に recipe_uuid 列を追加（recipes.id への外部キー）
--    既存 recipe_id (TEXT) は legacy として残す。新規挿入は recipe_uuid 必須。
ALTER TABLE recipe_likes
  ADD COLUMN IF NOT EXISTS recipe_uuid UUID REFERENCES recipes(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_recipe_likes_recipe_uuid ON recipe_likes (recipe_uuid);

-- 3. like_count を atomic に更新する RPC
--    引数: p_recipe_uuid が指定された場合は UUID で、なければ TEXT の recipe_id で集計
CREATE OR REPLACE FUNCTION increment_recipe_like_count(p_recipe_id TEXT DEFAULT NULL, p_recipe_uuid UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_recipe_uuid IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_uuid = p_recipe_uuid;
    UPDATE recipes SET like_count = v_count WHERE id = p_recipe_uuid;
  ELSIF p_recipe_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_id = p_recipe_id;
  ELSE
    RAISE EXCEPTION 'Either p_recipe_id or p_recipe_uuid must be provided';
  END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_recipe_like_count(p_recipe_id TEXT DEFAULT NULL, p_recipe_uuid UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_recipe_uuid IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_uuid = p_recipe_uuid;
    UPDATE recipes SET like_count = v_count WHERE id = p_recipe_uuid;
  ELSIF p_recipe_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM recipe_likes WHERE recipe_id = p_recipe_id;
  ELSE
    RAISE EXCEPTION 'Either p_recipe_id or p_recipe_uuid must be provided';
  END IF;
  RETURN v_count;
END;
$$;

-- 4. recipe_likes にトリガーを設定して like_count を自動同期
--    recipe_uuid が設定されている行のみ recipes.like_count を更新
CREATE OR REPLACE FUNCTION sync_recipe_like_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_recipe_uuid UUID;
  v_count INTEGER;
BEGIN
  -- INSERT または DELETE のターゲット行から recipe_uuid を取得
  IF TG_OP = 'DELETE' THEN
    v_recipe_uuid := OLD.recipe_uuid;
  ELSE
    v_recipe_uuid := NEW.recipe_uuid;
  END IF;

  -- recipe_uuid が null の場合（TEXT-only 旧行）はスキップ
  IF v_recipe_uuid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- atomic カウント更新
  SELECT COUNT(*) INTO v_count
  FROM recipe_likes
  WHERE recipe_uuid = v_recipe_uuid;

  UPDATE recipes
  SET like_count = v_count
  WHERE id = v_recipe_uuid;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_recipe_like_count ON recipe_likes;
CREATE TRIGGER trg_sync_recipe_like_count
AFTER INSERT OR DELETE ON recipe_likes
FOR EACH ROW EXECUTE FUNCTION sync_recipe_like_count();

-- 5. 既存 like_count を recipe_uuid ベースで再集計（初期同期）
UPDATE recipes r
SET like_count = (
  SELECT COUNT(*) FROM recipe_likes rl WHERE rl.recipe_uuid = r.id
);
