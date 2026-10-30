-- migration: 20261031100000_create_organization_owner_joined_at.sql
-- 戻し方: supabase/rollbacks/20261031100000_create_organization_owner_joined_at.down.sql
-- #2120 W1: 運営が作った組織のオーナーの加入日 (joined_org_at) が空で、組織のメンバーの一覧 (/org/members) で「-」と出て、
-- 一覧の最後に並ぶ既存の欠陥を直す。
--
-- 背景:
--   運営の組織の作成 (POST /api/admin/organizations が service_role で呼ぶ DB 関数 admin_create_organization。
--   20261030150000_create_organization_atomic.sql) は、オーナーの user_profiles に organization_id と org_role = 'owner' の 2 列だけを
--   書き、joined_org_at (加入日) と is_active_in_org を書いていなかった (その前の route も同じ 2 列だけ)。
--   招待の承諾 (accept_org_invite) は所属と一緒に joined_org_at = CURRENT_DATE・is_active_in_org = TRUE を書く。
--   メンバーの一覧の API (src/app/api/org/members/route.ts の GET) は joined_org_at の昇順で並べるので、NULL のオーナーが最後になり、
--   画面 (src/app/(org)/org/members/page.tsx) は NULL の加入日を「-」と出していた。
--
-- 変更 (この migration は関数 admin_create_organization を CREATE OR REPLACE で作り直すだけ。表・トリガー・ポリシー・行は変えない):
--   - オーナーの所属を書く UPDATE に joined_org_at = CURRENT_DATE と is_active_in_org = TRUE を足す (招待の承諾と同じ値)。
--     ほかの本文 (組織の行の INSERT → プロフィールの行が無ければ作る → オーナーの行を FOR NO KEY UPDATE で読んで所属を確かめる →
--     所属を書く → 席の行 → 戻り値)・引数・戻り値・SECURITY DEFINER・search_path・EXECUTE の権限は 20261030150000 の定義のまま
--
-- 既存データへの影響: なし (関数を作り直すだけ)。すでに加入日が空のオーナーの行は埋め戻さない (データの移行なので別に扱う)。
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- ロック: 表には触れない (関数の作成とカタログの権限だけ)。
-- 確かめるテスト: tests/integration/security/org-create-atomic.test.ts の OC-11 (実 DB・route)・
--   tests/create-organization-owner-joined-at-migration-contract.test.ts (文面)・
--   tests/create-organization-atomic-migration-contract.test.ts (最新の定義の本文の順・権限)
-- ロールバック: supabase/rollbacks/20261031100000_create_organization_owner_joined_at.down.sql

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.admin_create_organization(p_name text, p_plan text, p_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org organizations;
  v_owner_org_id uuid;
BEGIN
  -- a. 新しい組織の行 (CLAUDE.md の組織のロック順の (2))。退会の手続き中のオーナーは BEFORE INSERT のトリガー
  --    trg_organizations_owner_not_deleting が OWNER_ACCOUNT_DELETING で止める (オーナーの id の advisory lock をここで取る)
  INSERT INTO organizations (name, plan, owner_id)
  VALUES (p_name, p_plan, p_owner_id)
  RETURNING * INTO v_org;

  -- b. オーナーの user_profiles の行が無ければ仮置きの値で作る (初期設定の前の人。20261007150200 の accept_org_invite と同じ値)。
  --    行があるときは何もしない (名前などの列を書き換えない)
  INSERT INTO user_profiles (id, nickname, age_group, gender)
  VALUES (p_owner_id, 'Guest', 'unspecified', 'unspecified')
  ON CONFLICT (id) DO NOTHING;

  -- c. オーナーの user_profiles の行をロックしてから所属を確かめる (CLAUDE.md の組織のロック順の (3))。
  --    同じオーナーの別の作成がこの行を持っていれば、その commit を待ってから、その作成が書いた所属を読む
  SELECT organization_id INTO v_owner_org_id
  FROM user_profiles
  WHERE id = p_owner_id
  FOR NO KEY UPDATE;

  IF v_owner_org_id IS NOT NULL THEN
    RAISE EXCEPTION 'OWNER_ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- d. オーナーの所属。招待の承諾 (accept_org_invite) と同じく、加入日 (今日) と在籍の印も書く
  --    (加入日が空だと、メンバーの一覧で「-」と出て、加入日の昇順の並びの最後になる。#2120 W1)
  UPDATE user_profiles
  SET organization_id = v_org.id,
      org_role = 'owner',
      joined_org_at = CURRENT_DATE,
      is_active_in_org = TRUE
  WHERE id = p_owner_id;

  -- e. 席の行 (CLAUDE.md の組織のロック順の (4))。上限なし・使用 0 (以前の route と同じ値)
  INSERT INTO org_license_pools (organization_id, total_licenses, used_licenses)
  VALUES (v_org.id, NULL, 0);

  RETURN jsonb_build_object(
    'id', v_org.id,
    'name', v_org.name,
    'plan', v_org.plan,
    'owner_id', v_org.owner_id,
    'created_at', v_org.created_at,
    'updated_at', v_org.updated_at
  );
END $$;

COMMENT ON FUNCTION public.admin_create_organization(text, text, uuid) IS
  '運営の組織の作成 (POST /api/admin/organizations が service_role で呼ぶ)。組織の行・オーナーの所属 (organization_id・org_role = owner・加入日 joined_org_at = 今日・is_active_in_org = true)・席の行 (上限なし・使用 0) を 1 つのトランザクションで書く。オーナーの user_profiles の行を FOR NO KEY UPDATE で読み、すでに組織に所属していれば何も書かずに OWNER_ALREADY_IN_ORG で止める (同じオーナーの同時の作成は 1 つだけ通る)。プロフィールの行が無ければ仮置きの値で作る。戻り値は作った組織の id・name・plan・owner_id・created_at・updated_at。#2107 #2120';

REVOKE ALL ON FUNCTION public.admin_create_organization(text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_organization(text, text, uuid) TO service_role;
