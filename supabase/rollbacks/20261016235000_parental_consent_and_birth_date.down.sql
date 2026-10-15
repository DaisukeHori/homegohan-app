-- rollback: 20261016235000_parental_consent_and_birth_date.sql
-- #1173 (#1713 段 A) の migration を戻す: 1〜12 の逆順。
--   12. 4 関数 (create_family_group・accept_family_invite・accept_family_representative_transfer・accept_org_owner_transfer) を
--       土台の定義に戻し (本文を写す。create_family_group は 20261016200000 の normalize_profile_name の式つき。normalize_profile_name は消さない)、
--       caller_is_minor_jst() を DROP する。ACL は変わらないので REVOKE / GRANT は流さない。
--    6. トリガー 2 本と、関数 5 本 (revoke_parental_consent_on_member_delete・revoke_parental_consent_on_member_inactive・
--       legal_minor_has_guardian_path・parental_consent_active・age_years_jst) を DROP する。
--   11. accept_child_promotion を 20261015170000、request_child_promotion を 20261008100000 の定義に戻す。
--   10. accept_legal_documents(text, text, inet, text, date) を DROP し、20261008200700 の 4 引数の定義 + REVOKE / GRANT に戻す。
--    9. add_family_child(uuid, …, text) を DROP し、20261007160000 の 3 引数の定義 + REVOKE / GRANT に戻す。
--    8. ガード 3 本を土台の定義 (user_profiles の 2 本は 20261016210000_billing_core.sql・family_members は 20261008090000) に戻す。
--    7. membership_audit_action_check を元の 26 値に戻す (parental_consent_* の監査の行が残っているときは NOT VALID で足す。監査の行は消さない)。
--    4. parental_consents を DROP する。 2. family_members の CHECK・索引・列を DROP する。 1. user_profiles.birth_date を DROP する。
--
-- ⚠️ 戻すと生年月日と同意の記録が消える。先に Web のデプロイ (段 B の画面・route・アカウントの書き出しの分類
--    src/lib/account-export-tables.ts の parental_consents の行) を戻すこと (表が無いのに分類だけ残ると、書き出しがその表で失敗する)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と DROP ... IF EXISTS)。

-- ─── 12. 4 関数を土台の定義に戻し、caller_is_minor_jst() を消す ───
CREATE OR REPLACE FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text" DEFAULT 'free'::"text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_group family_groups;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_groups (name, representative_id, plan_key)
  VALUES (p_name, auth.uid(), p_plan_key)
  RETURNING * INTO v_group;

  INSERT INTO family_members (family_id, user_id, role, display_name)
  VALUES (v_group.id, auth.uid(), 'representative',
          -- #1678: 仮置きの 'Guest'・空白だけの名前は写さない (NULL)。名前は前後の空白を除いて写す
          (SELECT public.normalize_profile_name(nickname) FROM user_profiles WHERE id = auth.uid()));

  UPDATE user_profiles SET family_id = v_group.id WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_group.id, 'group_created', auth.uid(), auth.uid());

  RETURN v_group;
