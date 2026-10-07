-- migration: 20261007052359_support_tickets_staff_insert.sql
-- Issue #1248: 運営 (support / admin / super_admin) が顧客の代わりにサポートチケットを起票できるようにする
--
-- 背景:
--   support_tickets の INSERT ポリシーは tickets_insert_user (WITH CHECK (user_id = auth.uid())) の 1 本だけだった
--   (20260508120000_operator_phase_4_5_foundation.sql。本番も同じ定義)。
--   運営画面の POST /api/admin/support/tickets は運営スタッフのセッションで user_id = <顧客> の行を INSERT するため、
--   RLS で拒否されて 500 DB_ERROR になり、運営が顧客の代わりにチケットを起票できなかった。
--
-- 変更:
--   運営用の INSERT ポリシー tickets_insert_staff を追加する。
--   roles に support / admin / super_admin のいずれかを持つユーザーは、任意の user_id でチケットを起票できる。
--   運営の判定は同じテーブルの tickets_select / tickets_update_support、
--   support_ticket_messages の staff 分岐 (#1233) と同じ。
--   顧客本人の起票 (tickets_insert_user) はそのまま残す。PERMISSIVE ポリシーは OR で合成されるため、
--   一般ユーザーやほかの運営系ロール (sales / finance / content_moderator 等) が他人の user_id で起票できない点は変わらない。
--   運営はもともと tickets_select で全チケットを読め、tickets_update_support で全チケットを更新できるため、
--   増える権限は「顧客名義のチケットを新しく作れる」ことだけ。
--
-- 本番との関係 (docs/operations/rls-drift-20261006.md): support_tickets のポリシーは本番と migration で定義が一致し、
--   本番にしか無いポリシーも無い。tickets_insert_staff は新規。
-- 冪等: DROP POLICY IF EXISTS + CREATE POLICY。
-- ロールバック: supabase/rollbacks/20261007052359_support_tickets_staff_insert.down.sql

DROP POLICY IF EXISTS "tickets_insert_staff" ON public.support_tickets;
CREATE POLICY "tickets_insert_staff" ON public.support_tickets
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND ARRAY['support', 'admin', 'super_admin']::TEXT[] && roles
    )
  );
