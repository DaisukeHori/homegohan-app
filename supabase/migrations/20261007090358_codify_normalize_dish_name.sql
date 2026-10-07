-- migration: 20261007090358_codify_normalize_dish_name.sql
-- 関数本文のドリフト (#1243): normalize_dish_name (料理名の正規化) を本番の定義で明文化する
--
-- 背景:
--   2026-10-07 の関数本文の比較で、normalize_dish_name の本文が本番とリポジトリで違うことが分かった。
--   空白を消す正規表現が、本番は '[\s　]+' (正しい)、リポジトリの 20251230074555_fix_normalize_dish_name_regex.sql は
--   '[\\s　]+' だった。standard_conforming_strings=on では後者は「\ と s と全角空白」を消す正規表現になり、
--   半角空白が残って英字の s が消える (例: 'Caesar salad' → 'caear alad'、'sushi' → 'uhi')。
--   本番には影響していないが、migration を最初から流し直すと壊れた版になる。
--   2026-10-07 のオーナー判断「A: 本番の定義を明文化」で、本番の定義をそのまま migration にする。
--
-- 変更:
--   本番 (2026-10-06 のスナップショット supabase/baseline/prod_schema.sql) の定義を、そのまま CREATE OR REPLACE する。
--   本番の動作は変わらない。CREATE OR REPLACE のため、所有者と EXECUTE 権限も本番の現行のまま。
--   この関数に依存する生成列・インデックスは無い (検索 RPC の中で呼ばれるだけ) ため、保存済みデータにも影響しない。
--
--   半角括弧 '(…)' を消す正規表現 ('\\([^)]*\\)') は、本番でも効いていない (\ で囲まれた部分を消す正規表現になっている)。
--   直すと正規化結果 (dataset_* の name_norm など) が変わるため、オーナー判断どおり今回は本番のままにする。
--
-- 確認: tests/integration/rls/normalize-dish-name.test.ts (6 件)。
--   20251230074555 の定義では 4 件が失敗し、この migration の定義 (= 本番) では全件成功する。
-- 冪等: CREATE OR REPLACE FUNCTION。
-- ロールバック: supabase/rollbacks/20261007090358_codify_normalize_dish_name.down.sql

CREATE OR REPLACE FUNCTION "public"."normalize_dish_name"("name" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
begin
  return lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(name, ''), '[\s　]+', '', 'g'),        -- 空白除去（半角/全角）
          '（[^）]*）', '', 'g'                                          -- 全角括弧ごと除去
        ),
        '\\([^)]*\\)', '', 'g'                                      -- 半角括弧ごと除去
      ),
      '[・･]', '', 'g'                                                  -- 中点除去
    )
  );
end;
$$;
