-- migration: 20261017040000_organizations_owner_id_not_null.sql
-- #1103 項目 10: organizations.owner_id を NOT NULL にする (設計 docs/design/membership/00-overview.md の
-- 「organizations.owner_id は常に NOT NULL」と、docs/design/membership/01-data-model.md §2.1 の SET NOT NULL に実物を合わせる)。
--
-- 背景:
--   設計は owner_id を NOT NULL としていたが、本番の列は nullable のまま (本番を写したベースラインも nullable)。
--   2026-10-16 の本番の読み取りでは organizations は 6 行で、owner_id はすべて NULL。うち 2 組織は user_profiles に
--   org_role = 'owner' の利用者が 1 人ずついる。残る 4 組織 (plan standard) はメンバーが 0 人で、紐づく行は
--   org_license_pools (ON DELETE CASCADE) の 4 行だけ。
--   新しく作る組織は src/app/api/admin/organizations/route.ts が owner_id (指定が無ければ作った運営) を必ず入れる。
--
-- 変更:
--   1. owner_id が NULL でメンバーが 0 人の組織を消す。消す前に次を確かめ、どれかに当たれば何も消さずに例外で止める
--      (本番の状態が読み取りから変わっていたら止まる):
--        - 消す件数が上限 (c_max_deletions = 4。読み取りで数えた件数) を超えない
--        - organizations を外部キーで参照する表 (org_license_pools を除く。user_profiles・departments・org_daily_stats・
--          organization_challenges・organization_invites・organization_reports など) と、外部キーの無い組織の列
--          (public の表の uuid の列 organization_id / *_org_id。coupon_redemptions・sales_leads・support_tickets など) に、
--          消す組織を指す行が 1 行も無い
--        - org_license_pools に既知の列 (c_license_pool_columns) 以外の列 (Stripe などの外部の紐付け) が足されていて、
--          消す組織の行にその値が入っていない
--   2. 残った owner_id が NULL の組織を、user_profiles の org_role = 'owner' の利用者で埋める。
--      1 組織に owner がちょうど 1 人でなければ例外で止める (誰をオーナーにするかを推測しない)。
--   3. owner_id を SET NOT NULL にする。
--   変えないもの: 外部キー organizations_owner_id_fkey (auth.users・ON DELETE RESTRICT)・索引・RLS・関数・トリガー。
--
-- 同時に動く書き込み: 最初に organizations を ACCESS EXCLUSIVE で、user_profiles を SHARE でロックする
--   (確かめてから消す・埋めるまでの間に、組織へのメンバーの追加・役割の変更・組織を参照する行の追加が入らないように。
--   外部キーの検査は organizations の行のロックを取るので、参照する行の追加もここで待つ)。10 秒でロック待ちを諦める。
-- 本番のデータへの影響: 組織 4 行と、その org_license_pools の 4 行 (CASCADE) を消す。組織 2 行の owner_id を埋める。
--   消した行は戻せない (ロールバックは NOT NULL を外すだけ)。
-- 冪等: 2 回目以降は owner_id が NULL の組織が無いので、1・2 は何もしない。SET NOT NULL は付いていても成功する。
-- 確認: tests/organizations-owner-id-not-null-migration-contract.test.ts /
--       tests/integration/security/organizations-owner-id-not-null.test.ts
-- ロールバック: supabase/rollbacks/20261017040000_organizations_owner_id_not_null.down.sql

SET LOCAL lock_timeout = '10s';

LOCK TABLE public.organizations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.user_profiles IN SHARE MODE;

DO $$
DECLARE
  -- 消してよい組織の件数の上限。2026-10-16 の本番の読み取りで、owner_id が NULL でメンバーが 0 人の組織は 4 件。
  -- これより多ければ、読み取りの後に状態が変わっているので止める
  c_max_deletions constant integer := 4;
  -- org_license_pools の既知の列 (20260511000097_membership_org_license_pools.sql とベースラインの定義)。
  -- これ以外の列 (Stripe などの外部の紐付け) が足されていて、消す組織の行に値が入っていれば止める
  c_license_pool_columns constant text[] := ARRAY[
    'organization_id', 'total_licenses', 'used_licenses', 'available_licenses', 'family_addon_seats', 'updated_at'
  ];
  v_targets uuid[];
  v_deleted integer;
  v_ref record;
  v_count bigint;
  v_org record;
  v_owners uuid[];
