-- rollback: 20261008200400_auth_users_fk_on_delete.sql
-- 戻すと、auth.users を指す外部キー 33 本が NO ACTION (ON DELETE の指定なし) に戻り、行が残っている利用者・運営者の
-- 退会 (auth.admin.deleteUser) が、外部キー違反 (23503) で再び失敗するようになる。緊急時の切り戻し専用。
-- 先に退会 API のコード (src/lib/account-deletion.ts。prepare_account_deletion を呼ぶ) を戻すこと。
-- 先にこのロールバックを当てると、退会 API は prepare_account_deletion が無いため ACCOUNT_DELETE_FAILED (500) で止まる
-- (何も消えない。アカウントも残る)。
--
-- 内容 (データの行は一切消さない・書き換えない。列の NOT NULL と CHECK を戻せないときは、戻さずに NOTICE を出す):
--   1. prepare_account_deletion を削除する
--   2. coupon_redemptions の anonymized_at を入れるトリガーと関数を削除する
--   3. 外部キーを元の NO ACTION に戻す (32 本)。重複していた admin_audit_logs_admin_id_fkey (actor_id、NO ACTION) も元どおりに戻す
--      (これが残ると、admin_audit_logs に行がある運営者の退会は止まる。元の状態に忠実に戻すための処理)
--   4. coupon_redemptions: 匿名化された行 (user_id も organization_id も NULL) が 1 件も無ければ、
--      CHECK 制約を元の形に戻して anonymized_at 列を削除する。1 件でもあれば、元の CHECK に違反して戻せないので、
--      緩めた CHECK と anonymized_at を残す
--   5. NOT NULL を外した 10 列: NULL の行が 1 件も無い列だけ NOT NULL に戻す (退会で NULL になった行がある列は戻せない)
--   6. 退会後も行を残す列につけたコメントを外す
-- 何度流しても同じ結果になる (冪等)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

SET LOCAL lock_timeout = '10s';

-- 1. 退会の直前に呼ぶ関数
DROP FUNCTION IF EXISTS public.prepare_account_deletion(uuid);

-- 2. coupon_redemptions のトリガーと関数
DROP TRIGGER IF EXISTS trg_coupon_redemptions_mark_anonymized ON public.coupon_redemptions;
DROP FUNCTION IF EXISTS public.coupon_redemptions_mark_anonymized();

-- 3. 外部キーを NO ACTION に戻す
ALTER TABLE public.nps_surveys
  DROP CONSTRAINT IF EXISTS nps_surveys_user_id_fkey,
  ADD CONSTRAINT nps_surveys_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.csat_feedbacks
  DROP CONSTRAINT IF EXISTS csat_feedbacks_user_id_fkey,
  ADD CONSTRAINT csat_feedbacks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.experiment_assignments
  DROP CONSTRAINT IF EXISTS experiment_assignments_user_id_fkey,
  ADD CONSTRAINT experiment_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.ai_content_logs
  DROP CONSTRAINT IF EXISTS ai_content_logs_user_id_fkey,
  ADD CONSTRAINT ai_content_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_user_id_fkey,
  ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.support_ticket_messages
  DROP CONSTRAINT IF EXISTS support_ticket_messages_sender_id_fkey,
  ADD CONSTRAINT support_ticket_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users (id);

ALTER TABLE public.coupon_redemptions
  DROP CONSTRAINT IF EXISTS coupon_redemptions_user_id_fkey,
  ADD CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.referral_rewards
  DROP CONSTRAINT IF EXISTS referral_rewards_referrer_id_fkey,
  ADD CONSTRAINT referral_rewards_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES auth.users (id);

ALTER TABLE public.referral_rewards
  DROP CONSTRAINT IF EXISTS referral_rewards_referred_id_fkey,
  ADD CONSTRAINT referral_rewards_referred_id_fkey FOREIGN KEY (referred_id) REFERENCES auth.users (id);

ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_user_id_fkey,
  ADD CONSTRAINT gdpr_deletion_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.email_delivery_logs
  DROP CONSTRAINT IF EXISTS email_delivery_logs_user_id_fkey,
  ADD CONSTRAINT email_delivery_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id);

ALTER TABLE public.admin_audit_logs
  DROP CONSTRAINT IF EXISTS admin_audit_logs_admin_id_fkey,
  ADD CONSTRAINT admin_audit_logs_admin_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users (id);

ALTER TABLE public.admin_user_notes
  DROP CONSTRAINT IF EXISTS admin_user_notes_admin_id_fkey,
  ADD CONSTRAINT admin_user_notes_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users (id);

ALTER TABLE public.announcements
  DROP CONSTRAINT IF EXISTS announcements_created_by_fkey,
  ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users (id);

ALTER TABLE public.coupon_redemptions
  DROP CONSTRAINT IF EXISTS coupon_redemptions_approved_by_fkey,
  ADD CONSTRAINT coupon_redemptions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users (id);

ALTER TABLE public.coupons
  DROP CONSTRAINT IF EXISTS coupons_created_by_fkey,
  ADD CONSTRAINT coupons_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users (id);

ALTER TABLE public.departments
  DROP CONSTRAINT IF EXISTS departments_manager_id_fkey,
  ADD CONSTRAINT departments_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES auth.users (id);

ALTER TABLE public.email_blacklist
  DROP CONSTRAINT IF EXISTS email_blacklist_added_by_fkey,
  ADD CONSTRAINT email_blacklist_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users (id);

