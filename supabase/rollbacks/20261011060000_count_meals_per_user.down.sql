-- rollback: 20261011060000_count_meals_per_user.sql
-- #1491 で足した public.count_meals_per_user() を消す。表のデータには触れない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - Edge Function calculate-segment-stats は、指標 total_meals が有効なときにこの関数を呼ぶ。
--     先に、この関数を呼ばない版の Edge Function をデプロイしてから戻すこと。
--     先に関数だけを消すと、total_meals が有効な間は集計が毎回「関数が無い」(PGRST202) で 500 になる
--     (失敗は黙らず、比較ランキングが更新されなくなる)。
--
-- 何度流しても同じ結果になる (DROP FUNCTION IF EXISTS)。

DROP FUNCTION IF EXISTS public.count_meals_per_user();
