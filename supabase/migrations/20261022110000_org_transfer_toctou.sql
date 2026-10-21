-- migration: 20261022110000_org_transfer_toctou.sql
-- 戻し方: supabase/rollbacks/20261022110000_org_transfer_toctou.down.sql
-- 組織のオーナーの譲渡の承諾が解散と同時に走ると、生の DB のエラー (CHECK user_profiles_org_consistency・23514) が API に届く
-- 既存の欠陥を直す (docs/design/family/11-self-dissolve.md の S-18・§11.3。CLAUDE.md の「組織 (organizations) を変える関数のロック順 (DB)」の既知の箇条)。
--
-- 背景:
--   accept_org_owner_transfer (最新の定義は 20261017030000_parental_consent_and_birth_date.sql) は、承諾者の在籍の判定
--   (organization_id = 提案の組織) をロックの外で行い、そのあと 提案の行 → 旧オーナーの user_profiles → 新オーナーの user_profiles →
--   organizations の順に書いていた。オーナーの解散 (dissolve_org_by_owner) や運営の強制解散 (operator_force_dissolve_org) が
--   先にオーナーの行を取って後始末を進めている間に承諾が判定を通ると、承諾は旧オーナーの行の UPDATE で解散の commit を待ち、
--   commit のあとに所属の外れた行 (organization_id が NULL) へ org_role = 'admin' を書こうとして CHECK で止まる。
--   承諾の API は、この 23514 を利用者向けのエラーにできず 500 にしていた。
--   運営の強制譲渡 (operator_force_owner_transfer。最新の定義は 20261017130000_operator_mfa_db_gate.sql) も、新オーナーの在籍の判定を
--   ロックの外で行い、旧オーナー → 新オーナーの user_profiles → organizations の順に書くので、解散と同時に走ると同じ 23514 で止まる。
--   脱退 (leave_org) と除名 (remove_org_member。どちらも最新の定義は 20251126124224_create_meal_planner_tables.sql) は、
--   本人・対象の org_role の判定をロックの外で行う。譲渡の承諾が先に commit して本人・対象がオーナーになっていても、
--   判定の時点の版 (member / admin) のまま所属を外すので、organizations.owner_id が所属の無い人を指す組織が残る。
--   オーナーの解散 (dissolve_org_by_owner。最新の定義は 20261019120000_self_dissolve.sql) は、呼び出した本人の user_profiles の行を
--   最初に取ってから組織の行を取り、そのあとでオーナーかを判定する。解散の API (src/app/api/org/dissolve/route.ts) は役割を読まずに
--   RPC を呼ぶので、オーナーでない人も呼べる。そのとき「本人の行 → 組織の行」は、組織の行のあとにその人の行を取る関数と逆向きになり、
--   同時に走るとデッドロック (40P01) する: 本人の招待の承諾 (accept_org_invite: 組織の行 → 承諾者 = 本人の行)、オーナーの解散と
--   運営の強制解散 (組織の行 → 後始末で全員の行)、下の 1・2 の譲渡 (組織の行 → 承諾者 / 新オーナー = 本人の行)。
--
-- 変更:
--   1. accept_org_owner_transfer: 提案の読み出しを FOR NO KEY UPDATE にし、期限の判定のあと、所属を書く前に
--      現オーナーの user_profiles (FOR NO KEY UPDATE。読んだ後にオーナーが変わっていたら新しいオーナーの行を取り直す) →
--      組織の行 (FOR NO KEY UPDATE) → 承諾者の user_profiles (FOR NO KEY UPDATE) の順に取り、ロックの下で判定し直す。
--        - 組織が active でなければ ORG_ALREADY_DISSOLVED (新しく返りうるエラー。従来は判定の時点で解散が commit していれば
--          TRANSFER_ACCEPTOR_NOT_IN_ORG、判定のあとなら 23514 だった)。組織の行が無ければ従来どおり TRANSFER_ACCEPTOR_NOT_IN_ORG。
--        - 承諾者の在籍 (organization_id = 提案の組織) が無ければ TRANSFER_ACCEPTOR_NOT_IN_ORG (既存のコード)。
--        - 提案が pending でなければ TRANSFER_NOT_PENDING (既存。順番も従来どおり在籍の判定のあと)。
--        - 提案者 (旧オーナー) が今もこの組織のオーナーで在籍していなければ NOT_ORG_OWNER (新しく返りうるエラー)。
--          運営の強制譲渡のあとに残った提案を承諾すると、従来は旧オーナー (もう admin) と承諾者の両方を書き、強制譲渡で
--          オーナーになった人の org_role = 'owner' が残っていた (オーナーが 2 人)。旧オーナーの行を書く前に、その行をロックの下で
--          判定するためにも要る (ロックしていない行に org_role を書くと、同時の脱退で 23514 になる)。
--      エラーの順番: MINOR_ACCOUNT_NOT_ALLOWED → TRANSFER_PROPOSAL_NOT_FOUND → TRANSFER_PROPOSAL_EXPIRED → ORG_ALREADY_DISSOLVED →
--      TRANSFER_ACCEPTOR_NOT_IN_ORG → TRANSFER_NOT_PENDING → NOT_ORG_OWNER。書き込み (役割の入れ替え・owner_id・監査) は従来のまま。
--   2. operator_force_owner_transfer: 権限・MFA の判定のあと、同じ向きで 現オーナーの user_profiles (取り直しつき) → 組織の行 →
--      新オーナーの user_profiles を FOR NO KEY UPDATE で取り、ロックの下で新オーナーの在籍を判定する (TARGET_NOT_IN_ORG。既存)。
--      旧オーナーはロックした組織の行の owner_id。解散した組織は所属が 0 人なので、従来どおり TARGET_NOT_IN_ORG になる (新しいエラーは無い)。
--   3. leave_org: 本人の user_profiles の読み出しを FOR NO KEY UPDATE にする (NOT_IN_ORG / IS_ORG_OWNER の判定をロックの下で行う)。
--   4. remove_org_member: 対象の user_profiles の読み出しを FOR NO KEY UPDATE にする (USER_NOT_IN_ORG / CANNOT_REMOVE_OWNER /
--      NOT_ORG_OWNER の判定をロックの下で行う)。呼び出し元の行はロックしない (下のロックの向きの規則の (4))。
--   5. dissolve_org_by_owner: 呼び出した本人の行ではなく、組織の行から読んだ現オーナーの user_profiles を最初に取る
--      (FOR NO KEY UPDATE。読んだ後にオーナーが変わっていたら取り直す。operator_force_dissolve_org と同じ形) → 組織の行 (FOR NO KEY UPDATE)
--      → 判定。オーナーが呼ぶときは現オーナー = 本人なので、取る行も順も従来と同じ。オーナーでない人が呼ぶときは本人の行を取らず、
--      現オーナーの行を持ってから NOT_ORG_OWNER で止まる (オーナーを読んでから行を取るまでに本人への譲渡が commit していれば、
--      本人は新しいオーナーとして解散できる。譲渡のあとの解散と同じ)。エラーとその順番 (NOT_AUTHENTICATED → ORG_NOT_FOUND →
--      ORG_ALREADY_DISSOLVED → NOT_ORG_OWNER)・後始末・監査・戻り値は従来のまま。関数の説明 (COMMENT) をこの順に合わせる。
--
-- ロックの向き (この migration のあと。組織の所属・役割・解散を変える関数すべて):
--   dissolve_org_by_owner        : 現オーナーの user_profiles (取り直しつき) → organizations → 全員の user_profiles → org_license_pools
--   operator_force_dissolve_org  : 現オーナーの user_profiles (取り直しつき) → organizations → 全員の user_profiles → org_license_pools (20261022100000)
--   accept_org_owner_transfer    : 提案の行 → 現オーナーの user_profiles (取り直しつき) → organizations → 承諾者の user_profiles
--   operator_force_owner_transfer: 現オーナーの user_profiles (取り直しつき) → organizations → 新オーナーの user_profiles
--   accept_org_invite            : 招待の行 → organizations → 承諾者の user_profiles → org_license_pools (20261022100000)
--   leave_org / release_user_membership: 本人の user_profiles → org_license_pools
--   remove_org_member            : 対象の user_profiles → org_license_pools (呼び出し元の行は読むだけ)
--   propose_org_owner_transfer / decline_org_owner_transfer: 提案の行だけ (user_profiles・organizations は読むだけ)
--   (後始末 (org_dissolve_apply) の最後の organizations の UPDATE は、先に取った組織の行を書くだけで、新しく待つ行ではない)
-- 規則: どの関数も (1) 提案の行・招待の行 → (2) 現オーナーの user_profiles → (3) organizations → (4) オーナーでない人の user_profiles →
--   (5) org_license_pools の順にしか取らず、ある段の行を持ったまま、それより前の段の行を待たない (1 つも取らない段は飛ばす)。
--   呼び出し元の行を最初に取る関数は無い (呼び出し元がオーナーとは限らず、(4) を (3) より前に取ることになる。5 の修正の理由)。
--   1 人の user_profiles の行は 1 つの組織にしか属さず (招待の承諾者は所属の無い人)、組織をまたいで待ち合うこともない。
--   したがって、オーナーが変わらない間は待ちの輪 (デッドロック) ができない。
-- 例外 (既知・まれ): 取り直しのループで、読んだオーナー X の行を取るまでに X からの譲渡が commit すると、ループは X の行
--   (もうオーナーでない人の行 = (4)) を持ったまま、新しいオーナー Y の行 ((2)) を待つ。その間に Y の行を先に取った処理が X の行を待つと
--   (Y の解散・運営の強制解散の後始末、Y から X への譲渡のし直し) 40P01 になる。ループを持つ 4 本 (解散 2 本・譲渡 2 本) に共通
--   (operator_force_dissolve_org と同じ。20261022100000)。利用者の API (譲渡の承諾・解散) は 40P01 を CONFLICT_RETRY
--   (409・「ほかの操作と重なりました。もう一度お試しください。」) にする。やり直せば通る。
--
-- signature・戻り値・SECURITY DEFINER・search_path・所有者・EXECUTE 権限 (5 つの関数とも) は変えない
-- (CREATE OR REPLACE のため、権限はそのまま残る)。
-- 既存データへの影響: なし (関数の本文と、dissolve_org_by_owner の説明 (COMMENT) の置き換えだけ)。
-- 冪等: CREATE OR REPLACE FUNCTION と COMMENT ON FUNCTION のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/org-transfer-toctou.test.ts (実 DB)
--       tests/org-transfer-toctou-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. accept_org_owner_transfer (SECURITY DEFINER のまま)。本文は 20261017030000 の定義に、ロックと判定し直しを足したもの
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_org_id UUID;
  v_old_owner_id UUID;
  v_result organizations%ROWTYPE;
  v_org organizations;
  v_lock_owner UUID;
  v_current_owner UUID;
  v_acceptor_org_id UUID;
  v_old_owner_org_id UUID;
