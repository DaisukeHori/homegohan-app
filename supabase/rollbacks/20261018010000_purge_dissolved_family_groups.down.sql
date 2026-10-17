-- rollback: 20261018010000_purge_dissolved_family_groups.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 消えるもの: pg_cron のジョブ purge-dissolved-family-groups と、関数 public.purge_dissolved_family_groups(BOOLEAN)。
-- 戻らないもの: このジョブが物理削除した家族のグループ (family_groups と、CASCADE で消えた family_members・family_invites・family_promotion_requests) は戻らない。
--   監査ログ (admin_audit_logs の system.family.dissolved_purge) は消さない (消した件数の記録として残す)。
-- 触れないもの: 残っている family_groups の行・parental_consents・membership_audit・ほかの pg_cron のジョブ。
--
-- 何度流しても同じ結果になる (冪等)。pg_cron が無い DB ではジョブの登録解除を飛ばす。

-- 1. ジョブの登録解除
DO $$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'purge-dissolved-family-groups'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END
$$;

-- 2. 関数を消す
DROP FUNCTION IF EXISTS public.purge_dissolved_family_groups(BOOLEAN);
