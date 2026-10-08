-- migration: 20261007160800_admin_user_email_lookup.sql
-- #1145: 管理画面のユーザー一覧・詳細でメールアドレスを出すための関数 (auth.users の読み取り。service_role 専用)
--
-- 背景:
--   GET /api/admin/users と GET /api/admin/users/[id] は email を常に null で返していた。
--   メールアドレスは auth.users にあり、PostgREST には公開されていない (public スキーマだけ)。
--   管理 API (service_role) から引くには、auth.users を読む関数が要る。
--   auth.admin.listUsers() は 1 ページ 50 件までしか返さず、先頭 50 件の外のユーザーのメールを引けない (#1204) ため使わない。
--   auth.admin.getUserById() は 1 人ずつの HTTP 呼び出しで、1 ページ (最大 200 件) だと 200 回になる。
--   メールでの検索 (部分一致) は getUserById では実現できない。
--
-- 変更:
--   1. admin_user_emails(p_ids uuid[]) を新設する。渡した user_id のメールだけを (user_id, email) で返す。
--      一覧は 1 ページ分 (最大 200 件)、詳細は 1 件を渡す。渡していない id は返さない。存在しない id は黙って捨てる。
--   2. admin_find_user_ids_by_email(p_q text, p_limit integer) を新設する。メールの部分一致 (大文字小文字を区別しない) で
--      user_id を新しい順に返す。件数は p_limit (1〜200、既定 100) で打ち切る。
--      LIKE ではなく strpos(lower(...)) で比べるため、検索語に % _ \ があっても文字どおりに扱われる。
--      空・空白だけ・NULL の検索語では何も返さない (全ユーザーを引き出させない)。
--   3. 権限は service_role のみ。anon / authenticated は 42501 (permission denied)。
--
-- 設計上の判断:
--   - SECURITY DEFINER (所有者 postgres)。auth.users を読むため。SET search_path = '' で、関数内の参照は全て完全修飾。
--   - 関数の中では呼び出し元のロールを確認しない。service_role は auth.uid() が NULL のため確認できず、
--     EXECUTE 権限 (service_role だけ) が唯一の境界になる。呼び出す API ルートは、requireRole で
--     admin / super_admin であることを確認したあとにだけ呼ぶ (support には呼ばない)。
--   - 新しい関数は Supabase の既定権限で anon / authenticated / service_role に EXECUTE が自動付与され、PUBLIC にも付く。
--     引数の型まで含めた完全形で REVOKE する (20261007150300_native_bridge_codes.sql と同じ理屈)。
--   - メールの部分一致は auth.users の全件走査になる (部分一致用の索引は無い。auth.users は Supabase Auth が管理するテーブルで、
--     こちらからは索引を足さない)。admin / super_admin の画面からしか呼ばれず、件数は p_limit で打ち切るので許容する。
--   - 既存のデータには一切触れない (関数の追加だけ)。
--
-- 冪等: CREATE OR REPLACE FUNCTION。REVOKE / GRANT は何度流しても同じ結果になる。
-- 適用順: 管理 API のコードと同じ PR。migration は version 順にマージする。
--   コードの方が先に出ても (関数がまだ無くても)、メールが null になり、検索がメールを無視するだけで API は落ちない。失敗はログに残る。
-- ロールバック: supabase/rollbacks/20261007160800_admin_user_email_lookup.down.sql

-- ─────────────────────────────────────────────────────────
-- 渡した user_id のメールアドレスだけを返す
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_user_emails(p_ids uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id AS user_id, u.email::text AS email
    FROM auth.users AS u
   WHERE u.id = ANY (p_ids)
$$;

-- ─────────────────────────────────────────────────────────
-- メールアドレスの部分一致 (大文字小文字を区別しない) で user_id を探す
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_find_user_ids_by_email(p_q text, p_limit integer DEFAULT 100)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id
    FROM auth.users AS u
   WHERE btrim(coalesce(p_q, '')) <> ''
     AND strpos(lower(u.email), lower(btrim(p_q))) > 0
   ORDER BY u.created_at DESC, u.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 200)
$$;

-- 関数の権限: service_role のみ。
REVOKE ALL ON FUNCTION public.admin_user_emails(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_emails(uuid[])
  TO service_role;

REVOKE ALL ON FUNCTION public.admin_find_user_ids_by_email(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_find_user_ids_by_email(text, integer)
  TO service_role;

COMMENT ON FUNCTION public.admin_user_emails(uuid[]) IS
  '#1145: 渡した user_id のメールアドレスだけを (user_id, email) で返す。存在しない id は捨てる。管理 API (admin / super_admin) 用。service_role のみ。';
COMMENT ON FUNCTION public.admin_find_user_ids_by_email(text, integer) IS
  '#1145: メールアドレスの部分一致 (大文字小文字を区別しない。% _ は文字どおり) で user_id を新しい順に返す。件数は p_limit (1〜200)。空の検索語は何も返さない。service_role のみ。';
