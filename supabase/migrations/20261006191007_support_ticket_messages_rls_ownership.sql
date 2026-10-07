-- =====================================================================
-- Issue #1233: support_ticket_messages の RLS 所有権検証欠落を修正
-- =====================================================================
-- 【背景】
-- 20260508120000_operator_phase_4_5_foundation.sql の
--   ticket_messages_select: USING (NOT is_internal OR <staff EXISTS>)
--   ticket_messages_insert: WITH CHECK (sender_id = auth.uid())
-- には親チケット (support_tickets.user_id = auth.uid()) の所有権条件が無く、
--  (a) NOT is_internal 分岐が auth.uid() 非依存のため、anon key のみの
--      未認証リクエストでも全ユーザーの非内部メッセージを横断閲覧できた
--  (b) 認証済みユーザーが他人の ticket_id へ任意本文 (is_internal=true 含む)
--      を投稿できた
-- 【本 migration の意図】
--  - SELECT: 「チケット所有者は自分のチケットの非内部メッセージのみ」
--            「staff (support/admin/super_admin) は全件」に限定。
--            両分岐とも auth.uid() 必須のため anon は自然に全拒否。
--  - INSERT: sender_id = auth.uid() を全員に必須とした上で、
--            「所有者は自分のチケットへ is_internal=false のみ」
--            「staff は任意チケットへ is_internal true/false とも可」に限定。
--  - support_tickets 側の 3 ポリシー、UPDATE/DELETE の暗黙 DENY は不変。
-- 【ポリシー名】元 migration は IF NOT EXISTS で作成しているため、同名を DROP → CREATE する
--   (名前を変えると、ベースラインから組み立て直したときに旧ポリシーが残り OR 合成で脆弱性が残る)。
-- 【冪等性】DROP POLICY IF EXISTS + CREATE POLICY。2 回連続実行してもエラー 0。
-- 【ドリフト】2026-10-06 の本番スナップショット (supabase/baseline/catalog) で、
--   本番の support_ticket_messages のポリシーは上記 2 本のみ・定義も migration と一致
--   (本番にしか無い PERMISSIVE ポリシーによる打ち消しは無い。docs/operations/rls-drift-20261006.md)。
-- =====================================================================

-- ---------------------------------------------------------------------
-- SELECT: 所有者 (非内部のみ) + staff (全件)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "ticket_messages_select" ON support_ticket_messages;

CREATE POLICY "ticket_messages_select" ON support_ticket_messages
  FOR SELECT USING (
    (
      NOT is_internal
      AND EXISTS (
        SELECT 1 FROM support_tickets t
        WHERE t.id = support_ticket_messages.ticket_id
          AND t.user_id = auth.uid()
      )
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
        AND ARRAY['support','admin','super_admin']::TEXT[] && roles
    )
  );

-- ---------------------------------------------------------------------
-- INSERT: sender_id=auth.uid() 必須 + (所有者は自チケット非内部のみ / staff は任意)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "ticket_messages_insert" ON support_ticket_messages;

CREATE POLICY "ticket_messages_insert" ON support_ticket_messages
  FOR INSERT WITH CHECK (
    sender_id = auth.uid()
    AND (
      (
        NOT is_internal
        AND EXISTS (
          SELECT 1 FROM support_tickets t
          WHERE t.id = support_ticket_messages.ticket_id
            AND t.user_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1 FROM user_profiles
        WHERE id = auth.uid()
          AND ARRAY['support','admin','super_admin']::TEXT[] && roles
      )
    )
  );

-- ---------------------------------------------------------------------
-- テーブルコメントを新しい意味論に更新
-- ---------------------------------------------------------------------
COMMENT ON TABLE support_ticket_messages IS
  'サポートチケットメッセージ。閲覧: チケット所有者は自分のチケットの is_internal=false のみ、support/admin/super_admin は全件。作成: sender_id=auth.uid() 必須、所有者は自チケットへ is_internal=false のみ、staff は任意チケットへ is_internal 指定可。UPDATE/DELETE はポリシー無し (暗黙DENY)。Issue #1233 で所有権検証を追加。';