BEGIN
  -- #1173 18 歳未満の本人 (生年月日の分かる人) は、昇格 (accept_child_promotion) 以外で家族に入らず、家族の代表者・組織のオーナーを引き受けない
  -- (保護者の同意とのつながりが切れたときの出口 = 退会を、代表者・オーナーの 409 で塞がない。設計書 cross/14 §6.4 の 12)
  IF public.caller_is_minor_jst() THEN
    RAISE EXCEPTION 'MINOR_ACCOUNT_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  -- pending かつ宛先が呼び出し元である proposal を取得する。
  -- 提案の行を最初にロックする (同じ提案の承諾・辞退・新しい提案による expired と直列になる。待ったあとで pending でなくなっていれば NOT_FOUND)
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid()
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.from_user_id;

  -- LOCK-ORDER (docs/design/family/11-self-dissolve.md §11.3・CLAUDE.md の組織のロック順):
  -- 提案の行 → 現オーナーの user_profiles → 組織の行 → 承諾者の user_profiles (どれも FOR NO KEY UPDATE)。
  -- 解散 (dissolve_org_by_owner / operator_force_dissolve_org) も 現オーナーの user_profiles → 組織の行 → 全員の user_profiles の順なので、
  -- オーナーの行で直列になる。解散が先なら、承諾は解散の commit を待ってから dissolved を読んで止まる (所属の外れた行に org_role を書かない)。
  -- 承諾が先なら、解散は承諾の commit を待ってから新しいオーナーの行を取り直し、呼び出した人がもうオーナーでなければ止まる
  -- (オーナーの解散は NOT_ORG_OWNER。承諾者本人の解散なら新しいオーナーとして解散する) か、そのまま解散する (運営の強制解散)。
  -- オーナーを読んでから行を取るまでに譲渡が commit していたら、新しいオーナーの行を取り直す (operator_force_dissolve_org と同じ)。
  -- 組織の行が無い・解散した組織は owner_id が NULL なので、何もロックせずに抜ける
  SELECT owner_id INTO v_lock_owner FROM organizations WHERE id = v_org_id;
  LOOP
    PERFORM 1 FROM user_profiles WHERE id = v_lock_owner FOR NO KEY UPDATE;
    SELECT owner_id INTO v_current_owner FROM organizations WHERE id = v_org_id;
    EXIT WHEN v_current_owner IS NOT DISTINCT FROM v_lock_owner;
    v_lock_owner := v_current_owner;
  END LOOP;

  SELECT * INTO v_org FROM organizations WHERE id = v_org_id FOR NO KEY UPDATE;
  -- 解散した組織 (organizations.status は 'active' / 'dissolved' の 2 値) の提案は承諾させない。
  -- 組織の行が無ければ、下の在籍の判定が従来どおり TRANSFER_ACCEPTOR_NOT_IN_ORG にする
  IF FOUND AND v_org.status <> 'active' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;

  -- ★(A) #1236 Fix: 承諾者が今も対象組織のメンバであることを再検証。
  -- leave_org / remove_org_member / release_user_membership / 解散の後始末は organization_id を NULL に、
  -- 他組織 accept_org_invite は別 org 値に、いずれもアトミックに設定するため、
  -- organization_id = v_org_id の一致確認だけで「今も対象組織に所属」を判定できる。
  -- 承諾者の行をロックしてから読む (同時の脱退・除名と直列にする。ロックの外で判定すると、判定のあとに所属が外れた行へ
  -- org_role = 'owner' を書いて CHECK user_profiles_org_consistency (23514) になる)
  SELECT organization_id INTO v_acceptor_org_id FROM user_profiles WHERE id = auth.uid() FOR NO KEY UPDATE;
  IF v_acceptor_org_id IS NULL OR v_acceptor_org_id <> v_org_id THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) #1236 Fix: status = 'pending' 条件つき UPDATE で二重受諾 / 競合 (TOCTOU) を閉じる。
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- 提案者 (旧オーナー) が今もこの組織のオーナーで、在籍していること。オーナーの行は上のループでロック済み
  -- (v_lock_owner = 組織の owner_id = 提案者のときだけ通す)。運営の強制譲渡のあとに残った提案は、ここで止まる
  IF v_lock_owner IS DISTINCT FROM v_old_owner_id OR v_org.owner_id IS DISTINCT FROM v_old_owner_id THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;
  SELECT organization_id INTO v_old_owner_org_id FROM user_profiles WHERE id = v_old_owner_id;
  IF v_old_owner_org_id IS NULL OR v_old_owner_org_id <> v_org_id THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (順序・意味は現行 20260711120000 と完全同一)
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = auth.uid();
  UPDATE organizations SET owner_id = auth.uid() WHERE id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_org_id, 'owner_transferred', auth.uid(), v_old_owner_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM organizations WHERE id = v_org_id;
  RETURN v_result;
