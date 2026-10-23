-- migration: 20261023130000_account_deletion_owner_guard.sql
-- 戻し方: supabase/rollbacks/20261023130000_account_deletion_owner_guard.down.sql
-- #1917 の続き (D73): 退会の途中 (findBlocker のあと〜auth.admin.deleteUser の前) に、運営が POST /api/admin/organizations で
-- その人を owner_id に指定して組織を作ると、退会の最後の deleteUser が organizations_owner_id_fkey (ON DELETE RESTRICT) に当たって
-- 失敗する既存の欠陥を直す (取り消せない段 (記録を伏せる・所属を外す・ファイルを消す) のあとで止まり、アカウントだけが残る)。
--
-- 背景:
--   運営の組織の作成 (src/app/api/admin/organizations/route.ts の POST) は、オーナーにする人の user_profiles.organization_id が
--   空かだけを見て、organizations の行を INSERT する。退会 (src/lib/account-deletion.ts の deleteAccount) は findBlocker
--   (organizations.owner_id = 本人なら 409) のあと、release_user_membership で所属を外してから deleteUser を呼ぶ。
--   所属の無い人 (はじめから無い人も、release_user_membership が外した人も) は organization_id が空なので、退会の途中でも
--   運営の作成の確認を通り、オーナーになれた。user_profiles の行には「退会の途中」を表す値が無いので、行をロックして確かめても防げない。
--
-- 変更:
--   1. 表 account_deletion_guards (退会の印): 利用者ごとに 1 行。退会を始めた日時 (started_at) を持つ。
--      user_id は auth.users を指し、ON DELETE CASCADE (退会が済むと印も消える。印に利用者の id を残し続けない)。
--      RLS は有効でポリシーは無く、anon / authenticated / service_role の表の権限を外す (読み書きは下の関数 2 本だけ)。
--   2. begin_account_deletion_guard(p_user_id): 退会の印を付ける (同じ人の印があれば日時を今にする)。退会の本体が findBlocker の前に呼ぶ。
--      auth.users に居ない人 (すでに消えた人のやり直し) には何もしない (外部キーで失敗させない。やり直しは従来どおり成功する)。
--      EXECUTE は service_role だけ (退会の本体は service_role の client で呼ぶ)。
--   3. トリガー organizations_owner_not_deleting (BEFORE INSERT ON organizations): 作る組織の owner_id の人に、新しい退会の印
--      (started_at が今から ACCOUNT_DELETION_GUARD_WINDOW 以内) があれば、'OWNER_ACCOUNT_DELETING' (P0001) で INSERT を止める。
--      運営の作成 API はこれを 409 OWNER_ACCOUNT_DELETING にする。どの経路の INSERT (service_role の直接の書き込みも) にも効く。
--
-- 印と作成の直列化 (同時に走ったとき):
--   どちらも、その人の id の advisory lock (トランザクションの間。キーは 'account_deletion_guard:<user_id>') を取ってから印を読み書きする。
--     - 印が先: 作成のトリガーは印の commit を待ってから印を読み、OWNER_ACCOUNT_DELETING で止まる (組織は作られない)。
--     - 作成が先: 印は作成の commit を待つ。退会の本体は印のあとで findBlocker を呼ぶので、作られた組織を読んで 409
--       (ACCOUNT_DELETE_BLOCKED_ORG_OWNER) で止まる (取り消せない段の前)。
--   印の古さで効かなくする理由: 退会の 1 回の実行は route の maxDuration (60 秒。src/app/api/account/delete/route.ts) で切られる。
--   途中で止まった退会 (アカウントが残った) の印を残し続けると、その人を運営がオーナーにできなくなるので、印を消す処理を足さずに
--   ACCOUNT_DELETION_GUARD_WINDOW より古い印は効かないものとする。409 で止まった退会の印も同じく古くなって効かなくなる。
--
-- 同じ型で、この migration が直さないもの:
--   - 譲渡の承諾 (accept_org_owner_transfer)・運営の強制譲渡 (operator_force_owner_transfer) で退会の途中の人がオーナーになる型は、
--     20261022160000_release_membership_owner_race.sql が受け持つ (所属を外す前なら release_user_membership が IS_ORG_OWNER で止めて
--     退会は 409。外したあとなら譲渡が TRANSFER_ACCEPTOR_NOT_IN_ORG / TARGET_NOT_IN_ORG で止まる)。このトリガーは UPDATE には付けない
--     (それらの関数のエラーの面を変えない)。
--   - 家族の代表者 (family_groups.representative_id) になる型は、src/lib/account-deletion.ts の段 5 の例外のまま
--     (deleteUser が RESTRICT で失敗し、もう一度の退会で 409)。
--
-- ロックの向き: 組織の作成は organizations の新しい行 → advisory lock。印は advisory lock だけを取る (ほかの行を持たない) ので、待ちの輪はできない。
--   CLAUDE.md の「組織 (organizations) を変える関数のロック順 (DB)」の段 (1)〜(4) の行のロックは取らない。
--
-- 権限の定型 (#1039/#1020): 新しい関数には Supabase の既定権限で anon / authenticated / service_role と PUBLIC に EXECUTE が付くので、
--   引数の型まで含めた完全形で REVOKE し、必要なロールにだけ GRANT し直す。関数は SET search_path = ''、参照は完全修飾。
--   新しい表にも既定の権限で anon / authenticated / service_role に権限が付くので、REVOKE ALL で外す。
-- 既存データへの影響: なし (表を作るだけ。既存の組織の行には触れない。トリガーは BEFORE INSERT なので既存の行を検査しない)。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER。2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/account-deletion-owner-guard.test.ts (実 DB)
--       tests/account-deletion-owner-guard-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. 退会の印
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_deletion_guards (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.account_deletion_guards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.account_deletion_guards FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.account_deletion_guards IS
  '#1917 の続き (D73): 退会の印。begin_account_deletion_guard が退会の始め (findBlocker の前) に付け、トリガー organizations_owner_not_deleting が組織の作成で読む。退会が済むと auth.users の CASCADE で消える。直接は誰も読み書きしない';

-- ----------------------------------------------------------------
-- 2. 退会の印を付ける (退会の本体が service_role で呼ぶ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.begin_account_deletion_guard(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'begin_account_deletion_guard: p_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- 組織の作成のトリガー (organizations_owner_not_deleting) と同じキー。印の commit と作成の判定を、この人ごとに直列にする
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account_deletion_guard:' || p_user_id::pg_catalog.text, 0));

  -- すでに消えた人 (退会のやり直し) には印を付けない (auth.users を指す外部キーで失敗させない)
  INSERT INTO public.account_deletion_guards (user_id, started_at)
  SELECT u.id, pg_catalog.now()
    FROM auth.users AS u
   WHERE u.id = p_user_id
  ON CONFLICT (user_id) DO UPDATE SET started_at = EXCLUDED.started_at;
END
$function$;

REVOKE ALL ON FUNCTION public.begin_account_deletion_guard(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_account_deletion_guard(uuid) TO service_role;

COMMENT ON FUNCTION public.begin_account_deletion_guard(uuid) IS
  '#1917 の続き (D73): 退会の印を付ける (あれば日時を今にする)。src/lib/account-deletion.ts の deleteAccount が findBlocker の前に呼ぶ。auth.users に居ない人には何もしない。service_role のみ';

-- ----------------------------------------------------------------
-- 3. 退会の途中の人をオーナーにして組織を作らない
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.organizations_owner_not_deleting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- ACCOUNT_DELETION_GUARD_WINDOW: これより新しい退会の印だけが効く。退会の 1 回の実行は route の maxDuration (60 秒。
  -- src/app/api/account/delete/route.ts) で切られ、Vercel の関数の実行時間の上限 (800 秒) よりも長く取る。
  -- これより古い印は、途中で止まった退会か 409 で止まった退会の残りで、その人をオーナーにすることを止めない
  c_guard_window CONSTANT pg_catalog.interval := pg_catalog.make_interval(mins => 15);
BEGIN
  IF NEW.owner_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- begin_account_deletion_guard と同じキー。印が先なら、その commit を待ってから読む
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account_deletion_guard:' || NEW.owner_id::pg_catalog.text, 0));

  IF EXISTS (
    SELECT 1
      FROM public.account_deletion_guards AS g
     WHERE g.user_id = NEW.owner_id
       AND g.started_at > pg_catalog.clock_timestamp() - c_guard_window
  ) THEN
    RAISE EXCEPTION 'OWNER_ACCOUNT_DELETING' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$function$;

-- トリガーとして動くときは EXECUTE を確かめない。RPC としては呼べないので、誰にも EXECUTE を付けない
REVOKE ALL ON FUNCTION public.organizations_owner_not_deleting() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.organizations_owner_not_deleting() IS
  '#1917 の続き (D73): organizations の INSERT で、owner_id の人に新しい退会の印 (account_deletion_guards) があれば OWNER_ACCOUNT_DELETING (P0001) で止める';

CREATE OR REPLACE TRIGGER trg_organizations_owner_not_deleting
  BEFORE INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_owner_not_deleting();
