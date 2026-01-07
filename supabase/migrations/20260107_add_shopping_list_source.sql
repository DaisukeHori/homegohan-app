-- 買い物リスト: LLM正規化対応・生成/手動区別・数量バリエーション切り替え

-- source: 生成元を区別（manual=手動追加, generated=献立から自動生成）
ALTER TABLE shopping_list_items 
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- normalized_name: LLMが正規化した材料名（表記ゆれ吸収・重複マージ用）
ALTER TABLE shopping_list_items 
  ADD COLUMN IF NOT EXISTS normalized_name TEXT;

-- quantity_variants: 数量のバリエーション（タップで切り替え可能）
-- 例: [{"display": "500g", "unit": "g", "value": 500}, {"display": "2枚(約500g)", "unit": "枚", "value": 2}]
ALTER TABLE shopping_list_items 
  ADD COLUMN IF NOT EXISTS quantity_variants JSONB DEFAULT '[]'::jsonb;

-- selected_variant_index: 現在選択中のバリエーションのインデックス
ALTER TABLE shopping_list_items 
  ADD COLUMN IF NOT EXISTS selected_variant_index INTEGER DEFAULT 0;

-- インデックス: source でフィルタしやすく
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_source 
  ON shopping_list_items(meal_plan_id, source);

-- コメント
COMMENT ON COLUMN shopping_list_items.source IS 
  'manual=手動追加, generated=献立から自動生成';
COMMENT ON COLUMN shopping_list_items.normalized_name IS 
  'LLMが正規化した材料名。表記ゆれ吸収・重複マージに使用';
COMMENT ON COLUMN shopping_list_items.quantity_variants IS 
  '数量バリエーション配列。同じ必要量の別表現（例: g と 枚）。UIでタップ切り替え可能';
COMMENT ON COLUMN shopping_list_items.selected_variant_index IS 
  '現在選択中のquantity_variantsのインデックス。0始まり';
