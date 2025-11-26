-- 冷蔵庫（パントリー）とレシピ用のテーブル

-- 1. パントリー（冷蔵庫）アイテム
CREATE TABLE IF NOT EXISTS pantry_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount TEXT, -- '300g', '1個' etc.
  category TEXT NOT NULL DEFAULT 'other', -- 'meat', 'vegetable', 'fish', 'dairy', 'other'
  expiration_date DATE, -- 賞味期限
  added_at DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. レシピ
-- ユーザー独自のレシピと、システム共通レシピ（user_id IS NULL）を想定
CREATE TABLE IF NOT EXISTS recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- NULLならシステム共通
  name TEXT NOT NULL,
  description TEXT,
  calories_kcal INTEGER,
  cooking_time_minutes INTEGER,
  servings INTEGER DEFAULT 1,
  image_url TEXT,
  ingredients JSONB, -- [{ name: '豚肉', amount: '100g' }, ...]
  steps TEXT[], -- ['切る', '炒める', ...]
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_pantry_items_user_id ON pantry_items(user_id);
CREATE INDEX IF NOT EXISTS idx_pantry_items_expiration ON pantry_items(expiration_date);
CREATE INDEX IF NOT EXISTS idx_recipes_user_id ON recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name);

-- RLS
ALTER TABLE pantry_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;

-- pantry_items: 自分のもののみ
CREATE POLICY "Users can manage own pantry items" ON pantry_items
  FOR ALL USING (auth.uid() = user_id);

-- recipes: 自分のもの + パブリック/システム共通
CREATE POLICY "Users can view public recipes" ON recipes
  FOR SELECT USING (user_id IS NULL OR is_public = true OR auth.uid() = user_id);

CREATE POLICY "Users can manage own recipes" ON recipes
  FOR ALL USING (auth.uid() = user_id);