ALTER TABLE public.experiments
  DROP CONSTRAINT IF EXISTS experiments_created_by_fkey,
  ADD CONSTRAINT experiments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users (id);

ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_executed_by_fkey,
  ADD CONSTRAINT gdpr_deletion_requests_executed_by_fkey FOREIGN KEY (executed_by) REFERENCES auth.users (id);

ALTER TABLE public.help_articles
  DROP CONSTRAINT IF EXISTS help_articles_created_by_fkey,
  ADD CONSTRAINT help_articles_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users (id);

ALTER TABLE public.infra_alerts
  DROP CONSTRAINT IF EXISTS infra_alerts_ack_by_fkey,
  ADD CONSTRAINT infra_alerts_ack_by_fkey FOREIGN KEY (ack_by) REFERENCES auth.users (id);

ALTER TABLE public.moderation_flags
  DROP CONSTRAINT IF EXISTS moderation_flags_resolved_by_fkey,
  ADD CONSTRAINT moderation_flags_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users (id);

ALTER TABLE public.organization_challenges
  DROP CONSTRAINT IF EXISTS organization_challenges_created_by_fkey,
  ADD CONSTRAINT organization_challenges_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users (id);

ALTER TABLE public.organization_invites
  DROP CONSTRAINT IF EXISTS organization_invites_created_by_fkey,
  ADD CONSTRAINT organization_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users (id);

ALTER TABLE public.plan_price_history
  DROP CONSTRAINT IF EXISTS plan_price_history_changed_by_fkey,
  ADD CONSTRAINT plan_price_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users (id);

ALTER TABLE public.recipe_flags
  DROP CONSTRAINT IF EXISTS recipe_flags_reporter_id_fkey,
  ADD CONSTRAINT recipe_flags_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES auth.users (id);

ALTER TABLE public.recipe_flags
  DROP CONSTRAINT IF EXISTS recipe_flags_reviewed_by_fkey,
  ADD CONSTRAINT recipe_flags_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users (id);

ALTER TABLE public.sales_lead_activities
  DROP CONSTRAINT IF EXISTS sales_lead_activities_actor_id_fkey,
  ADD CONSTRAINT sales_lead_activities_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users (id);

ALTER TABLE public.sales_leads
  DROP CONSTRAINT IF EXISTS sales_leads_assigned_to_fkey,
  ADD CONSTRAINT sales_leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users (id);

ALTER TABLE public.support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_assignee_id_fkey,
  ADD CONSTRAINT support_tickets_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES auth.users (id);

ALTER TABLE public.system_settings
  DROP CONSTRAINT IF EXISTS system_settings_updated_by_fkey,
  ADD CONSTRAINT system_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users (id);

ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_frozen_by_fkey,
  ADD CONSTRAINT user_profiles_frozen_by_fkey FOREIGN KEY (frozen_by) REFERENCES auth.users (id);

-- 4. coupon_redemptions: 匿名化された行が無いときだけ、CHECK 制約を元の形に戻して anonymized_at を削除する
DO $rollback_coupon_check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.coupon_redemptions WHERE user_id IS NULL AND organization_id IS NULL
  ) THEN
    RAISE NOTICE 'coupon_redemptions に user_id も organization_id も NULL の行 (匿名化された償還記録) があるため、CHECK 制約 coupon_redemptions_user_or_org と anonymized_at 列は元に戻さず残します';
  ELSE
    ALTER TABLE public.coupon_redemptions
      DROP CONSTRAINT IF EXISTS coupon_redemptions_user_or_org,
      ADD CONSTRAINT coupon_redemptions_user_or_org
        CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL);
    ALTER TABLE public.coupon_redemptions DROP COLUMN IF EXISTS anonymized_at;
  END IF;
END
$rollback_coupon_check$;

-- 5. NOT NULL を戻す (NULL の行が 1 件も無い列だけ)
DO $rollback_not_null$
DECLARE
  v_target   record;
  v_has_null boolean;
BEGIN
  FOR v_target IN
    SELECT t.tbl, t.col
      FROM (VALUES
        ('support_tickets',         'user_id'),
        ('support_ticket_messages', 'sender_id'),
        ('referral_rewards',        'referrer_id'),
        ('referral_rewards',        'referred_id'),
        ('gdpr_deletion_requests',  'user_id'),
        ('coupons',                 'created_by'),
        ('experiments',             'created_by'),
        ('help_articles',           'created_by'),
        ('plan_price_history',      'changed_by'),
        ('sales_lead_activities',   'actor_id')
      ) AS t(tbl, col)
  LOOP
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I IS NULL)', v_target.tbl, v_target.col)
      INTO v_has_null;
    IF v_has_null THEN
      RAISE NOTICE '%.% に NULL の行 (退会した利用者・運営者の記録) があるため、NOT NULL には戻さず、NULL を許したままにします', v_target.tbl, v_target.col;
    ELSE
      EXECUTE pg_catalog.format('ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL', v_target.tbl, v_target.col);
    END IF;
  END LOOP;
END
$rollback_not_null$;

-- 6. コメントを外す
COMMENT ON COLUMN public.support_tickets.user_id IS NULL;
COMMENT ON COLUMN public.support_ticket_messages.sender_id IS NULL;
COMMENT ON COLUMN public.referral_rewards.referrer_id IS NULL;
COMMENT ON COLUMN public.referral_rewards.referred_id IS NULL;
COMMENT ON COLUMN public.gdpr_deletion_requests.user_id IS NULL;
COMMENT ON COLUMN public.email_delivery_logs.user_id IS NULL;
COMMENT ON COLUMN public.coupon_redemptions.user_id IS NULL;
