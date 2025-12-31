-- ============================================================
-- fix_normalize_dish_name_regex (remote: 20251230074555)
-- ============================================================

create or replace function normalize_dish_name(name text)
returns text
language plpgsql
immutable
as $$
begin
  return lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(name, ''), '[\\s　]+', '', 'g'),        -- 空白除去（半角/全角）
          '（[^）]*）', '', 'g'                                          -- 全角括弧ごと除去
        ),
        '\\([^)]*\\)', '', 'g'                                          -- 半角括弧ごと除去
      ),
      '[・･]', '', 'g'                                                  -- 中点除去
    )
  );
end;
$$;