BEGIN
  -- ── 1. メンバーが 0 人の組織 (owner_id が NULL) を消す ──
  SELECT coalesce(array_agg(o.id ORDER BY o.id), ARRAY[]::uuid[])
    INTO v_targets
    FROM public.organizations o
   WHERE o.owner_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.user_profiles up WHERE up.organization_id = o.id);

  IF cardinality(v_targets) > c_max_deletions THEN
    RAISE EXCEPTION 'ORG_OWNER_NOT_NULL_TOO_MANY_DELETIONS: メンバーが 0 人の組織が % 件 (上限 %)。本番の状態が読み取りから変わっている',
      cardinality(v_targets), c_max_deletions;
  END IF;

  IF cardinality(v_targets) > 0 THEN
    -- 組織を参照する列: 外部キー (org_license_pools を除く) と、外部キーの無い組織の列 (uuid の organization_id / *_org_id)
    FOR v_ref IN
      SELECT DISTINCT ref.schema_name, ref.table_name, ref.column_name
        FROM (
          SELECT n.nspname::text AS schema_name, c.relname::text AS table_name, a.attname::text AS column_name
            FROM pg_constraint con
            JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, refattnum) ON true
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
           WHERE con.contype = 'f'
             AND con.confrelid = 'public.organizations'::regclass
             AND ra.attname = 'id'
             AND con.conrelid <> 'public.org_license_pools'::regclass
          UNION
          SELECT col.table_schema::text, col.table_name::text, col.column_name::text
            FROM information_schema.columns col
            JOIN information_schema.tables t
              ON t.table_schema = col.table_schema AND t.table_name = col.table_name AND t.table_type = 'BASE TABLE'
           WHERE col.table_schema = 'public'
             AND col.data_type = 'uuid'
             AND (col.column_name = 'organization_id' OR col.column_name LIKE '%\_org\_id')
             AND col.table_name NOT IN ('organizations', 'org_license_pools')
        ) AS ref
       ORDER BY 1, 2, 3
    LOOP
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I = ANY($1)', v_ref.schema_name, v_ref.table_name, v_ref.column_name)
        INTO v_count
        USING v_targets;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'ORG_OWNER_NOT_NULL_REFERENCED: 消す組織を %.%.% が % 行参照している',
          v_ref.schema_name, v_ref.table_name, v_ref.column_name, v_count;
      END IF;
    END LOOP;

    -- org_license_pools の既知の列以外 (外部の紐付け) に値が入っていれば止める
    FOR v_ref IN
      SELECT col.column_name::text AS column_name
        FROM information_schema.columns col
       WHERE col.table_schema = 'public'
         AND col.table_name = 'org_license_pools'
         AND col.column_name <> ALL (c_license_pool_columns)
       ORDER BY 1
    LOOP
      EXECUTE format('SELECT count(*) FROM public.org_license_pools WHERE organization_id = ANY($1) AND %I IS NOT NULL', v_ref.column_name)
        INTO v_count
        USING v_targets;
      IF v_count > 0 THEN
        RAISE EXCEPTION 'ORG_OWNER_NOT_NULL_LICENSE_POOL_LINKED: 消す組織の org_license_pools.% に値が % 行入っている',
          v_ref.column_name, v_count;
      END IF;
    END LOOP;

    DELETE FROM public.organizations WHERE id = ANY (v_targets);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> cardinality(v_targets) THEN
      RAISE EXCEPTION 'ORG_OWNER_NOT_NULL_DELETE_MISMATCH: % 件消すはずが % 件', cardinality(v_targets), v_deleted;
    END IF;
  END IF;

  -- ── 2. 残った組織の owner_id を org_role = 'owner' の利用者で埋める ──
  FOR v_org IN
    SELECT o.id FROM public.organizations o WHERE o.owner_id IS NULL ORDER BY o.id
  LOOP
    SELECT coalesce(array_agg(up.id ORDER BY up.id), ARRAY[]::uuid[])
      INTO v_owners
      FROM public.user_profiles up
     WHERE up.organization_id = v_org.id
       AND up.org_role = 'owner';
    IF cardinality(v_owners) <> 1 THEN
      RAISE EXCEPTION 'ORG_OWNER_NOT_NULL_OWNER_AMBIGUOUS: 組織 % の owner (org_role = owner) が % 人', v_org.id, cardinality(v_owners);
    END IF;
    UPDATE public.organizations SET owner_id = v_owners[1] WHERE id = v_org.id;
  END LOOP;
END $$;

-- ── 3. NOT NULL ──
ALTER TABLE public.organizations ALTER COLUMN owner_id SET NOT NULL;