END $$;

-- ----------------------------------------------------------------
-- 2. operator_force_owner_transfer (SECURITY DEFINER のまま)。本文は 20261017130000 の定義に、ロックを足し、在籍の判定をロックの下へ移したもの
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org organizations;
  v_old_owner_id UUID;
  v_caller_roles TEXT[];
  v_lock_owner UUID;
  v_current_owner UUID;
  v_target_org_id UUID;
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める
  IF NOT public.operator_mfa_satisfied() THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (docs/design/family/11-self-dissolve.md §11.3・CLAUDE.md の組織のロック順):
  -- 現オーナーの user_profiles (取り直しつき) → 組織の行 → 新オーナーの user_profiles (どれも FOR NO KEY UPDATE)。
  -- 解散・譲渡の承諾と同じ向きなので、オーナーの行で直列になる。新オーナーの在籍はロックの下で判定する
  -- (ロックの外で判定すると、解散の commit のあとに所属の外れた行へ org_role を書いて 23514 になる)。
  -- 解散した組織は所属が 0 人なので、従来どおり TARGET_NOT_IN_ORG になる
  SELECT owner_id INTO v_lock_owner FROM organizations WHERE id = p_organization_id;
  LOOP
    PERFORM 1 FROM user_profiles WHERE id = v_lock_owner FOR NO KEY UPDATE;
    SELECT owner_id INTO v_current_owner FROM organizations WHERE id = p_organization_id;
    EXIT WHEN v_current_owner IS NOT DISTINCT FROM v_lock_owner;
    v_lock_owner := v_current_owner;
  END LOOP;

  SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id FOR NO KEY UPDATE;

  SELECT organization_id INTO v_target_org_id FROM user_profiles WHERE id = p_new_owner_id FOR NO KEY UPDATE;
  IF v_target_org_id IS NULL OR v_target_org_id <> p_organization_id THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = p_new_owner_id;
  UPDATE organizations SET owner_id = p_new_owner_id WHERE id = p_organization_id RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'operator_force_owner_transfer',
          NULL, p_new_owner_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_owner_id', v_old_owner_id,
            'reason', p_reason
          ));

  RETURN v_org;
