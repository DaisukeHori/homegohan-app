-- migration: 20261015120000_accept_copies_profile_name.sql
-- Issue #1584 の 2: 家族の招待を承諾したメンバーの display_name に、本人のプロフィールの名前を写す
--
-- 背景:
--   accept_family_invite は family_members の行を display_name なし (NULL) で作っていた。家族の画面は
--   display_name → プロフィールの今の名前 → 「名前未設定」の順で名前を決める (#1607。GET /api/family/members/names) が、
--   メンバーの行そのものには名前が残らず、display_name だけを読む所 (週間献立の家族の表示の切り替え src/components/membership/FamilyViewSwitcher.tsx) では
--   名前が無いままだった。
--
-- 変更 (2 関数。どちらも CREATE OR REPLACE。signature・戻り値・SECURITY DEFINER・search_path = public・所有者は現行のまま):
--   1. accept_family_invite: メンバーの行を INSERT するとき、承諾した本人の user_profiles.nickname を display_name に入れる。
--   2. accept_child_promotion: 子供の行を本人のアカウントに付け替えるとき、display_name が空 (NULL・空白だけ) なら同じく入れる。
--      子供のときの呼び名が入っていれば上書きしない。
--   名前の判定は @homegohan/shared の normalizeProfileName (packages/shared/src/profile-name.ts) と同じ:
--     前後の空白 (JavaScript の String.prototype.trim が除く文字と同じ集合) を除き、空なら名前なし。
--     仮置きの 'Guest' (前後の空白を除いて厳密一致) も名前なし。名前なしのときは写さない (NULL のまま)。
--     プロフィールの行がまだ無い人 (初期設定より前に承諾した人。行は承諾の中で 'Guest' で作られる) も写さない。
--   写すのは前後の空白を除いた名前。後でプロフィールの名前を変えても、写した display_name は変わらない
--   (家族の画面は display_name を先に出す)。
--   本文は、名前を読む SELECT と、INSERT / UPDATE の display_name の列を足した以外は 20261008090100_family_lock_order.sql の定義のまま
--   (ロックの順番・エラーを返す順番・プロフィールの行を作る処理・監査は変えない)。
--
-- 組織の招待 (accept_org_invite) は変えない: 組織の所属は user_profiles の列 (organization_id / org_role) で持ち、
--   メンバーごとの display_name の列が無い (名前はプロフィールの nickname そのもの)。
--
-- 実行権限: CREATE OR REPLACE のため、EXECUTE 権限は本番の現行 (supabase/baseline/prod_function_acl.sql) のまま
--   (20261008090100 と同じく REVOKE / GRANT は流さない)。
-- 既存データへの影響: なし (関数の本文だけを置き換える)。承諾済みで display_name が NULL の行は埋めない
--   (埋めるかどうかは件数を確かめてから別に決める。読み取りと書き込みの SQL の案は docs/operations/family-member-display-name-backfill.md)。
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて適用してもエラーにならない。
-- 戻し方: supabase/rollbacks/20261015120000_accept_copies_profile_name.down.sql
--   (20261008090100_family_lock_order.sql の定義 = 名前を写さない形に戻す)
-- 確かめるテスト:
--   tests/integration/security/family-accept-display-name.test.ts (実 DB: 写る・Guest / 空白だけ / 行なしは写さない・既存の呼び名を上書きしない)
--   tests/accept-copies-profile-name-migration-contract.test.ts (ファイルどうしの突き合わせ。DB 無し)

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
