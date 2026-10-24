-- migration: 20261024120000_account_deletion_guard_release.sql
-- 戻し方: supabase/rollbacks/20261024120000_account_deletion_guard_release.down.sql
-- #1917 の続き: 退会が取り消せない段 (auth.admin.deleteUser) の前に止まったら、その場で退会の印 (account_deletion_guards) を消す。
--
-- 背景:
--   退会の本体 (src/lib/account-deletion.ts の deleteAccount) は findBlocker の前に begin_account_deletion_guard で印を付ける
--   (20261023130000_account_deletion_owner_guard.sql)。印のある人は、組織の作成 (トリガー trg_organizations_owner_not_deleting) と、
--   家族の作成・代表者の譲渡の承諾・運営の強制譲渡 (トリガー trg_representative_not_deleting。20261023150000) で止まる。
--   これまで印を消す処理は無く、退会が findBlocker の 409 (組織のオーナー・家族の代表者) や途中の失敗で止まっても、印は
--   c_guard_window (15 分) のあいだ効き続けた。その間に本人が家族を作る・代表者を引き受けると「退会の手続き中のため…」で
--   断られ、退会が止まったと理解している本人には文が合わなかった。
--
-- 変更:
--   end_account_deletion_guard(p_user_id): 退会の印を消す。退会の本体が、deleteUser を呼ぶ前に止まったとき (409・途中の失敗) に呼ぶ。
--   印が無い人・auth.users に居ない人には何もしない (エラーにしない)。EXECUTE は service_role だけ (退会の本体は service_role の client で呼ぶ)。
--   deleteUser を呼んだあとに止まったとき (削除の失敗・削除のあとの失敗) は、退会の本体はこの関数を呼ばない
--   (アカウントが消えたか、消える途中かを確かめられない。印はトリガーが止め続け、15 分で古くなる。削除が済めば auth.users の CASCADE で消える)。
--
-- 印と作成・代表者の変更の直列化: begin_account_deletion_guard・2 つのトリガーと同じキー ('account_deletion_guard:<user_id>') の
--   advisory lock (トランザクションの間) を取ってから印を消す。
--     - 作成・変更が先 (トリガーが印を読んで止めた・通した): 消すのはその commit を待ってから。
--     - 消すのが先: 作成・変更のトリガーは消した commit を待ってから印を読み、印が無いので通す (退会はもう止まっている)。
--
-- 同じ人の退会が 2 つ同時に走っているとき: 先に止まった方が印を消すと、もう一方 (findBlocker のあと〜deleteUser の前) の印も消える
--   (印は 1 人 1 行)。その間にその人がオーナー・代表者になると、もう一方の deleteUser は外部キー (RESTRICT) で失敗し、
--   アカウントは残る (もう一度の退会で 409)。消える記録は無く、20261023130000 より前と同じ止まり方なので、印に実行ごとの区別は持たせない。
--
-- ロックの向き: 印を消すのは advisory lock だけを取る (ほかの行も advisory lock も持たない) ので、待ちの輪はできない。
--   CLAUDE.md の「組織 (organizations) を変える関数のロック順 (DB)」の段 (1)〜(4) の行のロックは取らない。
--
-- 権限の定型 (#1039/#1020): 新しい関数には Supabase の既定権限で anon / authenticated / service_role と PUBLIC に EXECUTE が付くので、
--   引数の型まで含めた完全形で REVOKE し、service_role にだけ GRANT し直す。関数は SECURITY DEFINER (印の表は誰にも権限が無いので、
--   所有者の権限で消す)・SET search_path = ''、参照は完全修飾。
-- 既存データへの影響: なし (関数を足すだけ。印の行には触れない)。
-- 冪等: CREATE OR REPLACE FUNCTION。2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/account-deletion-guard-release.test.ts (実 DB)
--       tests/account-deletion-guard-release-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.end_account_deletion_guard(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'end_account_deletion_guard: p_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- begin_account_deletion_guard と 2 つのトリガーと同じキー。作成・代表者の変更が先なら、その commit を待ってから消す
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account_deletion_guard:' || p_user_id::pg_catalog.text, 0));

  DELETE FROM public.account_deletion_guards AS g
   WHERE g.user_id = p_user_id;
END
$function$;

REVOKE ALL ON FUNCTION public.end_account_deletion_guard(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_account_deletion_guard(uuid) TO service_role;

COMMENT ON FUNCTION public.end_account_deletion_guard(uuid) IS
  '#1917 の続き: 退会の印 (account_deletion_guards) を消す。src/lib/account-deletion.ts の deleteAccount が、deleteUser を呼ぶ前に止まったとき (409・途中の失敗) に呼ぶ。印が無ければ何もしない。service_role のみ';
