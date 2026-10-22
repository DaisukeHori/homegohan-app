-- rollback: 20261016190000_deletion_record_and_invite_email_hash.sql
-- 戻す順: 戻し口は新しい順に流す (後の 20261022190000_db_privilege_hardening.sql を先に戻す)。ここで anon / authenticated に
--   付け直す TRUNCATE (GRANT ALL に含まれる) は、190000 が public の全部の表で利用者に持たせないとしたもの。190000 の戻し口はこの表の
--   TRUNCATE を付け直さず、この戻し口が付け直す前提でできている。190000 が残ったままこの戻し口だけを流すと、RLS の効かない
--   TRUNCATE が利用者に戻る (190000 の不変条件を破る)。
-- #1562 の削除の実行記録と、招待の監査の招待先アドレスのハッシュ化を戻す。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- ⛔ 戻らないもの:
--   - membership_audit.metadata の email_hash は、生のアドレスに戻せない (ハッシュは一方向)。
--     戻したあとの上限の判定 (同じ宛先へ 3) は metadata ->> 'email' を数えるので、ハッシュにした既存の行は数えない
--     (戻した時点から 24 時間は、同じ宛先への上限が実質 0 件から数え直しになる)。
--   - gdpr_deletion_requests の削除の実行記録 (足した列の値) は、列ごと消える。残したいときは、先に別の場所へ写す。
--   - Vault の鍵 (pii_hmac_key) は消さない (消すと、もう一度 migration を当てたときに別の鍵になり、残っているハッシュと合わなくなる)。
--
-- 先に Web のデプロイを戻す (src/lib/account-deletion.ts が begin_account_deletion_record / complete_account_deletion_record を呼ばない版)。
-- 関数を先に消すと、退会が step 'record' で失敗する (500)。
--
-- 何度流しても同じ結果になる (冪等)。

-- E. 削除の実行記録
DROP FUNCTION IF EXISTS public.complete_account_deletion_record(uuid);
DROP FUNCTION IF EXISTS public.begin_account_deletion_record(uuid, text, text, text, uuid);

DROP INDEX IF EXISTS public.idx_gdpr_deletion_requests_subject_hash;
ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_subject_hash_format,
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_executor_type_check,
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_reason_code,
  DROP COLUMN IF EXISTS subject_hash,
  DROP COLUMN IF EXISTS executor_type,
  DROP COLUMN IF EXISTS reason,
  DROP COLUMN IF EXISTS request_id;

-- 外部キーを 20261010000100 の形 (ON DELETE SET NULL) に戻す。user_id が auth.users に無い行があると失敗するので、先に NULL にする
UPDATE public.gdpr_deletion_requests AS r
   SET user_id = NULL
 WHERE r.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = r.user_id);
ALTER TABLE public.gdpr_deletion_requests
  DROP CONSTRAINT IF EXISTS gdpr_deletion_requests_user_id_fkey,
  ADD CONSTRAINT gdpr_deletion_requests_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- 権限とポリシーを本番のベースライン (supabase/baseline/prod_schema.sql) の形に戻す
GRANT ALL ON TABLE public.gdpr_deletion_requests TO anon, authenticated, service_role;
DROP POLICY IF EXISTS gdpr_insert_self ON public.gdpr_deletion_requests;
CREATE POLICY gdpr_insert_self ON public.gdpr_deletion_requests FOR INSERT WITH CHECK ((user_id = auth.uid()));
DROP POLICY IF EXISTS gdpr_select ON public.gdpr_deletion_requests;
CREATE POLICY gdpr_select ON public.gdpr_deletion_requests FOR SELECT USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles))))));
DROP POLICY IF EXISTS gdpr_update ON public.gdpr_deletion_requests;
CREATE POLICY gdpr_update ON public.gdpr_deletion_requests FOR UPDATE USING ((((user_id = auth.uid()) AND (executed_at IS NULL)) OR (EXISTS ( SELECT 1
   FROM public.user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND ('super_admin'::text = ANY (user_profiles.roles)))))));

