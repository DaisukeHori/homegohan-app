-- rollback: 20261016210000_billing_core.sql (設計: docs/design/billing/01-billing-core.md §6.6)
-- 先に Web のデプロイを戻すこと (新しい Web はこの関数と列を呼ぶ)。
-- 消えるもの: billing_customers の全行、追加した列の値 (stripe_synced_at / stripe_status / cancel_at_period_end / billing_interval /
--             processing_started_at / attempt_count)。status が incomplete の行は expired にしてから CHECK を戻す。
-- 戻すもの: 特権列ガード 2 本を 20261008200700_legal_documents_acceptance.sql の定義に (plan_key_cached を外す)・
--           plan_key_cached の列コメントを baseline の文に・stripe_webhook_events.payload の列コメントを外す (baseline に無い)。
SET LOCAL lock_timeout = '10s';

DROP TRIGGER IF EXISTS family_groups_billing_plan_follow_representative ON public.family_groups;
DROP FUNCTION IF EXISTS public.billing_family_plan_follow_representative();

-- 20261008200700_legal_documents_acceptance.sql:77-129 の定義をそのまま戻す
CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.roles            IS DISTINCT FROM OLD.roles
       OR NEW.org_role         IS DISTINCT FROM OLD.org_role
       OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
       OR NEW.family_id        IS DISTINCT FROM OLD.family_id
       OR NEW.is_active_in_org IS DISTINCT FROM OLD.is_active_in_org
       OR NEW.joined_org_at    IS DISTINCT FROM OLD.joined_org_at
       OR NEW.frozen_at        IS DISTINCT FROM OLD.frozen_at
       OR NEW.frozen_by        IS DISTINCT FROM OLD.frozen_by
       OR NEW.frozen_reason    IS DISTINCT FROM OLD.frozen_reason
       OR NEW.unban_at         IS DISTINCT FROM OLD.unban_at
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id
       OR NEW.terms_version_accepted   IS DISTINCT FROM OLD.terms_version_accepted
       OR NEW.privacy_version_accepted IS DISTINCT FROM OLD.privacy_version_accepted
       OR NEW.legal_accepted_at        IS DISTINCT FROM OLD.legal_accepted_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_user_profiles_privileged_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF (NEW.roles IS NOT NULL AND NEW.roles IS DISTINCT FROM ARRAY['user']::text[])
       OR NEW.org_role         IS NOT NULL
       OR NEW.organization_id  IS NOT NULL
       OR NEW.family_id        IS NOT NULL
       OR NEW.is_active_in_org IS DISTINCT FROM false
       OR NEW.joined_org_at    IS NOT NULL
       OR NEW.frozen_at        IS NOT NULL
       OR NEW.frozen_by        IS NOT NULL
       OR NEW.frozen_reason    IS NOT NULL
       OR NEW.unban_at         IS NOT NULL
       OR NEW.department_id    IS NOT NULL
       OR NEW.terms_version_accepted   IS NOT NULL
       OR NEW.privacy_version_accepted IS NOT NULL
       OR NEW.legal_accepted_at        IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- baseline (20251126124224) の文
COMMENT ON COLUMN public.user_profiles.plan_key_cached IS 'personal_subscriptions の現在有効な plan_key キャッシュ (Edge Function が同期、常に最新とは限らない)';

DROP FUNCTION IF EXISTS public.billing_apply_stripe_subscription(jsonb, timestamptz, text);
DROP FUNCTION IF EXISTS public.billing_finish_stripe_event(text, boolean, text);
DROP FUNCTION IF EXISTS public.billing_claim_stripe_event(text, text, jsonb, interval);

DROP TABLE IF EXISTS public.billing_customers;

ALTER TABLE public.stripe_webhook_events
  DROP COLUMN IF EXISTS processing_started_at,
  DROP COLUMN IF EXISTS attempt_count;
-- baseline (20251126124224) では payload に列コメントが無い
COMMENT ON COLUMN public.stripe_webhook_events.payload IS NULL;

DROP POLICY IF EXISTS personal_subscriptions_insert_admin ON public.personal_subscriptions;
DROP POLICY IF EXISTS personal_subscriptions_update_admin ON public.personal_subscriptions;
-- baseline (20251126124224) のポリシーをそのまま戻す
CREATE POLICY personal_subscriptions_insert ON public.personal_subscriptions
  FOR INSERT WITH CHECK ((user_id = auth.uid()) OR (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)));
CREATE POLICY personal_subscriptions_update ON public.personal_subscriptions
  FOR UPDATE USING ((user_id = auth.uid()) OR (EXISTS (
    SELECT 1 FROM public.user_profiles
     WHERE user_profiles.id = auth.uid() AND ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles)));
GRANT INSERT, UPDATE, DELETE ON public.personal_subscriptions TO anon;

DROP TRIGGER IF EXISTS personal_subscriptions_set_updated_at ON public.personal_subscriptions;

UPDATE public.personal_subscriptions SET status = 'expired' WHERE status = 'incomplete';
ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_status_check;
ALTER TABLE public.personal_subscriptions
  ADD CONSTRAINT personal_subscriptions_status_check
  CHECK (status IN ('trialing', 'active', 'paused', 'cancelled', 'expired', 'past_due', 'grace'));

ALTER TABLE public.personal_subscriptions DROP CONSTRAINT IF EXISTS personal_subscriptions_billing_interval_check;
ALTER TABLE public.personal_subscriptions
  DROP COLUMN IF EXISTS stripe_synced_at,
  DROP COLUMN IF EXISTS stripe_status,
  DROP COLUMN IF EXISTS cancel_at_period_end,
  DROP COLUMN IF EXISTS billing_interval;