END $$;

-- ----------------------------------------------------------------
-- 3. leave_org (SECURITY DEFINER のまま)。本文は 20251126124224 の定義の、本人の行の読み出しに FOR NO KEY UPDATE を足しただけ
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."leave_org"() RETURNS "public"."user_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_user user_profiles; v_org_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 本人の行をロックしてから判定する (譲渡の承諾が先に commit して本人がオーナーになっていれば IS_ORG_OWNER で止める。
  -- ロックの外で判定すると、オーナーになった人の所属を外し、organizations.owner_id が所属の無い人を指す)
  SELECT * INTO v_user FROM user_profiles WHERE id = auth.uid() FOR NO KEY UPDATE;
  IF v_user.organization_id IS NULL THEN
    RAISE EXCEPTION 'NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
  IF v_user.org_role = 'owner' THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  v_org_id := v_user.organization_id;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE id = auth.uid()
    RETURNING * INTO v_user;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = v_org_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', v_org_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_user;
END $$;

-- ----------------------------------------------------------------
-- 4. remove_org_member (SECURITY DEFINER のまま)。本文は 20251126124224 の定義の、対象の行の読み出しに FOR NO KEY UPDATE を足しただけ
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."remove_org_member"("p_organization_id" "uuid", "p_user_id" "uuid") RETURNS "public"."user_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_role org_role_enum;
  v_target user_profiles;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- 対象の行をロックしてから判定する (譲渡の承諾が先に commit して対象がオーナーになっていれば CANNOT_REMOVE_OWNER で止める)。
  -- 呼び出し元の行はロックしない: 譲渡を受けた admin が旧オーナーを除名しようとすると、承諾 (オーナーの行 → 承諾者の行) と逆向きになる
  SELECT * INTO v_target FROM user_profiles WHERE id = p_user_id FOR NO KEY UPDATE;
  IF NOT FOUND OR v_target.organization_id IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'USER_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'owner' THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_OWNER' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.org_role = 'admin' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  UPDATE user_profiles
    SET organization_id = NULL, org_role = NULL,
        is_active_in_org = FALSE, joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE id = p_user_id
    RETURNING * INTO v_target;

  UPDATE org_license_pools
    SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
    WHERE organization_id = p_organization_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('organization', p_organization_id, 'member_removed', auth.uid(), p_user_id);

  RETURN v_target;