COMMENT ON TABLE public.gdpr_deletion_requests IS 'GDPR/個人情報消去リクエスト。30日クーリングオフ後実行。';
COMMENT ON COLUMN public.gdpr_deletion_requests.user_id IS
  '#1175: 削除要求をした人。NULL = 退会が済んで紐づけを外した (要求と実行の日時の記録は残す)';
COMMENT ON COLUMN public.gdpr_deletion_requests.requested_at IS NULL;
COMMENT ON COLUMN public.gdpr_deletion_requests.executed_at IS NULL;

-- D. 上限の判定を 20261008100000 の定義 (metadata ->> 'email' と lower(p_email) の比較) に戻す
CREATE OR REPLACE FUNCTION public.enforce_membership_daily_cap(
  p_kind TEXT,
  p_scope_id UUID,
  p_email TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor  UUID := auth.uid();
  v_email  TEXT := pg_catalog.lower(p_email);
  v_since  TIMESTAMPTZ := pg_catalog.now() - INTERVAL '24 hours';
  v_count  BIGINT;
  v_oldest TIMESTAMPTZ;
  v_rule   TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'family_invite' THEN
    IF NOT public.is_active_family_adult(p_scope_id) THEN
      RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:family_invite:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:family_invite:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'invite_created' AND a.scope = 'family'
       AND a.created_at > v_since;
    IF v_count >= 20 THEN
      v_rule := 'family_invite:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'family' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since AND (a.metadata ->> 'email') = v_email;
      IF v_count >= 3 THEN
        v_rule := 'family_invite:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'org_invite' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = v_actor AND up.organization_id = p_scope_id
         AND up.org_role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:org_invite:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:org_invite:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'invite_created' AND a.scope = 'organization'
       AND a.created_at > v_since;
    IF v_count >= 200 THEN
      v_rule := 'org_invite:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'organization' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since;
      IF v_count >= 500 THEN
        v_rule := 'org_invite:per_org';
      END IF;
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'organization' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since AND (a.metadata ->> 'email') = v_email;
      IF v_count >= 3 THEN
        v_rule := 'org_invite:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'child_promotion' THEN
    IF NOT public.is_active_family_adult(p_scope_id) THEN
      RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:child_promotion:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:child_promotion:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'child_promotion_requested'
       AND a.created_at > v_since;
    IF v_count >= 10 THEN
      v_rule := 'child_promotion:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'family' AND a.scope_id = p_scope_id AND a.action = 'child_promotion_requested'
         AND a.created_at > v_since AND (a.metadata ->> 'email') = v_email;
      IF v_count >= 3 THEN
        v_rule := 'child_promotion:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'transfer_propose' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:transfer_propose:actor:' || v_actor::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor
       AND a.action IN ('owner_transfer_proposed', 'representative_transfer_proposed')
       AND a.created_at > v_since;
    IF v_count >= 10 THEN
      v_rule := 'transfer_propose:per_actor';
    END IF;

  ELSE
    RAISE EXCEPTION 'INVALID_DAILY_CAP_KIND' USING ERRCODE = '22023';
  END IF;

  IF v_rule IS NOT NULL THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING
      ERRCODE = 'P0001',
      DETAIL = v_rule,
      HINT = 'retry_after_sec=' || GREATEST(1, pg_catalog.ceil(pg_catalog.date_part(
               'epoch', v_oldest + INTERVAL '24 hours' - pg_catalog.now())))::BIGINT::TEXT;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) IS
  '#1163: 招待・昇格リクエスト・譲渡提案の 24 時間上限 (membership_audit を数える)。超過は RATE_LIMITED (P0001)、DETAIL に上限名、HINT に retry_after_sec。作成 RPC の認可の後・最初の書き込みの前に PERFORM する。';

-- C. トリガーと関数
DROP TRIGGER IF EXISTS trg_membership_audit_hash_invite_email ON public.membership_audit;
DROP FUNCTION IF EXISTS public.membership_audit_hash_invite_email();
DROP FUNCTION IF EXISTS public.membership_audit_hash_email_in_metadata(jsonb);

-- B. ハッシュの関数
DROP FUNCTION IF EXISTS public.membership_invite_email_hash(text);
DROP FUNCTION IF EXISTS public.pii_hmac_hex(text, text);
