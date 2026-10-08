-- rollback: 20261008120000_shopping_list_active_lock.sql
-- public.replace_active_shopping_list / public.get_or_create_active_shopping_list (#1312) を消す。
-- テーブル・制約・インデックス・データは migration で一切変えていないので、戻すものは関数だけ。
--
-- 先に Web のデプロイ (src/lib/shopping-list/active-list.ts が get_or_create_active_shopping_list を呼ぶ版) と
-- Edge Function (regenerate-shopping-list-v2 が replace_active_shopping_list を呼ぶ版) を #1312 より前の版に戻すこと。
-- 先にこのロールバックを当てると、POST /api/shopping-list/add-recipe と AI 相談の add_to_shopping_list が 500 に、
-- 買い物リストの再生成が failed になる (PostgREST の PGRST202: Could not find the function)。
-- 戻したあとは、再生成と「レシピから追加」が同時に走ると再生成が一意制約違反 (23505) で失敗する問題 (#1312) が復活する。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
--
-- 何度流しても同じ結果になる (冪等)。この関数で作られたリスト・食材は通常のデータなので残る。

DROP FUNCTION IF EXISTS public.get_or_create_active_shopping_list(UUID, TEXT, DATE, DATE);
DROP FUNCTION IF EXISTS public.replace_active_shopping_list(UUID, TEXT, DATE, DATE, JSONB);
