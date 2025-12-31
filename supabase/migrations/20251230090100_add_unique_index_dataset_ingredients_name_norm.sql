-- ============================================================
-- dataset_ingredients: name_norm を一意キーとして利用（ETLのupsert用）
-- 食材栄養.csv は name_norm（括弧内を保持する正規化）で重複しない前提。
-- ============================================================

create unique index if not exists uq_dataset_ingredients_name_norm on dataset_ingredients (name_norm);


