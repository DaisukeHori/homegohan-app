-- migration: 20261030150000_create_organization_atomic.sql
-- 戻し方: supabase/rollbacks/20261030150000_create_organization_atomic.down.sql
-- #2107 Y4: 運営の組織の作成 (POST /api/admin/organizations) で、同じオーナーの組織が 2 つできうる既存の欠陥を直す。
--
-- 背景:
--   route (src/app/api/admin/organizations/route.ts) は、service_role で次を別々の要求として行っていた:
--     (1) オーナーの user_profiles の organization_id を読む (所属していれば 409 OWNER_ALREADY_IN_ORG)
--     (2) organizations の行を INSERT  (3) org_license_pools の行を INSERT  (4) オーナーの user_profiles を UPDATE (organization_id・org_role = 'owner')
--   (1) と (4) の間に同じオーナーの 2 つ目の作成が (1) を通ると、組織が 2 つでき、user_profiles.organization_id は後の方を指す
--   (先の組織は孤立する)。(4) が失敗すると 500 を返すが (2) の組織は残り、運営が押し直すと確実に 2 つ目ができた。
--   organizations.owner_id に一意の制約は無い (ベースラインの idx_organizations_owner_id は通常の index)。
--
-- 変更 (この migration は関数を 1 本足すだけ。表・トリガー・ポリシー・既存の関数・行は変えない):
--   public.admin_create_organization(p_name text, p_plan text, p_owner_id uuid) RETURNS jsonb
--     - 組織の行・席の行・オーナーの所属を 1 つのトランザクションで書く。途中で止まれば (RAISE・制約の違反) 全部が戻る
--     - 順 (CLAUDE.md の組織のロック順: (2) 組織の行 → (3) user_profiles → (4) org_license_pools):
--         a. organizations の行を INSERT する (新しい行。BEFORE INSERT のトリガーが従来どおり、退会の手続き中のオーナーを
--            OWNER_ACCOUNT_DELETING で止め (20261023130000。オーナーの id の advisory lock を取る)、プランの行に FOR KEY SHARE を取る (20261024130000))
--         b. オーナーの user_profiles の行が無ければ (初期設定の前の人) 仮置きの値 ('Guest' / 'unspecified') で作る
--            (20261007150200 の accept_org_invite と同じ。行が無いと所属を書けず、所属の確認も素通りする)
--         c. オーナーの user_profiles の行を FOR NO KEY UPDATE で読み、すでに組織に所属していれば OWNER_ALREADY_IN_ORG (P0001) で止める
--            (a の組織の行も戻る)。同じオーナーの同時の作成は、この行のロック (と a のトリガーの advisory lock) で直列になり、
--            後の方は先の方の commit を待ってから、先の方が書いた所属を読んで止まる
--         d. オーナーの user_profiles に organization_id と org_role = 'owner' を書く (以前の route の (4) と同じ 2 列)
--         e. org_license_pools の行を INSERT する (total_licenses = NULL (上限なし)・used_licenses = 0。以前の route の (3) と同じ値。
--            以前は失敗してもログだけで続けたが、ここでは失敗すれば作成全体が戻る)
--     - 戻り値は作った組織の id・name・plan・owner_id・created_at・updated_at (以前の route の応答の organization と同じ列)
--     - SECURITY DEFINER (所有者 postgres の権限で書く)・search_path = public
--     - EXECUTE は service_role だけ (PUBLIC・anon・authenticated から外す。運営の作成 API が service_role で呼ぶ)
--   route はこの関数を呼ぶだけにし、OWNER_ALREADY_IN_ORG / OWNER_ACCOUNT_DELETING を今までの 409 に写す。
--
-- 既存データへの影響: なし (関数を足すだけ。すでにある同じオーナーの重複した組織は消さない)。
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- ロック: 表には触れない (関数の作成とカタログの権限だけ)。
-- 確かめるテスト: tests/integration/security/org-create-atomic.test.ts (実 DB・route。同時の作成は 1 つだけ通る)・
--   tests/create-organization-atomic-migration-contract.test.ts (文面)・
--   tests/admin-organizations-create-atomic-route-2107.test.ts (route)
-- ロールバック: supabase/rollbacks/20261030150000_create_organization_atomic.down.sql

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

  -- d. オーナーの所属 (以前の route と同じ 2 列)
  UPDATE user_profiles
  SET organization_id = v_org.id, org_role = 'owner'
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
  '運営の組織の作成 (POST /api/admin/organizations が service_role で呼ぶ)。組織の行・オーナーの所属 (organization_id・org_role = owner)・席の行 (上限なし・使用 0) を 1 つのトランザクションで書く。オーナーの user_profiles の行を FOR NO KEY UPDATE で読み、すでに組織に所属していれば何も書かずに OWNER_ALREADY_IN_ORG で止める (同じオーナーの同時の作成は 1 つだけ通る)。プロフィールの行が無ければ仮置きの値で作る。戻り値は作った組織の id・name・plan・owner_id・created_at・updated_at。#2107';

REVOKE ALL ON FUNCTION public.admin_create_organization(text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_organization(text, text, uuid) TO service_role;
