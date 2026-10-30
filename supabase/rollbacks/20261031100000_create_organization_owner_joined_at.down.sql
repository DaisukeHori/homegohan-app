-- rollback: 20261031100000_create_organization_owner_joined_at.sql
-- #2120 W1 で作り直した運営の組織の作成の関数 admin_create_organization(text, text, uuid) を、その前の定義
-- (20261030150000_create_organization_atomic.sql。オーナーの所属は organization_id と org_role の 2 列だけを書く) に戻す。
-- 関数を消すと運営の作成 API が失敗するので、DROP ではなく前の定義で CREATE OR REPLACE する (本文・コメント・権限はその migration の写し)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、運営が作る組織のオーナーの joined_org_at と is_active_in_org は書かれなくなる (加入日が空・メンバーの一覧の最後に並ぶ)。
--   - 消える行は無い (この関数で書いた加入日はそのまま残る)。
--
-- 何度流しても同じ結果になる (冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT)。

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
