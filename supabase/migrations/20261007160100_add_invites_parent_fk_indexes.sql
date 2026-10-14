-- migration: 20261007160100_add_invites_parent_fk_indexes.sql
-- #1218: organization_invites / family_invites の親 FK 列 (organization_id / family_id) に通常の索引を足す
--
-- 背景 (本番の現状: supabase/baseline/prod_schema.sql の CREATE INDEX):
--   2 つの招待テーブルで、親 (organizations / family_groups) への FK 列を先頭キーに持つ索引は、次の部分ユニーク索引だけ。
--   どちらも `WHERE status = 'pending'` 付きで、「同じメールアドレスに pending の招待は 1 件まで」を守るための索引。
--     uniq_org_invites_pending     ON organization_invites (organization_id, lower(email)) WHERE status = 'pending'
--     uniq_family_invites_pending  ON family_invites (family_id, lower(email))             WHERE status = 'pending'
--   部分索引は、問い合わせの条件に `status = 'pending'` が含まれるときにしか使えない。ところが次の 3 つは status で絞らないため、
--   この索引を使えず、テーブル全体を読む (Seq Scan。一覧は続けて Sort も) ことになる。
--     1. GET /api/org/invites     (src/app/api/org/invites/route.ts)    .eq('organization_id', ...).order('created_at', desc)
--     2. GET /api/family/invites  (src/app/api/family/invites/route.ts) .eq('family_id', ...).order('created_at', desc)
--     3. 親 (organizations / family_groups) を消したときの FK の ON DELETE CASCADE (DELETE ... WHERE <FK 列> = ?)
--   招待は accepted / rejected / expired / revoked になっても消えない。自動で消す仕組みは無く、消せるのは
--   org の招待を 1 件ずつ消す DELETE API (DELETE /api/org/invites?id=...) だけなので、行は増える一方になる。
--   いまはテーブルが小さく実害は出ていない。ただ、全組織・全家族ぶんの招待の総数に比例して、
--   1 つの組織・1 つの家族の一覧取得が遅くなっていく。
--
-- 変更:
--   通常の (部分でない) btree 索引を 2 本足す。FK 列を先頭に、一覧の並び順の created_at DESC を続ける。
--     idx_organization_invites_org_created ON organization_invites (organization_id, created_at DESC)
--     idx_family_invites_family_created    ON family_invites (family_id, created_at DESC)
--   これで上の 1.〜3. が索引で走る。一覧は並び順も索引と同じなので Sort も要らない
--   (organization_invites.created_at は NULL を許す列だが、ORDER BY ... DESC の NULLS FIRST と索引の DESC の NULLS FIRST は一致する)。
--   既存の索引の重複ではない: 部分ユニーク索引は FK 列を先頭に持つが部分索引なので、上の 1.〜3. には使えない
--   (pending の問い合わせにだけ使える。今回も変えない)。token / email の索引は別の列用。
--   次は変更しない: 既存の索引、テーブル、RLS ポリシー、GRANT、関数。
--
-- 既存の正当な利用経路への影響: なし。
--   - 索引を足すだけで、問い合わせの結果 (返る行・順序)・権限・書き込みの結果は変わらない。
--   - 書き込みのたびに索引 1 本ぶんの更新が増えるが、招待は人手で作る少量のデータで、無視できる。
--   - CREATE INDEX は作成の間、対象テーブルへの書き込み (INSERT / UPDATE / DELETE) を待たせる。読み取りは待たない。
--     いまのテーブルの大きさなら一瞬で終わる。CONCURRENTLY は migration がトランザクションの中で流れるため使えない。
--
-- 冪等: CREATE INDEX IF NOT EXISTS のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/invites-parent-fk-index.test.ts (6 件)。修正前は全件失敗し、この migration の後は全件成功する。
-- ロールバック: supabase/rollbacks/20261007160100_add_invites_parent_fk_indexes.down.sql

CREATE INDEX IF NOT EXISTS idx_organization_invites_org_created
  ON public.organization_invites (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_family_invites_family_created
  ON public.family_invites (family_id, created_at DESC);
