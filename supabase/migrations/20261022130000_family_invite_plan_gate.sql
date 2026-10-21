-- migration: 20261022130000_family_invite_plan_gate.sql
-- 戻し方: supabase/rollbacks/20261022130000_family_invite_plan_gate.down.sql
-- 家族プランの無いグループの代表者・大人が、家族の招待を作れてしまう既存の欠陥 (#1912 段 A の家族の門の取りこぼし) を直す。
--
-- 背景:
--   家族の門 (docs/design/billing/03-paid-plans-and-iap.md §6.6・Q-4) は、20261021100000_billing_paid_plans_iap.sql の
--   create_family_group (FAMILY_PLAN_REQUIRED) と、メンバーの追加のトリガー family_members_billing_plan_gate (BEFORE INSERT) にある。
--   招待の作成 create_family_invite (最新の定義は 20261008100000_membership_daily_send_cap.sql) には門が無かったため、
--   家族プランが切れた (plan_key = free に戻った) グループでも招待を作れ、招待のメール (「家族グループに参加すると…」) が送られ、
--   受け取った人は承諾の時にトリガーの FAMILY_PLAN_REQUIRED で断られていた。
--
-- 変更:
--   create_family_invite: 認可 (NOT_FAMILY_ADULT) の直後、人数上限 (MEMBER_LIMIT_EXCEEDED)・24 時間上限 (RATE_LIMITED)・
--   最初の書き込み (既存 pending の revoke) より前に、グループの plan_key と status を読み、active で plan_key = free なら
--   FAMILY_PLAN_REQUIRED (P0001・DETAIL = 家族の id) で止める。
--   - 判定の式は承諾の門のトリガー family_members_billing_plan_gate と同じ (status = 'active' AND plan_key = 'free')。
--     グループの plan_key は billing/01・02・03 の同期 (作成・代表者の交代のトリガー、写像、手動付与) が代表者の live な家族プラン
--     (billing_has_live_family_plan と同じ集合) に合わせるので、「代表者に live な家族プランが無い」と同じ意味になる。
--     承諾と同じ式にすることで「作れたのに承諾で断られる」招待を作らない。
--   - 認可の後に置くのは、家族の外の人にグループのプランの有無を漏らさないため。人数上限より前に置くのは、契約が切れて
--     人数の上限が既定 (4) に戻ったグループでも、理由 (家族プランが要る) をそのまま返すため。
--   - 読むだけでロックは取らない。家族の行のロック順 (CLAUDE.md の「家族 (family_*) を変える関数のロック順」) は変えない
--     (この関数はもともと家族の行を先にロックしない。既存のロックも外していない)。
--   - 断るときは例外でトランザクションごと巻き戻るので、既存の pending の招待の revoke・招待の行・監査ログ (membership_audit) は
--     書かれない (24 時間上限の数え方も変わらない)。
--
-- 引数・戻り値・SECURITY DEFINER・search_path・所有者・EXECUTE 権限・既存のエラー (NOT_FAMILY_ADULT → MEMBER_LIMIT_EXCEEDED →
-- RATE_LIMITED) とその順番は変えない (CREATE OR REPLACE のため、権限はそのまま残る)。本文は 20261008100000 の定義の逐語に、
-- 変数 2 つ (v_plan_key・v_group_status) と上の判定のかたまりを足しただけ。
-- 既存データへの影響: なし (関数の本文の置き換えだけ)。free のグループにすでにある pending の招待は消さない (承諾はトリガーが断る)。
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/family-plan-gate.test.ts (実 DB)
--       tests/family-invite-plan-gate-migration-contract.test.ts (静的)

-- 関数の置き換えのロックを長く待たない (待ちが続いたら失敗させて流し直す。20261022100000 と同じ)
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.create_family_invite(
  p_family_id UUID,
  p_email TEXT,
  p_custom_message TEXT DEFAULT NULL
) RETURNS public.family_invites
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_token TEXT;
  v_caller_role family_role_enum;
  v_count INT;
  v_limit INT;
  v_plan_key TEXT;
  v_group_status TEXT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- billing/03 §6.6 (#1912): 家族プランの無いグループ (plan_key = free の active なグループ) には招待を作らない。
  -- 判定は承諾の門 (トリガー family_members_billing_plan_gate) と同じ式。承諾で FAMILY_PLAN_REQUIRED になる招待のメールを出さない。
  -- 認可 (NOT_FAMILY_ADULT) の後に置く (家族の外の人にプランの有無を漏らさない)。人数上限・24 時間上限・最初の書き込みより前。
  -- 読むだけでロックは取らない (家族の行のロック順 (CLAUDE.md) は変えない)
  SELECT plan_key, status INTO v_plan_key, v_group_status FROM family_groups WHERE id = p_family_id;
  IF v_group_status = 'active' AND v_plan_key = 'free' THEN
    RAISE EXCEPTION 'FAMILY_PLAN_REQUIRED' USING ERRCODE = 'P0001', DETAIL = p_family_id::text;
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = p_family_id;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- #1163: 24 時間の作成上限 (招待者ごと 20 / 同じ家族から同じ宛先へ 3)。超過は 'RATE_LIMITED'
  PERFORM public.enforce_membership_daily_cap('family_invite', p_family_id, p_email);

  -- token 生成: gen_random_uuid() x2 → 64 文字 hex (pgcrypto 不要)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  -- 既存 pending を revoke
  UPDATE family_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE family_id = p_family_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO family_invites (
    family_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_family_id, lower(p_email), v_token, 'adult', p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'invite_created', auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'email', lower(p_email)));

  RETURN v_invite;
END $$;
