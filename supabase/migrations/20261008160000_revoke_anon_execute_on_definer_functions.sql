-- migration: 20261008160000_revoke_anon_execute_on_definer_functions.sql
-- #1103 (7): 未ログインの anon が EXECUTE できる SECURITY DEFINER 関数を、本当に必要な 2 本だけにする
--
-- 背景:
--   Supabase は public スキーマに関数を作ると、anon / authenticated / service_role へ EXECUTE を自動で付ける
--   (ALTER DEFAULT PRIVILEGES。本番も同じ)。PostgreSQL は PUBLIC (全員) にも EXECUTE を付ける。
--   そのため `REVOKE ... FROM PUBLIC` だけでは anon の権限は消えず、`REVOKE ... FROM anon, authenticated` だけでは
--   PUBLIC 経由の権限が残る。SECURITY DEFINER の関数は所有者 (postgres) の権限で動くので、anon が EXECUTE できると、
--   anon キー (公開鍵) だけで /rest/v1/rpc/<関数> から直接呼べる。
--   本番の 2026-10-07 スナップショット (supabase/baseline/catalog/catalog_functions.csv) では、public の関数 87 本のうち
--   40 本で anon に EXECUTE が付いていた。そのうち SECURITY DEFINER は 6 本。さらに 1 本 (cleanup_handson_tour_sandbox_rows)
--   は anon の名前は無いが PUBLIC に EXECUTE が付いていて、anon も呼べた。合わせて、SECURITY DEFINER 全 53 本のうち 7 本。
--   (その後の migration で足された SECURITY DEFINER 関数は、どれも REVOKE を書いているので anon は呼べない。)
--   ALTER DEFAULT PRIVILEGES は変えない (変えると今後作る全部の関数の権限が黙って変わる)。代わりに、
--   anon が EXECUTE できる SECURITY DEFINER 関数を許可リストと突き合わせるテスト
--   (tests/integration/security/anon-definer-execute.test.ts) を足して、新しい関数が既定の権限のまま作られたら CI で落とす。
--
-- 関数ごとの判断 (anon が EXECUTE できた 7 本。残りの SECURITY DEFINER 関数は、元から anon が EXECUTE できない):
--   get_invite_details(text)
--     呼び出し元: 招待ページ /invite/[token] (src/app/invite/[token]/page.tsx。ログイン前に開く)、
--                 src/lib/membership/org-invite.ts、src/app/api/family/invites/route.ts
--     判断: anon を残す (未ログインの画面が呼ぶ)。この migration では触らない。
--   get_promotion_details(text)
--     呼び出し元: 参加リクエストの承認ページ /family/promotions/[token] (src/app/family/promotions/[token]/page.tsx。ログイン前に開く)
--     判断: anon を残す (同上)。この migration では触らない。
--   preview_family_invite(text) / preview_org_invite(text)
--     呼び出し元: なし (src・lib・apps/mobile・supabase/functions・scripts のどこにも無い。生成された型にあるだけ)。
--                 招待の中身は get_invite_details が同じ内容を返す。
--     判断: anon を外す。authenticated / service_role は残す (何も変えない。消すかどうかは別の判断)。
--   can_view_user_meals(uuid)
--     呼び出し元: meals の SELECT ポリシー meals_select_owner_or_family の中だけ (ほかのポリシー・関数・ビュー・トリガーは呼ばない)。
--                 元の設計 (docs/design/membership/01-data-model.md) も authenticated だけに GRANT する想定だった。
--     判断: ポリシーを TO authenticated にしてから、anon を外す (下の「ポリシー」を参照)。
--   organizations_owner_id_unchanged(uuid, uuid)
--     呼び出し元: organizations の UPDATE ポリシー organizations_update_admin (WITH CHECK) の中だけ。
--     判断: ポリシーを TO authenticated にしてから、anon を外す。
--   cleanup_handson_tour_sandbox_rows()
--     呼び出し元: pg_cron のジョブ handson-tour-sandbox-cleanup (毎日 04:00 UTC。ジョブは、登録したロール = 関数の所有者
--                 postgres の権限で動く) と、結合テスト (service_role)。アプリ・Edge Function・モバイルからは呼ばない。
--     判断: PUBLIC・anon・authenticated から外す。service_role だけ残す。
--           作ったときの migration (20260508140000_handson_tour_phase4_cleanup.sql。#1116 で統合する前のもので、git 履歴にある) は
--           「anon / authenticated からは実行不可、service_role のみ」のつもりで `REVOKE ... FROM anon, authenticated` を書いたが、
--           権限は PUBLIC に付いていたため効かず、anon もログインユーザーも誰でも呼べた。
--           呼ぶと、90 日より古い sandbox の食事と日別献立を全ユーザー分消し、admin_audit_logs に行を 1 つ足す
--           (ローカルで確認: anon が呼ぶたびに監査ログが 1 行増えた)。
--
-- ポリシー (関数の権限より先に変える):
--   関数の EXECUTE 権限は、式が評価される前の実行開始時に確認される。ポリシーが TO public のまま関数から anon を外すと、
--   anon の問い合わせは「0 行」ではなく `42501 permission denied for function ...` で失敗する
--   (ローカルで確認: anon の SELECT は meals・meal_nutrition_estimates とも失敗し、`WHERE false` の UPDATE でも失敗した)。
--   該当するのは次の 2 本 (ポリシーが呼ぶ関数を pg_depend で調べた。全スキーマのポリシーを見て、この 2 関数を呼ぶのはこの 2 本だけ)。
--     meals.meals_select_owner_or_family       SELECT  USING (can_view_user_meals(user_id))
--     organizations.organizations_update_admin UPDATE  WITH CHECK (... AND organizations_owner_id_unchanged(id, owner_id))
--   meal_nutrition_estimates / meal_ai_feedbacks のポリシーは meals を副問い合わせで読むので、meals の SELECT ポリシーが
--   anon に適用されるかどうかで、anon の問い合わせ結果が変わる。
--   どちらも `ALTER POLICY ... TO authenticated` で対象ロールだけを PUBLIC から authenticated に変える (式は変えない)。
--   anon の結果は変わらない:
--     - どちらの関数も auth.uid() で判定する (can_view_user_meals は、auth.uid() が対象本人、または対象と同じ家族の active な
--       メンバーで対象が食事を共有しているときだけ true。organizations_owner_id_unchanged は、auth.uid() が組織の owner / admin
--       のときだけ true になりうる)。anon は auth.uid() が NULL なので、もともと true になることは無く、SELECT も UPDATE も 0 行だった。
--     - ポリシーが無い anon は、RLS の既定で 0 行になる (エラーにはならない)。meals の INSERT / UPDATE / DELETE のポリシー
--       (meals_insert_owner など。TO public のまま) は関数を呼ばず、auth.uid() = user_id で判定する。anon の書き込みは今も通らない。
--   ログインユーザー (authenticated。匿名サインインのユーザーも含む) のポリシーは今と同じ式なので、何も変わらない。
--   service_role は RLS を通らない。
--
-- 変更 (表・行・既存のデータには一切触れない):
--   1. ポリシー 2 本を TO authenticated にする (ALTER POLICY)。
--   2. 関数 5 本の EXECUTE を、引数の型まで含めた完全形で REVOKE し直し、残す役割にだけ GRANT する
--        preview_family_invite(text) / preview_org_invite(text) /
--        can_view_user_meals(uuid) / organizations_owner_id_unchanged(uuid, uuid)
--                                       : authenticated・service_role だけ (今の authenticated・service_role の権限のまま)
--        cleanup_handson_tour_sandbox_rows()  : service_role だけ
--      (REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role → 必要な役割へ GRANT。20261007160000 / 20261008120100 と同じ書き方。)
--   所有者 postgres の EXECUTE は外さない (REVOKE は所有者自身には触れず、pg_cron のジョブは所有者の権限で動く)。
--
-- 本番への影響:
--   - ログインユーザーと、未ログインの招待ページ・承認ページ: 変わらない (使う関数・ポリシーの結果は同じ)。
--   - anon が直接 /rest/v1/rpc/<関数> で呼ぶと、5 本は 42501 (HTTP 401) で失敗する。呼び出し元のコードは無い。
--   - cleanup_handson_tour_sandbox_rows: ログインユーザーも直接は呼べなくなる (呼び出し元は無い)。夜間のジョブは影響を受けない。
--   - ALTER POLICY は meals / organizations に ACCESS EXCLUSIVE ロックを取る (ローカルで確認)。migration の終わりまで持つが、
--     同じ表に長い処理が走っていなければ一瞬で終わる。REVOKE / GRANT (関数) は表にロックを取らない。
--     念のため、ロックを 10 秒待っても取れなければ失敗させる (ロック待ちのあいだ、meals への新しい読み書きも待たされるので、
--     待ちの長さに上限を付ける。失敗しても、再実行すれば直る)。
--   - 既存のデータを書き換える文 (UPDATE / DELETE) は無い。
--
-- 冪等: ALTER POLICY ... TO と REVOKE / GRANT は、何度流しても同じ結果になる。
--   (ALTER POLICY は、ポリシーが無いとエラーになる。2 本とも本番にある: supabase/baseline/catalog/catalog_policies.csv)
-- 適用順: migration は version 順にマージする。
-- 確認: tests/integration/security/anon-definer-execute.test.ts
-- ロールバック: supabase/rollbacks/20261008160000_revoke_anon_execute_on_definer_functions.down.sql

SET LOCAL lock_timeout = '10s';

-- 1. ポリシー: anon に適用しない (式は変えない)。関数の権限を外す前に変える。
ALTER POLICY meals_select_owner_or_family ON public.meals TO authenticated;
ALTER POLICY organizations_update_admin ON public.organizations TO authenticated;

-- 2. 呼び出し元が無い関数: anon を外す。authenticated / service_role は今のまま。
REVOKE ALL ON FUNCTION public.preview_family_invite(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_family_invite(text)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.preview_org_invite(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_org_invite(text)
  TO authenticated, service_role;

-- 3. RLS ポリシーの中でだけ呼ばれる関数: anon を外す。authenticated / service_role は今のまま。
REVOKE ALL ON FUNCTION public.can_view_user_meals(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_view_user_meals(uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.organizations_owner_id_unchanged(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.organizations_owner_id_unchanged(uuid, uuid)
  TO authenticated, service_role;

-- 4. 夜間バッチ専用の関数: PUBLIC (= anon・authenticated を含む全員) から外す。service_role だけ残す。
REVOKE ALL ON FUNCTION public.cleanup_handson_tour_sandbox_rows()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_handson_tour_sandbox_rows()
  TO service_role;
