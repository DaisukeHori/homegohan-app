-- rollback: 20261008200700_legal_documents_acceptance.sql
-- 同意を記録する関数 accept_legal_documents と、user_profiles の同意済みの版 3 列を取り除き、
-- 特権列ガード 2 本を 3 列を足す前の定義 (20251126124224 のベースライン時点) へ戻す。
--
-- ⚠️ 先に Web のデプロイ (同意ゲート・/legal-consent・POST /api/legal/accept が入った版) を戻すこと。
--    先にこの rollback を当てると、同意画面の「同意する」が 500 になる (関数が無い)。
--    ゲート側 (lib/supabase/middleware.ts) は、列が無い間 (42703) は素通りするので、ページは開ける。
-- ⚠️ user_profiles の 3 列に入っていた値 (同意した版・同意日時) は失われる。
--    terms_acceptances の行 (同意の証跡) は残るので、必要なら、そこから (user_id, document_type) ごとの最新の版を
--    取り出して列を作り直せる。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
--
-- 何度流しても同じ結果になる (冪等)。

DROP FUNCTION IF EXISTS public.accept_legal_documents(text, text, inet, text);

-- 特権列ガード (UPDATE): 3 列を足す前の定義へ戻す
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
       OR NEW.department_id    IS DISTINCT FROM OLD.department_id THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 特権列ガード (INSERT): 3 列を足す前の定義へ戻す
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
       OR NEW.department_id    IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 列を落とす (ガードが 3 列を参照しなくなってから)
ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS legal_accepted_at,
  DROP COLUMN IF EXISTS privacy_version_accepted,
  DROP COLUMN IF EXISTS terms_version_accepted;
