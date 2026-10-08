-- rollback: 20261008120100_csat_nps_summary_rpc.sql
-- NPS / CSAT 集計用の関数 2 本 (get_csat_summary / get_nps_summary) を削除する。表・ポリシー・データには触れない (関数を消すだけ)。
-- 先に API のデプロイ (src/app/api/admin/finance/nps/route.ts。この関数を呼ぶコード) を戻すこと。
-- 先にこのロールバックを当てると、関数が無くなるため、管理画面の NPS / CSAT のページだけがエラー (500) になる (ほかの画面には影響しない)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

DROP FUNCTION IF EXISTS public.get_nps_summary(timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS public.get_csat_summary(timestamptz, timestamptz);
