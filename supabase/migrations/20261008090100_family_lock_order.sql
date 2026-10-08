-- migration: 20261008090100_family_lock_order.sql
-- Issue #1310: 家族の解散・削除と、招待の承諾などが同時に走ると、解散済みの家族に active のメンバーが残る / デッドロックする問題を直す
--
-- 背景:
--   家族を変える関数が行ロックを取る順番がばらばらで、同時に走ると次の 2 つが起きていた (#1213 の作業中にローカルで再現。8 回中 7 回)。
--   1. 運営の強制解散 (operator_force_dissolve_family) と、招待の承諾 (accept_family_invite) や子供の追加 (add_family_child) が
--      同時に走ると、解散済みの家族に active のメンバーが残る。
--      解散は family_members → user_profiles → family_groups の順に更新し、家族の行は最後に更新するだけで、最初にはロックしない。
--      承諾・子供の追加は、家族の行を FOR UPDATE でロックしてからメンバーを INSERT する (#1213)。
--      解散が「承諾の INSERT がまだ見えない」うちにメンバーを left にし、そのあと家族の行の更新だけが承諾のコミットを待って通ると、
--      承諾した人だけが active のまま残る (家族は dissolved)。
--   2. 代表者が家族を DELETE する (RLS の family_groups_delete_representative + CASCADE) と、招待の承諾が同時に走ると、デッドロックする (40P01)。
--      DELETE は 家族の行 → 招待の行 (CASCADE) の順に取るが、承諾は 招待の行 → 家族の行 の順に取るため、お互いの行を待ち合う。
--   どちらも #1213 (20261007160000) の時点で既知の未対応として残していた。解散だけを「家族の行を先に」に変えると、
--   家族の行を最後に取る関数 (代表者の移譲承諾など) と逆向きになって別のデッドロックが起きるため、関数ごとにそろえる必要があった。
--
-- 方針: ロックの順番を 1 つに決め、家族に関わる関数をすべてそれに合わせる。
--     1. family_groups (家族) の行
--     2. 子の行: family_invites (招待) / ownership_transfer_proposals (移譲の提案) / family_members / family_promotion_requests / user_profiles
--   家族の行を最初にロックした関数どうしは、その 1 行を取り合って 1 件ずつ処理される。家族の行を最初に取る関数は、別の関数が
--   家族の行を持っている間は何も持たずに待つので、お互いを待ち合うことがなくなる。ロックする行は家族ごとなので、別の家族どうしは待ち合わない。
--
-- 変更 (7 関数。どれも CREATE OR REPLACE。signature・戻り値・属性 (SECURITY DEFINER・search_path = public) は現行のまま。
--       本文は、家族の行のロックを足す・取る順番を入れ替える・ロックのあとで状態を確かめ直す、以外は変えない):
--   1. accept_family_invite: 招待の行 (FOR UPDATE) を取る前に、招待の宛先の家族の行をロックする。
--        招待の行 → 家族の行 の順だったのを 家族の行 → 招待の行 にする。招待の family_id は変わらない列なので、
--        最初にロックなしで読んで家族の行を取り、そのあと招待の行を取り直す (招待が無ければ従来どおり INVITE_NOT_FOUND)。
--        エラーを返す順番は変えない (INVITE_* → ALREADY_IN_FAMILY → FAMILY_NOT_FOUND → MEMBER_LIMIT_EXCEEDED)。
--        家族が削除された場合は、招待も CASCADE で消えるので INVITE_NOT_FOUND (削除の完了を待ったあと)。
--   2. operator_force_dissolve_family: 最初に家族の行をロックする。以降 (メンバーを left → プロフィールの family_id を外す →
--        家族を dissolved) は従来どおり。承諾・子供の追加が先にロックを持っていれば、その完了を待ってから (コミット済みの
--        メンバーも見える状態で) 全員を left にするので、解散済みの家族に active が残らない。
--   3. operator_force_representative_transfer: 最初に家族の行をロックし、旧代表者もそのロック下で読む。
--        新代表者が今も家族の active な代表者・大人かの確認はロックのあとに行う (従来は確認がロックより前だった)。
--        解散・削除と同時だと、解散済みの家族の representative_id を書き換えていた。
--   4. accept_family_representative_transfer: 移譲の提案を読んだあと、メンバーを書き換える前に家族の行をロックする。
--        承諾者が今も家族の active な代表者・大人かの確認 (#1237) はロックのあとに行う。
--        メンバー → 家族の行 の順だったのを 家族の行 → 提案 → メンバー にする。
--   5. leave_family: 最初に自分の所属する家族の id をロックなしで読み、家族の行をロックしてから、従来の確認と更新を行う。
--   6. remove_family_member: 呼び出し者が家族の大人かの確認 (従来どおり。家族の外の人は、ロックを取る前に NOT_FAMILY_ADULT で弾く)
--        のあとで家族の行をロックし、もう一度同じ確認をしてから、従来の確認と更新を行う。
--   7. accept_child_promotion: 昇格のリクエストを読んだあと、メンバーの行を取る前に家族の行をロックする。
--        メンバー → 参加リクエスト → (プロフィールの family_id の外部キー確認で家族の行) の順だったのを 家族の行 → メンバー →
--        参加リクエスト にする。
--   ロックのあとで家族が解散・削除されていたときの結果は、解散・削除のあとに呼んだときと同じ既存のエラーになる
--   (NOT_IN_FAMILY / NOT_FAMILY_ADULT / TARGET_NOT_IN_FAMILY / TRANSFER_ACCEPTOR_NOT_IN_FAMILY / PROMOTION_MEMBER_UNAVAILABLE /
--    FAMILY_NOT_FOUND)。API ルート側は、これらのエラーコードをすでに扱っているので変更しない。
--
-- ロックの強さ: FOR NO KEY UPDATE。
--   外部キーの確認 (family_members / family_invites / family_promotion_requests の INSERT、user_profiles.family_id の更新) が家族の行に取る
--   FOR KEY SHARE と衝突しない、いちばん強いロック。FOR UPDATE にすると、先に子の行を持ってから外部キーの確認で家族の行を取る関数と、
--   新たに逆向きに待ち合ってデッドロックする。
--     - create_family_invite: 既存の招待を revoke (招待の行) → 新しい招待を INSERT (家族の行を FOR KEY SHARE)。#1213 では承諾と同じ向きに
--       そろえてあった。承諾を 家族の行 → 招待の行 にしたいま、承諾が FOR UPDATE だと、再招待と承諾が同時に走ったときに逆向きになる。
--     - request_child_promotion: メンバーの行 → 参加リクエストの INSERT (家族の行を FOR KEY SHARE)。
--   FOR NO KEY UPDATE どうし、および子供の追加が使う FOR UPDATE (#1213) とは衝突するので、
--   人数の確認と INSERT の間にほかのメンバーが入り込めない保証 (#1213) は変わらない。
--   accept_family_invite は #1213 では FOR UPDATE だったが、上の理由でこの強さに下げる。add_family_child は FOR UPDATE のまま (変えない)。
--   FOR UPDATE に置き換えると、テスト (D1 / D2 / D3 / N6) がデッドロックすることをローカルで確かめてある。
--
-- 代表者による家族の削除 (RLS の DELETE ポリシー + CASCADE) は、コードを変えない:
--   DELETE 文は最初に家族の行を取り、そのあとで CASCADE が子の行 (招待・メンバー・参加リクエスト・プロフィール) を消すので、
--   もともと 家族の行 → 子の行 の順になっている。RPC やトリガーに置き換えても順番は変わらず、動いている経路を変えるリスクだけが増える。
--   上の 7 関数が 家族の行を先に取るようになったので、削除と同時に走っても、削除が終わるまで (または削除が先に終わっていればその結果を見て)
--   どちらかが何も持たずに待つだけになる。
--
-- 次は変更しない:
--   - add_family_child: すでに 家族の行 (FOR UPDATE) → メンバーの順 (#1213)。
--   - create_family_invite / request_child_promotion / revoke_child_promotion / reject_child_promotion: 子の行を先に取る関数。
--     この migration の 7 関数と同時に走ってもデッドロックしない (上記のとおり、家族の行を取る強さが外部キーの確認と衝突しない)。
--     別の PR (#1163 の続き) が create_family_invite / request_child_promotion の本文を書き換え中のため、ここでは触らない。
--   - leave_family / remove_family_member 以外のメンバー・プロフィールの書き込み (update_my_share_settings など。1 行しか持たない)。
--   - 運営の権限確認 (operator_force_* の NOT_OPERATOR) の書き方。
--   次は既知の未対応 (修正前から同じで、この migration では直さない):
--   - 代表者の DELETE と create_family_invite (同じメールへ再招待する場合) / request_child_promotion が同時に走ると、まれにデッドロックし得る
--     (どちらも子の行 → 家族の行の外部キー確認の順。request_child_promotion は 40P01 を CONFLICT_RETRY に置き換える)。
--   - アカウント削除 (auth.users の削除 → family_members / user_profiles の CASCADE) と運営の強制解散が同時に走る場合
--     (CASCADE が子の行を取る順番しだいで、デッドロックし得る。再現は確かめていない)。
--
-- 実行権限: CREATE OR REPLACE のため、所有者と EXECUTE 権限は本番の現行 (supabase/baseline/prod_function_acl.sql) のまま
--   (REVOKE / GRANT は流さない)。
-- 既存データへの影響: なし (関数の本文だけを置き換える。データの更新・削除はしない)。
--
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/family-lock-order-race.test.ts
--       (先の処理を開いたままにする再現 + 本物の経路を同時に 8 回ずつ呼ぶ。修正前は解散済みの家族に active が残り、デッドロックする)
-- ロールバック: supabase/rollbacks/20261008090100_family_lock_order.down.sql

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

CREATE OR REPLACE FUNCTION public.operator_force_dissolve_family(p_family_id UUID, p_reason TEXT)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。
  -- 最初に家族の行をロックする (従来は最後に更新するだけだった)。承諾・子供の追加など、家族の行を先に取った処理が
  -- 途中であれば、その完了を待ってから以降のメンバーの更新を始めるので、コミット済みのメンバーも全員 left にできる。
  -- 家族の行が無ければ何もせず、従来どおり以降の UPDATE は 0 行のまま v_fam が NULL で返る。
  PERFORM 1 FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

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

CREATE OR REPLACE FUNCTION public.operator_force_representative_transfer(p_family_id UUID, p_new_rep_id UUID, p_reason TEXT)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_old_rep_id UUID;
  v_caller_roles TEXT[];
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members。
  -- 最初に家族の行をロックし、旧代表者もこのロック下で読む (従来は新代表者の確認と旧代表者の取得がロックより前で、
  -- 家族の行は最後に更新するだけだった)。家族の行が無ければ v_old_rep_id は NULL のままで、次の確認が TARGET_NOT_IN_FAMILY になる。
  SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = p_family_id AND user_id = p_new_rep_id
      AND status = 'active' AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

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

CREATE OR REPLACE FUNCTION public.leave_family()
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member family_members;
  v_family_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。
  -- メンバーの行を書き換える前に、所属する家族の行をロックする (従来は メンバー → プロフィール の順で、家族の行は取らなかった)。
  -- まず所属する家族の id だけをロックなしで読み、ロックのあとで下の確認と更新をやり直す
  -- (ロックを待つ間に解散・削除・脱退・代表者の交代があっても、最新の状態で判定する)。
  SELECT family_id INTO v_family_id FROM family_members WHERE user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM family_groups WHERE id = v_family_id FOR NO KEY UPDATE;

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

CREATE OR REPLACE FUNCTION public.remove_family_member(p_family_id UUID, p_member_id UUID)
RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_target family_members;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。
  -- メンバーの行を書き換える前に家族の行をロックする (従来は メンバー → プロフィール の順で、家族の行は取らなかった)。
  -- 家族の外の人は上の確認でロックを取る前に弾く。ロックを待つ間に解散・削除・退会があっても最新の状態で判定できるよう、
  -- ロックのあとで呼び出し者の確認をもう一度行う。
  PERFORM 1 FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

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
