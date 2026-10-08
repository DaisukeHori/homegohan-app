-- rollback: 20261008090100_family_lock_order.sql
-- 7 関数を、この migration の直前の定義へ戻す (家族の行を最初にロックする処理と、ロックのあとの確認のやり直しを外す)。
--   accept_family_invite: 20261007160000_family_member_limit_row_lock.sql の定義 (#1213 の家族の行の FOR UPDATE と、解散済みの家族の拒否は残る)
--   上記以外の 6 関数:    supabase/baseline/prod_schema.sql の定義 (20261007112200 時点の本番。この migration の直前から変わっていない)
--     operator_force_dissolve_family / operator_force_representative_transfer / accept_family_representative_transfer /
--     leave_family / remove_family_member / accept_child_promotion
-- ⚠️ 戻すと #1310 の競合が復活する。
--    - 運営の強制解散と、招待の承諾・子供の追加が同時に走ると、解散済みの家族に active のメンバーが残ることがある。
--    - 代表者による家族の削除と、招待の承諾・移譲の承諾・強制譲渡・強制解散・昇格の承諾が同時に走ると、デッドロック (40P01) し得る。
--    緊急時の切り戻し専用。
-- 実行権限 (anon 不可・authenticated は可・service_role は関数ごとに本番の現行どおり) は、この migration が変えていないため、ここでも触らない。
-- データは戻さない (この migration はデータを更新していない)。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

CREATE OR REPLACE FUNCTION public.accept_family_invite(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_member family_members;
  v_caller_email TEXT;
  v_count INT;
  v_limit INT;
  v_family_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ★ Warning 2: SELECT FOR UPDATE で二重受諾防止
  SELECT * INTO v_invite FROM family_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE family_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- 人数を数える前に、家族の行をロックする (#1213)。別の招待を持つ人の承諾や子供の追加が同時に走っても、
  -- この行を取り合って 1 件ずつ処理されるので、下の人数確認と INSERT の間に他のメンバーが入り込めない。
  -- ロック順は family_invites (上で取得済み) → family_groups。status もこの行で確認し、解散済みの家族には参加させない。
  SELECT member_limit, status INTO v_limit, v_family_status
    FROM family_groups WHERE id = v_invite.family_id FOR UPDATE;
  IF NOT FOUND OR v_family_status <> 'active' THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = v_invite.family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (
    family_id, user_id, role, share_meals, share_health, share_menu
  ) VALUES (
    v_invite.family_id, auth.uid(), 'adult', p_share_meals, p_share_health, p_share_menu
  ) RETURNING * INTO v_member;

  -- 所属家族を本人のプロフィールに入れる (#1273)。初期設定より前に承諾した人はまだプロフィール行が無く、
  -- UPDATE だけだと 0 行で終わって family_id が NULL のままになる。行が無ければ既定値 ('Guest' / 'unspecified') で作る。
  -- 初期設定の日時は入れない。accept_child_promotion (20261007112100) と同じ形。
  INSERT INTO user_profiles (id, nickname, age_group, gender, family_id)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified', v_invite.family_id)
  ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id;

  UPDATE family_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_member;
END $$;

CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_family"("p_family_id" "uuid", "p_reason" "text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_fam family_groups;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members SET status = 'left' WHERE family_id = p_family_id AND status = 'active';
  UPDATE user_profiles SET family_id = NULL WHERE family_id = p_family_id;

  UPDATE family_groups
    SET status = 'dissolved', dissolved_at = NOW()
    WHERE id = p_family_id
    RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_dissolve', NULL,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

CREATE OR REPLACE FUNCTION "public"."operator_force_representative_transfer"("p_family_id" "uuid", "p_new_rep_id" "uuid", "p_reason" "text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_fam family_groups;
  v_old_rep_id UUID;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = p_family_id AND user_id = p_new_rep_id
      AND status = 'active' AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id;

  UPDATE family_members SET role = 'adult'
    WHERE family_id = p_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = p_family_id AND user_id = p_new_rep_id AND status = 'active';
  UPDATE family_groups SET representative_id = p_new_rep_id
    WHERE id = p_family_id RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_representative_transfer',
          NULL, p_new_rep_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_rep_id', v_old_rep_id,
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

CREATE OR REPLACE FUNCTION "public"."accept_family_representative_transfer"("p_proposal_id" "uuid") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_family_id UUID;
  v_old_rep_id UUID;
  v_result family_groups%ROWTYPE;
BEGIN
  SELECT * INTO v_proposal FROM ownership_transfer_proposals
    WHERE id = p_proposal_id AND status = 'pending' AND to_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_proposal.expires_at < NOW() THEN
    UPDATE ownership_transfer_proposals
      SET status = 'expired', resolved_at = NOW()
      WHERE id = p_proposal_id AND status = 'pending';
    RAISE EXCEPTION 'TRANSFER_PROPOSAL_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  v_family_id := v_proposal.scope_id;
  v_old_rep_id := v_proposal.from_user_id;

  -- ★(A) #1237 Fix: 承諾者が今も対象家族の active adult / representative であることを再検証。
  -- leave_family / remove_family_member は family_members.status を 'left' / 'removed' に、
  -- user_profiles.family_id を NULL に同一トランザクションで設定するため、
  -- status = 'active' 行の存在確認で「今も対象家族に所属」を判定できる。
  -- role IN ('representative','adult') は operator_force_representative_transfer
  -- (20260511000125) と対称の防御多層化。propose 側で child は既に
  -- CANNOT_TRANSFER_TO_CHILD で遮断されるため happy path には無影響。
  IF NOT EXISTS (
    SELECT 1 FROM family_members
      WHERE family_id = v_family_id
        AND user_id = auth.uid()
        AND status = 'active'
        AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TRANSFER_ACCEPTOR_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- ★(B) TOCTOU close
  UPDATE ownership_transfer_proposals
    SET status = 'accepted', resolved_at = NOW()
    WHERE id = p_proposal_id AND status = 'pending'
    RETURNING * INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PENDING' USING ERRCODE = 'P0001';
  END IF;

  -- role swap (現行 20260711120000 と完全同一)
  UPDATE family_members SET role = 'adult'
    WHERE family_id = v_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = v_family_id AND user_id = auth.uid() AND status = 'active';
  UPDATE family_groups SET representative_id = auth.uid() WHERE id = v_family_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_family_id, 'representative_transferred', auth.uid(), v_old_rep_id,
          jsonb_build_object('proposal_id', p_proposal_id));

  SELECT * INTO v_result FROM family_groups WHERE id = v_family_id;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION "public"."leave_family"() RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_member family_members;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_member FROM family_members WHERE user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  IF v_member.role = 'representative' THEN
    RAISE EXCEPTION 'IS_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET status = 'left', removed_at = NOW()
    WHERE id = v_member.id
    RETURNING * INTO v_member;

  UPDATE user_profiles SET family_id = NULL WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_member.family_id, 'member_left', auth.uid(), auth.uid());

  RETURN v_member;
END $$;

CREATE OR REPLACE FUNCTION "public"."remove_family_member"("p_family_id" "uuid", "p_member_id" "uuid") RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_caller_role family_role_enum; v_target family_members;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_target FROM family_members WHERE id = p_member_id AND family_id = p_family_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_target.role = 'representative' THEN
    RAISE EXCEPTION 'IS_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET status = 'removed', removed_at = NOW()
    WHERE id = p_member_id
    RETURNING * INTO v_target;

  IF v_target.user_id IS NOT NULL THEN
    UPDATE user_profiles SET family_id = NULL WHERE id = v_target.user_id;
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', p_family_id, 'member_removed', auth.uid(), v_target.user_id);

  RETURN v_target;
END $$;

CREATE OR REPLACE FUNCTION "public"."accept_child_promotion"("p_token" "text", "p_share_meals" boolean DEFAULT true, "p_share_health" boolean DEFAULT false, "p_share_menu" boolean DEFAULT true) RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_request family_promotion_requests;
  v_member family_members;
  v_caller_email TEXT;
  v_constraint TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- (1) 非ロック読み: member_id 解決 + 終端 status の早期確定。
  --     終端 status (accepted/rejected/revoked/expired) は不変条件のため
  --     非ロック読みでも確定判定してよい。'pending' だけが遷移しうるので (3) で再検証する。
  --     member_id / token は全 RPC を通じて UPDATE されない不変列 → (2) でそのまま使える。
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'expired' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  ELSIF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- (2) member 行を先にロック (canonical 順の先頭。request_child_promotion と同順)
  SELECT * INTO v_member FROM family_members WHERE id = v_request.member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- (3) request 行をロックし、(1) の 'pending' 判定を再検証
  --     ((1)→(3) の間に revoke/再送で遷移した可能性がある。member ロック保持中は
  --      canonical 順に従う他 RPC はもうこの行に触れないため、(3) 以降は安定)
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    IF v_request.status = 'expired' THEN
      RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- 期限切れ。status を 'expired' に UPDATE しても直後の RAISE で巻き戻るため書かない
  -- (status は 'pending' のまま。期限切れは常に expires_at で判定する)。
  IF v_request.expires_at < NOW() THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 対象者本人であることを「自分のメール」で検証 (呼び出し者自身 = 列挙オラクルにならない)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_request.email) THEN
    RAISE EXCEPTION 'PROMOTION_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- member の状態検証 ((2) でロック済みの行が権威)
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し者が既にどこかの family に所属していないこと (クリーンパスの事前チェック)
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- G3 (v2): 同一本人の 2 token 並行 accept は uniq_family_members_user の 23505 を
  -- ALREADY_IN_FAMILY(409) へ正規化。他の unique violation は再 RAISE。
  BEGIN
    UPDATE family_members
      SET user_id = auth.uid(), child_profile = NULL, role = 'adult',
          share_meals = p_share_meals, share_health = p_share_health, share_menu = p_share_menu
      WHERE id = v_member.id
      RETURNING * INTO v_member;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'uniq_family_members_user' THEN
        RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
      END IF;
      RAISE;
  END;

  -- 所属家族を本人のプロフィールに入れる。メールのリンクから新規登録して初期設定 (オンボーディング) より前に
  -- 承認した人は、まだプロフィール行が無い (auth.users → user_profiles を作るトリガーは無く、行は初期設定の
  -- 保存で作られる)。UPDATE だけだと 0 行で終わり、後から初期設定で作られる行の family_id は NULL のままになり、
  -- 家族の画面で「家族なし」扱いになる。行が無ければ、アプリの既定値 (/api/profile・/api/onboarding/progress と同じ
  -- nickname 'Guest'・age_group / gender 'unspecified') で作る。初期設定の日時は入れないため初期設定の流れは変わらない。
  -- (2026-10-07 オーナー判断。設計 v2/v3 からの追加)
  INSERT INTO user_profiles (id, nickname, age_group, gender, family_id)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified', v_member.family_id)
  ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id;

  UPDATE family_promotion_requests
    SET status = 'accepted', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promoted', auth.uid(), auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'request_id', v_request.id,
                             'requested_by', v_request.requested_by));

  RETURN v_member;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;
