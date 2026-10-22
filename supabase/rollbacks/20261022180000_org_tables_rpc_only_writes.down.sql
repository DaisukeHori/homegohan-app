-- rollback: 20261022180000_org_tables_rpc_only_writes.sql
-- #1917 で外した、org_license_pools と organization_invites への利用者 (anon / authenticated) からの書き込みのポリシーと権限を
-- 元に戻し、create_org_invite を SECURITY INVOKER の定義 (20261017160000_org_invite_same_org_member.sql) に戻す。
-- ポリシーの名前・種類・対象のロール・式は、次の定義と同じ:
--   org_license_pools_update_admin / org_invites_insert_admin / org_invites_update_admin:
--     本番のベースライン 20251126124224_create_meal_planner_tables.sql:10665・:10638・:10650 (TO public)
--   "Org admins can manage invites" (FOR ALL):
--     20261017130000_operator_mfa_db_gate.sql:406 (TO authenticated・運営の項に operator_mfa_satisfied())
-- 権限は、同じベースラインの :11798-11799・:12785-12786 が anon / authenticated に付けていた書き込みの権限
-- (INSERT・UPDATE・DELETE・TRUNCATE) を付け直す。
-- (tests/org-tables-rpc-only-writes-migration-contract.test.ts が、ベースラインと 20261017130000 の文との一致を見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、組織の owner / admin が org_license_pools の total_licenses / used_licenses を直接 UPDATE でき、
--     招待の行を直接 INSERT / UPDATE できるようになり、席数の上限・create_org_invite の門 (ALREADY_IN_ORG・SEAT_LIMIT_EXCEEDED・
--     RATE_LIMITED) を通らない穴が再び開く。create_org_invite に 'owner' を渡すと、owner の役割の招待を作れるようになる。
--   - アプリ (招待の作成は RPC・削除は DELETE /api/org/invites・席数は読むだけ) は、戻しても戻さなくても動く。
--     先にアプリを戻す必要は無い。
--   - create_org_invite を SECURITY INVOKER に戻すと、招待の作成は利用者の INSERT / UPDATE の権限とポリシーに頼るので、
--     下で権限とポリシーを戻してから使われる (1 つのトランザクションの中なので、順番による窓は無い)。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。GRANT と CREATE OR REPLACE は何度流しても同じ)。
-- データは戻さない (この migration はデータを変えていない)。

SET LOCAL lock_timeout = '10s';

-- 1. org_license_pools
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.org_license_pools TO anon, authenticated;

DROP POLICY IF EXISTS org_license_pools_update_admin ON public.org_license_pools;
CREATE POLICY "org_license_pools_update_admin" ON "public"."org_license_pools" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "org_license_pools"."organization_id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))));

-- 2. organization_invites
GRANT INSERT, UPDATE, TRUNCATE ON TABLE public.organization_invites TO anon, authenticated;
GRANT DELETE ON TABLE public.organization_invites TO anon;

DROP POLICY IF EXISTS "Org admins can view invites" ON public.organization_invites;
DROP POLICY IF EXISTS "Org admins can delete invites" ON public.organization_invites;

DROP POLICY IF EXISTS "Org admins can manage invites" ON public.organization_invites;
CREATE POLICY "Org admins can manage invites" ON public.organization_invites TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_invites.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));

DROP POLICY IF EXISTS org_invites_insert_admin ON public.organization_invites;
CREATE POLICY "org_invites_insert_admin" ON "public"."organization_invites" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_invites"."organization_id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))));

DROP POLICY IF EXISTS org_invites_update_admin ON public.organization_invites;
CREATE POLICY "org_invites_update_admin" ON "public"."organization_invites" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."user_profiles" "up"
  WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "organization_invites"."organization_id") AND ("up"."org_role" = ANY (ARRAY['owner'::"public"."org_role_enum", 'admin'::"public"."org_role_enum"]))))));

-- 3. create_org_invite: 20261017160000_org_invite_same_org_member.sql の定義 (SECURITY INVOKER・'owner' の判定なし) に戻す
CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_organization_id UUID,
  p_email TEXT,
  p_role public.org_role_enum DEFAULT 'member',
  p_custom_message TEXT DEFAULT NULL
) RETURNS public.organization_invites
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_token TEXT;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
  v_seat_limit INT;
  v_used_seats INT;
BEGIN
  -- 呼び出し元が同 org の admin/owner か検証
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_org_id IS DISTINCT FROM p_organization_id OR v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- #1799: 宛先がこの組織の在籍者・持ち主なら招待を作らない ('ALREADY_IN_ORG')。承諾で org_role を書き換えさせないため。
  -- 席数・24 時間の上限より前に判定する (作らない招待で上限の判定をしない)。既存の pending は取り消さない
  PERFORM public.assert_org_invite_recipient_not_in_org(p_organization_id, p_email);

  -- seat 上限チェック (org_license_pools)
  SELECT total_licenses, used_licenses INTO v_seat_limit, v_used_seats
    FROM org_license_pools WHERE organization_id = p_organization_id;

  IF v_seat_limit IS NOT NULL AND v_used_seats >= v_seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- #1163: 24 時間の作成上限 (招待者ごと 200 / 組織ごと 500 / 同じ組織から同じ宛先へ 3)。超過は 'RATE_LIMITED'
  PERFORM public.enforce_membership_daily_cap('org_invite', p_organization_id, p_email);

  -- token 生成: gen_random_uuid() x2 → 64 文字 hex (pgcrypto 不要)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  -- 既存 pending を invalidate (revoke)
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE organization_id = p_organization_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO organization_invites (
    organization_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_organization_id, lower(p_email), v_token, p_role, p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  RETURN v_invite;
END $$;
