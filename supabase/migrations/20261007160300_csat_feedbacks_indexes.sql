-- migration: 20261007160300_csat_feedbacks_indexes.sql
-- csat_feedbacks (CSAT フィードバック) に索引を 2 本足す (#1217)
--
-- 背景:
--   csat_feedbacks の索引は主キー (csat_feedbacks_pkey) だけ。2026-10-07 13:41 UTC の本番スナップショット
--   (supabase/baseline/prod_schema.sql) に CREATE INDEX は無く、その後の migration でも足していない。
--   兄弟の nps_surveys には idx_nps_surveys_recent (sent_at DESC) があり、csat_feedbacks だけ索引が無い形になっていた。
--   この表を引く処理は次の 3 つで、どれも索引が無いと表全体を読む。
--     (1) NPS / CSAT 集計 API (GET /api/admin/finance/nps。src/app/api/admin/finance/nps/route.ts)
--           SELECT id, score, comment, ticket_id, created_at FROM csat_feedbacks
--            [WHERE created_at >= :from] [AND created_at <= :to] ORDER BY created_at DESC
--         期間の絞り込みも並べ替えも created_at。索引が無いと、期間を絞っても全行を読んでから並べ替える。
--     (2) RLS ポリシー csat_access (FOR ALL、USING のみ):
--           (user_id = auth.uid()) OR (サポート担当・admin・super_admin である)
--         本人の行を `WHERE user_id = :自分` で引く問い合わせは、索引が無いと全行を読んで user_id を比べる。
--     (3) 外部キー csat_feedbacks_user_id_fkey (auth.users(id) を参照。ON DELETE の指定なし = NO ACTION):
--         auth.users の行を消すたびに、Postgres が「その user_id の行がこの表に残っていないか」を確かめる。
--         索引が無いと、この確認が csat_feedbacks の全表走査になる (退会処理の auth.admin.deleteUser が通る)。
--   CSAT を書き込むコードはまだ無い (リポジトリに INSERT の箇所が無い) ので、いまは行が増えていないはずで、実害は小さい。
--   収集を始めて行が増えると、集計と退会が行数に比例して遅くなる。行が少ないうちに足しておく。
--
-- 変更 (どちらも CREATE INDEX IF NOT EXISTS。データ・ポリシー・権限・制約は変えない):
--   idx_csat_feedbacks_created_at  ON csat_feedbacks (created_at DESC)  ← (1) の期間絞り込みと新しい順の並べ替え
--   idx_csat_feedbacks_user_id     ON csat_feedbacks (user_id)          ← (2) の本人の行の検索と (3) の外部キー確認
--   created_at は nps_surveys の idx_nps_surveys_recent と同じく DESC で作る (単一列なので、昇順の問い合わせでも逆向き走査で使える)。
--
-- 足さないもの (いま使う処理が無いため。必要になった時点で、その変更に含める):
--   - ticket_id の索引: ticket_id で引く問い合わせも RLS の条件も無い (集計 API は列として読むだけ)。
--     参照先 support_tickets の行を削除するコードもリポジトリに無い (外部キーの確認が走るのは、参照先の行の削除・主キーの変更のとき)。
--     チケットを消す方針が決まったとき (#1175 のアカウント削除時の外部キー方針) に、その migration で足す。
--   - (user_id, created_at) の複合索引: 「本人の行を新しい順に引く」問い合わせがまだ無い。
--
-- ⚠ 索引では速くならないもの (別の変更が要る):
--   - ログインユーザーが条件を付けずに `SELECT ... FROM csat_feedbacks` を実行したとき。RLS の
--     `(user_id = auth.uid()) OR (EXISTS (...))` は OR の片側が行の値を使わない式なので、Postgres は OR 全体を索引の条件にできず、
--     全行を読んで判定する (ローカルで 20 万行を入れて、索引の前後とも全表走査になることを確認した)。
--     本人の行を引くときは、アプリ側で `.eq('user_id', 自分)` を付けること (付ければ idx_csat_feedbacks_user_id が使われる)。
--     ポリシーの書き換えは、この表を読み書きするコードが入る時点で別に検討する。
--   - 集計 API を from / to 無しで呼んだとき。全期間の全行を返す作りのままなので、索引は並べ替えを省くだけで、読む行数は変わらない。
--     SQL 側で集計する (件数・平均・分布は集計し、一覧は直近 10 件だけ取る) 変更は、API 側の別の変更で行う。
--
-- 本番への影響: 読み書きの結果は変わらない。通常の CREATE INDEX は表に SHARE ロックを取り、構築の間だけ書き込みを待たせる。
--   CSAT を書き込むコードが無く、表はほぼ空のはずなので、待ちは一瞬。migration はトランザクション内で流れるので CONCURRENTLY は使わない。
--
-- 冪等: CREATE INDEX IF NOT EXISTS。2 回続けて適用してもエラーにならない。
--   (IF NOT EXISTS は名前だけを見る。上記スナップショットに、この 2 つの名前の索引は無い。)
-- 確認: tests/integration/rls/csat-feedbacks-indexes.test.ts
-- ロールバック: supabase/rollbacks/20261007160300_csat_feedbacks_indexes.down.sql

CREATE INDEX IF NOT EXISTS "idx_csat_feedbacks_created_at"
  ON "public"."csat_feedbacks" USING "btree" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_csat_feedbacks_user_id"
  ON "public"."csat_feedbacks" USING "btree" ("user_id");
