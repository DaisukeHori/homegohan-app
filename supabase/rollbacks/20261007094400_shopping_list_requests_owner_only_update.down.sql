-- rollback: 20261007094400_shopping_list_requests_owner_only_update.sql
-- 本番の 2026-10-06 時点の定義 (supabase/baseline/catalog/catalog_policies.csv) に戻す。
-- 戻すと #1234 のポリシー (roles=public、USING (true)、WITH CHECK 無し) が復活する。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。

DROP POLICY IF EXISTS "Service role can update shopping list requests" ON public.shopping_list_requests;
CREATE POLICY "Service role can update shopping list requests" ON public.shopping_list_requests
  FOR UPDATE USING (true);