END $$;

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
  v_family_id UUID;
  v_family_found BOOLEAN;
  v_family_status TEXT;
  v_profile_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_invites -> family_members。
  -- 招待の行を FOR UPDATE する前に、招待の宛先の家族の行をロックする。招待の family_id は変わらない列なので、
  -- 家族の id だけロックなしで読む (招待が無ければここで INVITE_NOT_FOUND)。
  SELECT family_id INTO v_family_id FROM family_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 人数を数える前に、家族の行をロックする (#1213)。別の招待を持つ人の承諾や子供の追加が同時に走っても、
  -- この行を取り合って 1 件ずつ処理されるので、下の人数確認と INSERT の間に他のメンバーが入り込めない。
  -- 解散・削除と同時でも、ここで終わりまで待ってから最新の status / member_limit を読む。
  -- 家族の行が無い場合 (代表者が家族ごと削除した直後など) と status の確認は、従来の順番どおり下で行う。
  -- FOR NO KEY UPDATE: 外部キーの確認 (FOR KEY SHARE) と衝突しない最も強いロック。
  SELECT member_limit, status INTO v_limit, v_family_status
    FROM family_groups WHERE id = v_family_id FOR NO KEY UPDATE;
  v_family_found := FOUND;

  -- ★ Warning 2: SELECT FOR UPDATE で二重受諾防止 (家族の行のロックのあと)
  SELECT * INTO v_invite FROM family_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  -- 防御: ロックなしで読んだ家族と違う家族の招待になっていたら、ロックしていない家族に INSERT しないよう止める
  IF v_invite.family_id <> v_family_id THEN
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

  -- ロックした家族の status も確認する。解散済み (status <> 'active') の家族には参加させない。家族の行が無い場合も同じ。
  IF NOT v_family_found OR v_family_status <> 'active' THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = v_invite.family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- #1584: 承諾した本人のプロフィールの名前 (user_profiles.nickname) を、メンバーの行の display_name に写す。
  -- 判定は @homegohan/shared の normalizeProfileName と同じ: 前後の空白 (JavaScript の String.prototype.trim と同じ文字) を除き、
  -- 空なら名前なし、仮置きの 'Guest' (前後の空白を除いて厳密一致) も名前なし。名前なしのときは写さない (NULL のまま)。
  -- プロフィールの行がまだ無い人 (初期設定より前に承諾した人) も名前なしで、写さない。
  SELECT NULLIF(btrim(nickname, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') INTO v_profile_name FROM user_profiles WHERE id = auth.uid();
  IF v_profile_name = 'Guest' THEN
    v_profile_name := NULL;
  END IF;

  INSERT INTO family_members (
    family_id, user_id, role, share_meals, share_health, share_menu, display_name
  ) VALUES (
    v_invite.family_id, auth.uid(), 'adult', p_share_meals, p_share_health, p_share_menu, v_profile_name
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

CREATE OR REPLACE FUNCTION public.accept_family_representative_transfer(p_proposal_id UUID)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- LOCK-ORDER (#1310): family_groups -> ownership_transfer_proposals -> family_members。
  -- メンバーの行を書き換える前に家族の行をロックする (従来は メンバー → 家族の行 の順だった)。
  -- 解散・削除と同時でも、その完了を待ってから下の所属の再検証をするので、解散済みの家族の representative_id は書き換わらない。
  -- 家族の行が無ければ何もせず、下の確認が TRANSFER_ACCEPTOR_NOT_IN_FAMILY になる。
  PERFORM 1 FROM family_groups WHERE id = v_family_id FOR NO KEY UPDATE;

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

CREATE OR REPLACE FUNCTION "public"."accept_org_owner_transfer"("p_proposal_id" "uuid") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_proposal ownership_transfer_proposals;
  v_org_id UUID;
  v_old_owner_id UUID;
  v_result organizations%ROWTYPE;
BEGIN
  -- pending かつ宛先が呼び出し元である proposal を取得 (既存挙動不変)
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

  v_org_id := v_proposal.scope_id;
  v_old_owner_id := v_proposal.from_user_id;

  -- ★(A) #1236 Fix: 承諾者が今も対象組織のメンバであることを再検証。
  -- leave_org / remove_org_member / release_user_membership は organization_id を NULL に、
  -- 他組織 accept_org_invite は別 org 値に、いずれもアトミックに設定するため、
  -- organization_id = v_org_id の一致確認だけで「今も対象組織に所属」を判定できる。
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND organization_id = v_org_id
  ) THEN
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

DROP FUNCTION IF EXISTS public.caller_is_minor_jst();

-- ─── 6・5・3. トリガー 2 本と関数 5 本 ───
DROP TRIGGER IF EXISTS trg_family_members_revoke_parental_consent_on_delete ON public.family_members;
DROP TRIGGER IF EXISTS trg_family_members_revoke_parental_consent ON public.family_members;
DROP FUNCTION IF EXISTS public.revoke_parental_consent_on_member_delete();
DROP FUNCTION IF EXISTS public.revoke_parental_consent_on_member_inactive();
DROP FUNCTION IF EXISTS public.legal_minor_has_guardian_path();
DROP FUNCTION IF EXISTS public.parental_consent_active(uuid);
DROP FUNCTION IF EXISTS public.age_years_jst(date);

-- ─── 11. 昇格 RPC 2 本を土台の定義に戻す ───
CREATE OR REPLACE FUNCTION public.accept_child_promotion(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request family_promotion_requests;
  v_member family_members;
  v_caller_email TEXT;
  v_constraint TEXT;
  v_profile_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  --     (#1310: その前に (1b) で family_groups の行をロックする。family_groups -> family_members -> family_promotion_requests)
  -- (1) 非ロック読み: member_id 解決 + 終端 status の早期確定。
  --     終端 status (accepted/rejected/revoked/expired) は不変条件のため
  --     非ロック読みでも確定判定してよい。'pending' だけが遷移しうるので (3) で再検証する。
  --     member_id / family_id / token は全 RPC を通じて UPDATE されない不変列 → (1b) (2) でそのまま使える。
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'expired' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  ELSIF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- (1b) 家族の行を先にロック (#1310)。従来は (2) の member 行が最初のロックで、家族の行は (プロフィールの family_id の
  --      外部キー確認で) 最後に FOR KEY SHARE を取るだけだった。解散・削除と同時だと、家族の行を先に取った側と
  --      member 行を先に取った側で待ち合ってデッドロックした。家族の行が無ければ何もせず、(2) が PROMOTION_MEMBER_UNAVAILABLE になる。
  PERFORM 1 FROM family_groups WHERE id = v_request.family_id FOR NO KEY UPDATE;

  -- (2) member 行を先にロック (家族の行の次。request_child_promotion と同順)
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

  -- #1584: 承諾した本人のプロフィールの名前 (user_profiles.nickname) を、メンバーの行の display_name に写す。
  -- 子供のときの display_name (家族の中での呼び名) が入っていれば上書きしない (空・空白だけのときだけ写す)。
  -- 判定は @homegohan/shared の normalizeProfileName と同じ: 前後の空白 (JavaScript の String.prototype.trim と同じ文字) を除き、
  -- 空なら名前なし、仮置きの 'Guest' (前後の空白を除いて厳密一致) も名前なし。名前なしのときは写さない (NULL のまま)。
  -- プロフィールの行がまだ無い人 (初期設定より前に承諾した人) も名前なしで、写さない。
  SELECT NULLIF(btrim(nickname, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') INTO v_profile_name FROM user_profiles WHERE id = auth.uid();
  IF v_profile_name = 'Guest' THEN
    v_profile_name := NULL;
  END IF;

  -- G3 (v2): 同一本人の 2 token 並行 accept は uniq_family_members_user の 23505 を
  -- ALREADY_IN_FAMILY(409) へ正規化。他の unique violation は再 RAISE。
  BEGIN
    UPDATE family_members
      SET user_id = auth.uid(), child_profile = NULL, role = 'adult',
          share_meals = p_share_meals, share_health = p_share_health, share_menu = p_share_menu,
          display_name = CASE
            WHEN NULLIF(btrim(display_name, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), '') IS NULL AND v_profile_name IS NOT NULL THEN v_profile_name
            ELSE display_name
          END
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

CREATE OR REPLACE FUNCTION public.request_child_promotion(p_member_id UUID, p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role family_role_enum;
  v_member family_members;
  v_request family_promotion_requests;
  v_token TEXT;
  v_family_name TEXT;
  v_requester_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- 認可を先に (email 解決より前 = 列挙オラクルを作らない)。member 不在時も
  -- v_member.family_id = NULL → ロール NULL → NOT_FAMILY_ADULT (存在有無を漏らさない)。
  -- この FOR UPDATE が canonical 順の先頭ロック。同一 member への並行
  -- request/revoke/accept/reject はこの行で完全直列化される。
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id FOR UPDATE;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- 対象は active な子供プレースホルダーであること
  -- (user_id IS NULL ⟺ role='child' は family_members_child_profile_consistency CHECK が保証)
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- #1163: 24 時間の作成上限 (依頼者ごと 10 / 同じ家族から同じ宛先へ 3)。超過は 'RATE_LIMITED'。ロック順: 上の FOR UPDATE -> 上限の advisory -> 下の request 行
  PERFORM public.enforce_membership_daily_cap('child_promotion', v_member.family_id, p_email);

  -- 既存 pending の失効 (request 行ロックは member 行ロック取得済みの今なら安全)
  UPDATE family_promotion_requests
    SET status = 'revoked', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE member_id = p_member_id AND status = 'pending';

  -- G4: gen_random_bytes は使用禁止 (pgcrypto/search_path 地雷 = 20260511000134 の教訓)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO family_promotion_requests
    (family_id, member_id, email, token, status, requested_by, expires_at)
  VALUES
    (v_member.family_id, p_member_id, lower(p_email), v_token, 'pending', auth.uid(),
     NOW() + INTERVAL '14 days')
  RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promotion_requested', auth.uid(), NULL,
          jsonb_build_object('member_id', p_member_id, 'request_id', v_request.id,
                             'email', lower(p_email)));

  -- メール文面用の表示名 (auth.users 参照は SECURITY DEFINER 関数本体内のみ = 確立パターン)
  SELECT name INTO v_family_name FROM family_groups WHERE id = v_member.family_id;
  SELECT COALESCE(up.nickname, au.email) INTO v_requester_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = auth.uid();

  RETURN jsonb_build_object(
    'id',                  v_request.id,
    'family_id',           v_request.family_id,
    'member_id',           v_request.member_id,
    'member_display_name', v_member.display_name,
    'family_name',         v_family_name,
    'email',               v_request.email,
    'token',               v_request.token,
    'status',              v_request.status,
    'expires_at',          v_request.expires_at,
    'requester_name',      v_requester_name
  );
EXCEPTION
  WHEN deadlock_detected THEN
    -- #1232 v3 (G10): 他機能とのロック交差等で 40P01 になっても 500/UNKNOWN を漏らさず
    -- 再試行可能な競合 (409) として返す。副作用はサブトランザクションごと巻き戻り済み。
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;

-- ─── 10. accept_legal_documents を 4 引数に戻す ───
DROP FUNCTION IF EXISTS public.accept_legal_documents(text, text, inet, text, date);
CREATE OR REPLACE FUNCTION public.accept_legal_documents(
  p_terms_version   text,
  p_privacy_version text,
  p_ip              inet DEFAULT NULL,
  p_user_agent      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 版の形式。packages/shared/src/legal-versions.ts の LEGAL_VERSION_PATTERN と同じ
  -- (terms_acceptances.document_version は varchar(20)。形式外を通すと、切り詰めや桁あふれのエラーになる)
  IF p_terms_version IS NULL OR p_terms_version !~ '^[0-9A-Za-z._-]{1,20}$'
     OR p_privacy_version IS NULL OR p_privacy_version !~ '^[0-9A-Za-z._-]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_LEGAL_VERSION' USING ERRCODE = '22023';
  END IF;

  -- 1. 本人のプロフィールに、同意した版を入れる。
  --    行が無ければ既定値で作る (新規登録した人は初期設定より前に同意するので、行がまだ無い。#1273 と同じ形)。
  --    ON CONFLICT DO UPDATE は、WHERE が偽でも対象の行をロックする。同じ本人の同時の呼び出しはここで直列化され、
  --    後から来た方は、先に来た方が commit した後の状態を見る。
  --    版も同意日時も変わらないなら更新しない (同じ版の送り直しで、記録済みの同意日時を動かさない)。
  INSERT INTO public.user_profiles AS p (
    id, nickname, age_group, gender,
    terms_version_accepted, privacy_version_accepted, legal_accepted_at
  ) VALUES (
    v_uid, 'Guest', 'unspecified', 'unspecified',
    p_terms_version, p_privacy_version, v_now
  )
  ON CONFLICT (id) DO UPDATE
     SET terms_version_accepted   = EXCLUDED.terms_version_accepted,
         privacy_version_accepted = EXCLUDED.privacy_version_accepted,
         legal_accepted_at        = EXCLUDED.legal_accepted_at
   WHERE p.terms_version_accepted   IS DISTINCT FROM EXCLUDED.terms_version_accepted
      OR p.privacy_version_accepted IS DISTINCT FROM EXCLUDED.privacy_version_accepted
      OR p.legal_accepted_at IS NULL;

  -- 2. 同意の証跡を 1 文書ずつ残す。同じ (本人, 文書, 版) がすでにあれば足さない。
  --    terms_acceptances は UPDATE / DELETE 禁止の不可逆な記録なので、重複して増やさないことが後で効く。
  INSERT INTO public.terms_acceptances (user_id, document_type, document_version, accepted_at, ip_address, user_agent)
  SELECT v_uid, d.document_type, d.document_version, v_now, p_ip, left(p_user_agent, 512)
    FROM (VALUES
            ('terms_of_service', p_terms_version),
            ('privacy_policy',   p_privacy_version)
         ) AS d (document_type, document_version)
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.terms_acceptances AS t
            WHERE t.user_id          = v_uid
              AND t.document_type    = d.document_type
              AND t.document_version = d.document_version
         );

  RETURN (
    SELECT jsonb_build_object(
             'terms_version_accepted',   p.terms_version_accepted,
             'privacy_version_accepted', p.privacy_version_accepted,
             'legal_accepted_at',        p.legal_accepted_at
           )
      FROM public.user_profiles AS p
     WHERE p.id = v_uid
  );
END
$$;

REVOKE ALL ON FUNCTION public.accept_legal_documents(text, text, inet, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_legal_documents(text, text, inet, text)
  TO authenticated;

-- ─── 9. add_family_child を 3 引数に戻す ───
DROP FUNCTION IF EXISTS public.add_family_child(uuid, text, jsonb, date, text, text, boolean, inet, text);
CREATE OR REPLACE FUNCTION public.add_family_child(
  p_family_id UUID,
  p_display_name TEXT,
  p_child_profile JSONB
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_member family_members; v_count INT; v_limit INT; v_family_status TEXT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- 人数を数える前に、家族の行をロックする (#1213)。承諾 (accept_family_invite) や別の子供の追加が同時に走っても、
  -- この行を取り合って 1 件ずつ処理されるので、下の人数確認と INSERT の間に他のメンバーが入り込めない。
  -- 大人かどうかの確認は上で先に済ませてあるため、家族の外の人はこのロックを取れない。
  -- ロックを待つ間に解散された家族 (status <> 'active') や削除された家族には追加させない。
  SELECT member_limit, status INTO v_limit, v_family_status
    FROM family_groups WHERE id = p_family_id FOR UPDATE;
  IF NOT FOUND OR v_family_status <> 'active' THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_count FROM family_members
    WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (family_id, user_id, role, display_name, child_profile)
  VALUES (p_family_id, NULL, 'child', p_display_name, p_child_profile)
  RETURNING * INTO v_member;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'child_added', auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'display_name', p_display_name));

  RETURN v_member;
END $$;

REVOKE ALL ON FUNCTION public.add_family_child(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_family_child(uuid, text, jsonb) TO authenticated, service_role;

-- ─── 8. 特権列ガード 3 本を土台の定義に戻す ───
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
       OR NEW.legal_accepted_at        IS DISTINCT FROM OLD.legal_accepted_at
       OR NEW.plan_key_cached          IS DISTINCT FROM OLD.plan_key_cached THEN
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
       OR NEW.legal_accepted_at        IS NOT NULL
       OR NEW.plan_key_cached          IS NOT NULL THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_family_members_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    -- #1309: status / removed_at もログインユーザーは直接変更できない。退出・除名・解散は
    -- DEFINER RPC (leave_family / remove_family_member / operator_force_dissolve_family) か service_role だけが行う。
    -- 退出・除名済みの本人が自分の行を active に戻すと、招待の承諾も人数の上限の確認も通らずに家族へ戻れてしまう。
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.family_id IS DISTINCT FROM OLD.family_id
       OR NEW.user_id   IS DISTINCT FROM OLD.user_id
       OR NEW.status     IS DISTINCT FROM OLD.status
       OR NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;

    -- #1015: 共有設定 (share_meals/share_health/share_menu) は本人のみ直接 UPDATE 可。
    -- 子供メンバー等 (OLD.user_id IS NULL) は「本人」が存在しないため常に拒否され、
    -- 変更が必要な場合は DEFINER RPC 経由での対応が必要。
    IF auth.uid() IS DISTINCT FROM OLD.user_id THEN
      IF NEW.share_meals  IS DISTINCT FROM OLD.share_meals
         OR NEW.share_health IS DISTINCT FROM OLD.share_health
         OR NEW.share_menu   IS DISTINCT FROM OLD.share_menu THEN
        RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ─── 7. membership_audit_action_check を 26 値に戻す (parental_consent_* の行が残っていれば NOT VALID。行は消さない) ───
ALTER TABLE public.membership_audit DROP CONSTRAINT IF EXISTS membership_audit_action_check;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.membership_audit WHERE action IN ('parental_consent_recorded', 'parental_consent_revoked')) THEN
    ALTER TABLE public.membership_audit ADD CONSTRAINT membership_audit_action_check CHECK (action = ANY (ARRAY[
  'group_created', 'group_dissolved', 'invite_created', 'invite_accepted', 'invite_rejected', 'invite_revoked',
  'invite_expired', 'member_added', 'member_removed', 'member_left', 'child_added', 'child_promoted', 'role_changed',
  'owner_transfer_proposed', 'owner_transferred', 'owner_transfer_declined', 'representative_transfer_proposed',
  'representative_transferred', 'representative_transfer_declined', 'operator_force_owner_transfer',
  'operator_force_representative_transfer', 'operator_force_dissolve', 'paste_executed', 'child_promotion_requested',
  'child_promotion_rejected', 'child_promotion_revoked'
]::text[])) NOT VALID;
  ELSE
    ALTER TABLE public.membership_audit ADD CONSTRAINT membership_audit_action_check CHECK (action = ANY (ARRAY[
  'group_created', 'group_dissolved', 'invite_created', 'invite_accepted', 'invite_rejected', 'invite_revoked',
  'invite_expired', 'member_added', 'member_removed', 'member_left', 'child_added', 'child_promoted', 'role_changed',
  'owner_transfer_proposed', 'owner_transferred', 'owner_transfer_declined', 'representative_transfer_proposed',
  'representative_transferred', 'representative_transfer_declined', 'operator_force_owner_transfer',
  'operator_force_representative_transfer', 'operator_force_dissolve', 'paste_executed', 'child_promotion_requested',
  'child_promotion_rejected', 'child_promotion_revoked'
]::text[]));
  END IF;
END $$;

-- ─── 4. parental_consents ───
DROP TABLE IF EXISTS public.parental_consents;

-- ─── 2. family_members.birth_date ───
DROP INDEX IF EXISTS public.idx_family_members_child_birth_date;
ALTER TABLE public.family_members DROP CONSTRAINT IF EXISTS family_members_child_birth_date_required;
ALTER TABLE public.family_members DROP COLUMN IF EXISTS birth_date;

-- ─── 1. user_profiles.birth_date ───
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS birth_date;
