-- rollback: 20261017200000_billing_manual_plan_grant.sql
-- 先に Web のデプロイを戻すこと (新しい Web はこの関数を呼ぶ。関数だけ消すと手動付与の API が 500 になる)。
-- 消えるもの: pg_cron のジョブ expire-manual-plan-grants・プロシージャ 1 本・関数 4 本。
-- 残るもの: 付与済みの行 (personal_subscriptions の stripe_subscription_id IS NULL の行) と監査の行。行は消さない。
--           戻したあとは、期限を過ぎた付与が expired にならない (運営が service_role で status を直す)。
-- 消す順: ジョブ → プロシージャ (1 人分の関数を呼ぶ) → 呼ばれる側の関数。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として supabase/migrations に追加し、PR → main マージ → CI で適用する。
SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'expire-manual-plan-grants';
END
$$;

DROP PROCEDURE IF EXISTS public.billing_expire_manual_subscriptions();
DROP FUNCTION IF EXISTS public.billing_expire_manual_subscription_for_user(uuid);
DROP FUNCTION IF EXISTS public.billing_revoke_manual_subscription(uuid);
DROP FUNCTION IF EXISTS public.billing_grant_manual_subscription(uuid, text, timestamptz);
DROP FUNCTION IF EXISTS public.billing_manual_subscription_sync_after_end(uuid, text);
