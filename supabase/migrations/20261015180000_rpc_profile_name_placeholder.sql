-- migration: 20261015180000_rpc_profile_name_placeholder.sql
-- Issue #1678 (#1649 の残り): SQL の RPC が、プロフィールの名前の仮置き 'Guest' を名前として返さないようにする
--
-- 背景:
--   名前が無いまま user_profiles を作る・更新するとき、アプリと RPC は nickname に仮置きの 'Guest' を入れる
--   (@homegohan/shared の PROFILE_NAME_PLACEHOLDER。packages/shared/src/profile-name.ts)。
--   #1649 で TS 側 (API・通知・メール・AI 入力) は normalizeProfileName で「名前が無い」とそろえたが、
--   SQL の RPC の中で nickname をそのまま名前として返す所が 3 つ残っていた。
--     (a) get_invite_details: 招待した人の名前 (invited_by_name) を COALESCE(up.nickname, au.email) で返す。
--         nickname が 'Guest' だと 'Guest' が返り、Web の招待ページ (src/app/invite/[token]/page.tsx) に
--         「Guest 様から招待が届いています」と出る。メールアドレスへのフォールバックが効かない。
--     (b) get_promotion_details: 昇格を依頼した人の名前 (requested_by_name) が同じ形
--         (src/app/family/promotions/[token]/page.tsx に「Guest 様から」と出る)。
--     (c) create_family_group: 作成者の nickname を family_members.display_name にそのまま写す。
--         仮置きの人が家族を作ると display_name が 'Guest' になる
--         (src/lib/membership/family-member-names.ts の「display_name の側は仮置きを入れる経路が無い」と食い違う)。
--   (a)(b) は画面にメールアドレスが無いので、画面の側で弾くとフォールバックできない。RPC の中で判定する。
--
-- 変更:
--   1. 関数 public.normalize_profile_name(text) を足す。判定は @homegohan/shared の normalizeProfileName と同じ:
--        前後の空白 (JavaScript の String.prototype.trim が除く文字と同じ集合。20261015170000_accept_copies_profile_name.sql と同じ) を除き、
--        空なら NULL、仮置きの 'Guest' (前後の空白を除いて厳密一致。大小を区別する) も NULL、それ以外は前後の空白を除いた名前。
--        NULL を渡すと NULL を返す。IMMUTABLE・SECURITY INVOKER・search_path は空 (pg_catalog の関数だけを使う)。
--   2. get_invite_details (組織・家族の両方の分岐) と get_promotion_details: 名前を
--        COALESCE(public.normalize_profile_name(up.nickname), au.email) にする。名前が無ければ、今の SQL の意図どおりメールアドレスを返す。
--   3. create_family_group: family_members.display_name に写す名前を normalize_profile_name(nickname) にする。
--        名前が無ければ NULL (accept_family_invite の #1584 と同じ扱い。家族の画面は display_name → プロフィールの今の名前 → 「名前未設定」の順)。
--   3 つの RPC の本文は、名前の式とそのコメントの行を変えた以外は、最後に定義した 20251126124224_create_meal_planner_tables.sql
--   (本番のベースライン。supabase/baseline/prod_schema.sql と同じ本文) のまま。signature・戻り値・SECURITY DEFINER・
--   search_path = public・所有者・ロックの有無と順番・エラーの順番・監査は変えない
--   (3 つとも家族の行をロックしない関数で、CLAUDE.md の「家族 (family_*) を変える関数のロック順」の一覧の外。今もロックしない)。
--
-- 実行権限:
--   normalize_profile_name: Supabase の既定の権限 (anon / authenticated / service_role への EXECUTE) と PUBLIC の EXECUTE を
--     引数の型まで含めた完全形で外し、service_role にだけ付ける (#1039 / #1020 の定型)。
--     3 つの RPC は SECURITY DEFINER (所有者 postgres の権限で動く) なので、呼び出し元のロールに EXECUTE が無くても中で呼べる。
--     service_role は結合テスト (tests/integration/security/rpc-profile-name-placeholder.test.ts) が TS の判定との突き合わせに直接呼ぶ。
--   3 つの RPC: CREATE OR REPLACE のため、EXECUTE 権限は本番の現行 (supabase/baseline/prod_function_acl.sql) のまま。
-- 既存データへの影響: なし (関数を足し、関数の本文を置き換えるだけ)。
--   本番の family_members は 2026-10-15 時点で 0 行 (display_name が 'Guest' の行も 0 件) のため、既存の行は書き換えない。
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- 戻し方: supabase/rollbacks/20261015180000_rpc_profile_name_placeholder.down.sql
--   (3 つの RPC を 20251126124224_create_meal_planner_tables.sql の定義に戻してから、normalize_profile_name を消す)
-- 確かめるテスト:
--   tests/integration/security/rpc-profile-name-placeholder.test.ts (実 DB: 3 つの RPC・normalize_profile_name と normalizeProfileName の突き合わせ)
--   tests/rpc-profile-name-placeholder-migration-contract.test.ts (ファイルどうしの突き合わせ。DB 無し)

CREATE OR REPLACE FUNCTION public.normalize_profile_name(p_value TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT NULLIF(NULLIF(btrim(p_value, E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'), ''), 'Guest')
$$;

COMMENT ON FUNCTION public.normalize_profile_name(TEXT) IS
  '#1678: プロフィールの名前 (user_profiles.nickname) を整える。前後の空白 (JavaScript の trim と同じ文字) を除き、空・仮置きの ''Guest'' は NULL。@homegohan/shared の normalizeProfileName と同じ判定。';

REVOKE ALL ON FUNCTION public.normalize_profile_name(TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.normalize_profile_name(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION "public"."get_invite_details"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org_invite  organization_invites;
  v_fam_invite  family_invites;
  v_org_name    TEXT;
  v_fam_name    TEXT;
  v_invited_by_name TEXT;
  v_is_existing BOOLEAN;
  v_email_matches BOOLEAN;
BEGIN
  -- org 招待を検索
  SELECT * INTO v_org_invite
    FROM organization_invites
    WHERE token = p_token;

  IF FOUND THEN
    -- 組織名
    SELECT name INTO v_org_name FROM organizations WHERE id = v_org_invite.organization_id;

    -- 招待者名
    -- #1678: 仮置きの 'Guest'・空白だけの名前は名前なしとして、メールアドレスにフォールバックする
    SELECT COALESCE(public.normalize_profile_name(up.nickname), au.email) INTO v_invited_by_name
      FROM user_profiles up
      JOIN auth.users au ON au.id = up.id
      WHERE up.id = v_org_invite.invited_by;

    -- 既存ユーザー判定
    SELECT EXISTS(SELECT 1 FROM auth.users WHERE lower(email) = lower(v_org_invite.email))
      INTO v_is_existing;

    -- caller の email 一致判定
    v_email_matches := FALSE;
    IF auth.uid() IS NOT NULL THEN
      SELECT lower(au.email) = lower(v_org_invite.email)
        INTO v_email_matches
        FROM auth.users au WHERE au.id = auth.uid();
    END IF;

    RETURN jsonb_build_object(
      'scope',                   'organization',
      'scope_id',                v_org_invite.organization_id,
      'scope_name',              v_org_name,
      'role',                    v_org_invite.invited_role,
      'invited_by_name',         v_invited_by_name,
      'expires_at',              v_org_invite.expires_at,
      'email',                   v_org_invite.email,
      'status',                  v_org_invite.status,
      'is_existing_user',        v_is_existing,
      'current_user_email_matches', v_email_matches
    );
  END IF;

  -- family 招待を検索
  SELECT * INTO v_fam_invite
    FROM family_invites
    WHERE token = p_token;

  IF FOUND THEN
    -- 家族名
    SELECT name INTO v_fam_name FROM family_groups WHERE id = v_fam_invite.family_id;

    -- 招待者名
    -- #1678: 仮置きの 'Guest'・空白だけの名前は名前なしとして、メールアドレスにフォールバックする
    SELECT COALESCE(public.normalize_profile_name(up.nickname), au.email) INTO v_invited_by_name
      FROM user_profiles up
      JOIN auth.users au ON au.id = up.id
      WHERE up.id = v_fam_invite.invited_by;

    -- 既存ユーザー判定
    SELECT EXISTS(SELECT 1 FROM auth.users WHERE lower(email) = lower(v_fam_invite.email))
      INTO v_is_existing;

    -- caller の email 一致判定
    v_email_matches := FALSE;
    IF auth.uid() IS NOT NULL THEN
      SELECT lower(au.email) = lower(v_fam_invite.email)
        INTO v_email_matches
        FROM auth.users au WHERE au.id = auth.uid();
    END IF;

    RETURN jsonb_build_object(
      'scope',                   'family',
      'scope_id',                v_fam_invite.family_id,
      'scope_name',              v_fam_name,
      'role',                    v_fam_invite.invited_role,
      'invited_by_name',         v_invited_by_name,
      'expires_at',              v_fam_invite.expires_at,
      'email',                   v_fam_invite.email,
      'status',                  v_fam_invite.status,
      'is_existing_user',        v_is_existing,
      'current_user_email_matches', v_email_matches
    );
  END IF;

  -- 見つからない場合 NULL
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION "public"."get_promotion_details"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_request family_promotion_requests;
  v_family_name TEXT;
  v_member_name TEXT;
  v_requested_by_name TEXT;
  v_email_matches BOOLEAN;
BEGIN
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN NULL; -- 見つからない場合 NULL (get_invite_details と同じ)
  END IF;

  SELECT name INTO v_family_name FROM family_groups WHERE id = v_request.family_id;
  SELECT display_name INTO v_member_name FROM family_members WHERE id = v_request.member_id;
  -- #1678: 仮置きの 'Guest'・空白だけの名前は名前なしとして、メールアドレスにフォールバックする
  SELECT COALESCE(public.normalize_profile_name(up.nickname), au.email) INTO v_requested_by_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = v_request.requested_by;

  v_email_matches := FALSE;
  IF auth.uid() IS NOT NULL THEN
    SELECT lower(au.email) = lower(v_request.email)
      INTO v_email_matches
      FROM auth.users au WHERE au.id = auth.uid();
  END IF;

  RETURN jsonb_build_object(
    'family_name', v_family_name,
    'member_display_name', v_member_name,
    'requested_by_name', v_requested_by_name,
    'email', v_request.email,
    'status', v_request.status,
    'expires_at', v_request.expires_at,
    'current_user_email_matches', v_email_matches
  );
END $$;

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

