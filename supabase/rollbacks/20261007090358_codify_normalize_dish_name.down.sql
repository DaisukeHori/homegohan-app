-- rollback: 20261007090358_codify_normalize_dish_name.sql
-- 本番での挙動は変わらない (この migration は本番の定義を明文化しただけ)。通常は戻す必要は無い。
--
-- 内容: 2026-10-06 時点の本番の定義 (supabase/baseline/prod_schema.sql) へ戻す。この migration と同じ定義。
-- ⚠️ 20251230074555_fix_normalize_dish_name_regex.sql の定義へは戻さないこと。
--    空白を消す正規表現が '[\\s　]+' のため、半角空白が残って英字の s が消える ('sushi' → 'uhi')。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

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
