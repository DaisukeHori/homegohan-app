-- migration: 20261023150000_account_deletion_family_representative_guard.sql
-- 戻し方: supabase/rollbacks/20261023150000_account_deletion_family_representative_guard.down.sql
-- #1917 の続き (20261023130000_account_deletion_owner_guard.sql の家族の代表者の型): 退会の途中 (findBlocker のあと〜
-- auth.admin.deleteUser の前) に、その人が家族の代表者になると、退会の最後の deleteUser が family_groups.representative_id の
-- 外部キー (ON DELETE RESTRICT) に当たって失敗する既存の欠陥を直す (取り消せない段 (記録を伏せる・所属を外す・ファイルを消す) の
-- あとで止まり、アカウントだけが残る)。
--
-- 背景:
--   家族の代表者になる経路は 3 つある。
--     - create_family_group (本人が別の端末から家族を作る。最新の定義は 20261021100000_billing_paid_plans_iap.sql)
--     - accept_family_representative_transfer (本人が代表者の譲渡を承諾する。最新の定義は 20261017030000_parental_consent_and_birth_date.sql)
--     - operator_force_representative_transfer (運営の強制譲渡。最新の定義は 20261017130000_operator_mfa_db_gate.sql)
--   退会 (src/lib/account-deletion.ts の deleteAccount) は findBlocker (family_groups.representative_id = 本人なら 409) のあと、
--   家族の所属を関数で外さない (family_members は deleteUser の CASCADE で消える)。退会の途中の人は家族の active なメンバーの
--   ままなので、譲渡の承諾・運営の強制譲渡の在籍の確認を通り、所属の無い人は家族を作れた。
--
-- 変更:
--   トリガー trg_representative_not_deleting (BEFORE INSERT OR UPDATE OF representative_id ON family_groups。関数
--   family_groups_representative_not_deleting): 新しい representative_id の人に、新しい退会の印 (account_deletion_guards の
--   started_at が今から c_guard_window 以内) があれば、'REPRESENTATIVE_ACCOUNT_DELETING' (P0001) で止める。
--   representative_id を人に書くのは上の 3 つの関数だけ (解散は NULL にする) なので、3 つの経路がこの 1 か所で止まる。
--   service_role の直接の書き込みにも効く。関数の本文は書き換えない (3 つの関数の最新の定義・ロック・判定・エラーとその順番は同じ。
--   ほかの migration が同じ関数を作り直しても、この止めは落ちない)。
--     - representative_id が NULL (解散) と、値を変えない UPDATE には何もしない (退会が 409 で止まった代表者が、そのあと
--       家族を解散できる。#1917 の「解散してから退会する」の流れを止めない)。
--     - エラーのコードは 3 つの経路で同じ。route が日本語の固定の文にする:
--         POST /api/family/groups・POST /api/family/representative-transfer/{id}/accept は 409 (src/lib/errors/membership-errors.ts の表)
--         POST /api/operator/membership/family/{id}/transfer は 409 (「譲渡先のユーザーは退会の手続き中です」)
--
-- 印と代表者の変更の直列化 (同時に走ったとき): 20261023130000 の組織の作成と同じ。どちらも、その人の id の advisory lock
--   (トランザクションの間。キーは 'account_deletion_guard:<user_id>') を取ってから印を読み書きする。
--     - 印が先: 代表者の変更のトリガーは印の commit を待ってから印を読み、REPRESENTATIVE_ACCOUNT_DELETING で止まる (何も書かれない)。
--     - 代表者の変更が先: 印は変更の commit を待つ。退会の本体は印のあとで findBlocker を呼ぶので、新しい代表者の家族を読んで 409
--       (ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE) で止まる (取り消せない段の前)。
--   印の古さ (c_guard_window) は organizations_owner_not_deleting (20261023130000) と同じ 15 分。値をそろえることは
--   tests/account-deletion-family-rep-guard-migration-contract.test.ts が確かめる。
--
-- トリガーの順: 同じ時点の行のトリガーは名前の順に動く。family_groups の BEFORE UPDATE には特権列のガード
--   trg_guard_family_groups_privileged (ログインユーザーの representative_id の直接の変更を 42501 で止める) がある。この止めを先に
--   動かすため (ログインユーザーが自分の家族の行の直接の UPDATE で、ほかの人が退会の途中かを探れないように)、名前はそれより後ろに並ぶ
--   trg_representative_not_deleting にする。課金のトリガー family_groups_billing_plan_follow_representative (advisory
--   'billing-user:<新しい代表者>') はこれより前に動く。
--
-- ロックの向き: 代表者の変更は family_groups の行 (譲渡の承諾・運営の強制譲渡は関数の最初に FOR NO KEY UPDATE。作成は新しい行) →
--   子の行 → (この UPDATE / INSERT のトリガーで) advisory 'billing-user:<新しい代表者>' → advisory 'account_deletion_guard:<新しい代表者>'。
--   作成はそのあと family_members の行・本人の user_profiles の行を書く。印 (begin_account_deletion_guard) は advisory lock だけを
--   取る (ほかの行も advisory lock も持たない) ので、待ちの輪はできない。CLAUDE.md の「家族 (family_*) を変える関数のロック順」の
--   家族の行 → 子の行の順は変えない。
--
-- 権限の定型 (#1039/#1020): 新しい関数には Supabase の既定権限で anon / authenticated / service_role と PUBLIC に EXECUTE が付くので、
--   引数の型まで含めた完全形で REVOKE する。トリガーとして動くときは EXECUTE を確かめないので、誰にも GRANT しない。
--   関数は SECURITY DEFINER (印の表 account_deletion_guards は誰にも権限が無いので、所有者の権限で読む)・SET search_path = ''、参照は完全修飾。
-- 既存データへの影響: なし (トリガーを足すだけ。BEFORE INSERT / UPDATE なので既存の行を検査しない)。
-- 冪等: CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER。2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/account-deletion-family-rep-guard.test.ts (実 DB)
--       tests/account-deletion-family-rep-guard-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.family_groups_representative_not_deleting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- 退会の印が効く長さ。organizations_owner_not_deleting (20261023130000) の c_guard_window と同じ値にする。
  -- 退会の 1 回の実行は route の maxDuration (60 秒。src/app/api/account/delete/route.ts) で切られ、Vercel の関数の実行時間の
  -- 上限 (800 秒) よりも長く取る。これより古い印は、途中で止まった退会か 409 で止まった退会の残りで、その人を代表者にすることを止めない
  c_guard_window CONSTANT pg_catalog.interval := pg_catalog.make_interval(mins => 15);
BEGIN
  -- 解散 (representative_id を NULL にする) は止めない。退会が 409 で止まった代表者が、家族を解散してから退会し直せる
  IF NEW.representative_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- 代表者が変わらない UPDATE (同じ値を書く) には何もしない
  IF TG_OP = 'UPDATE' AND NEW.representative_id IS NOT DISTINCT FROM OLD.representative_id THEN
    RETURN NEW;
  END IF;

  -- begin_account_deletion_guard と同じキー。印が先なら、その commit を待ってから読む
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account_deletion_guard:' || NEW.representative_id::pg_catalog.text, 0));

  IF EXISTS (
    SELECT 1
      FROM public.account_deletion_guards AS g
     WHERE g.user_id = NEW.representative_id
       AND g.started_at > pg_catalog.clock_timestamp() - c_guard_window
  ) THEN
    RAISE EXCEPTION 'REPRESENTATIVE_ACCOUNT_DELETING' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END
$function$;

-- トリガーとして動くときは EXECUTE を確かめない。RPC としては呼べないので、誰にも EXECUTE を付けない
REVOKE ALL ON FUNCTION public.family_groups_representative_not_deleting() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.family_groups_representative_not_deleting() IS
  '#1917 の続き: family_groups の作成と代表者の変更で、新しい representative_id の人に新しい退会の印 (account_deletion_guards) があれば REPRESENTATIVE_ACCOUNT_DELETING (P0001) で止める。NULL (解散) と値を変えない UPDATE は止めない';

CREATE OR REPLACE TRIGGER trg_representative_not_deleting
  BEFORE INSERT OR UPDATE OF representative_id ON public.family_groups
  FOR EACH ROW EXECUTE FUNCTION public.family_groups_representative_not_deleting();