END $$;

-- ----------------------------------------------------------------
-- 5. dissolve_org_by_owner (SECURITY DEFINER・search_path = '' のまま)。本文は 20261019120000_self_dissolve.sql の定義の、
--    最初のロック (呼び出した本人の user_profiles) を、現オーナーの user_profiles (取り直しつき。operator_force_dissolve_org と同じ形) に
--    置き換えたもの。判定・後始末・監査・戻り値は変えない
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dissolve_org_by_owner(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org          public.organizations;
  v_member_ids   uuid[];
  v_member_count integer;
  v_lock_owner   uuid;
  v_current_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (docs/design/family/11-self-dissolve.md §11.3・CLAUDE.md の組織のロック順):
  -- 現オーナーの user_profiles (取り直しつき) → 組織の行 (どちらも FOR NO KEY UPDATE) → 後始末 (全員の user_profiles → org_license_pools)。
  -- 呼び出した本人の行は取らない: 本人がオーナーでないとき「本人の行 → 組織の行」は、組織の行のあとに本人の行を取る関数
  -- (譲渡の承諾・運営の強制譲渡・招待の承諾・ほかの解散の後始末) と逆向きになり、同時に走るとデッドロック (40P01) する。
  -- オーナーが呼ぶときは現オーナー = 本人なので、取る行は従来と同じ。オーナーを読んでから行を取るまでに譲渡が commit していたら、
  -- 新しいオーナーの行を取り直す (operator_force_dissolve_org と同じ)。組織の行が無い・解散した組織は owner_id が NULL なので、
  -- 何もロックせずに抜けて、下の判定が ORG_NOT_FOUND / ORG_ALREADY_DISSOLVED にする
  SELECT owner_id INTO v_lock_owner FROM public.organizations WHERE id = p_organization_id;
  LOOP
    PERFORM 1 FROM public.user_profiles WHERE id = v_lock_owner FOR NO KEY UPDATE;
    SELECT owner_id INTO v_current_owner FROM public.organizations WHERE id = p_organization_id;
    EXIT WHEN v_current_owner IS NOT DISTINCT FROM v_lock_owner;
    v_lock_owner := v_current_owner;
  END LOOP;

  SELECT * INTO v_org FROM public.organizations WHERE id = p_organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;
  IF v_org.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(pg_catalog.array_agg(id), '{}'::uuid[]), pg_catalog.count(*)::integer
    INTO v_member_ids, v_member_count
    FROM public.user_profiles
   WHERE organization_id = p_organization_id;

  v_org := public.org_dissolve_apply(p_organization_id);

  INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'group_dissolved', auth.uid(), NULL,
          pg_catalog.jsonb_build_object(
            'dissolved_by', 'owner',
            'previous_owner_id', auth.uid(),
            'member_count', v_member_count
          ));

  RETURN pg_catalog.jsonb_build_object(
    'scope_id', v_org.id,
    'scope_name', v_org.name,
    'dissolved_at', v_org.dissolved_at,
    'member_user_ids', pg_catalog.to_jsonb(v_member_ids)
  );
END $$;
COMMENT ON FUNCTION public.dissolve_org_by_owner(uuid) IS
  '#1917 オーナーが自分の組織を解散する。現オーナーの user_profiles の行 (オーナーが変わっていたら取り直す) → 組織の行の順にロックしてオーナーかを判定し (呼び出した本人の行は取らない)、org_dissolve_apply で後始末、membership_audit に group_dissolved。戻り値は { scope_id, scope_name, dissolved_at, member_user_ids }';
