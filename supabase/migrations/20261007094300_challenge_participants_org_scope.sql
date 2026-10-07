-- migration: 20261007094300_challenge_participants_org_scope.sql
-- #1238 (high): organization_challenge_participants の INSERT / UPDATE に組織スコープを付ける
--
-- 背景 (本番 = supabase/baseline/catalog/catalog_policies.csv。20260511000137_backfill_oob_remaining.sql と同じ定義):
--   "Org members can view participants"   SELECT  TO authenticated  チャレンジの組織のメンバーだけ (user_profiles.organization_id で確認)。正しい
--   "Users can join challenges"           INSERT  TO authenticated  WITH CHECK (user_id = auth.uid())   ← challenge_id の組織を確認しない
--   "Users can update own participation"  UPDATE  TO authenticated  USING (user_id = auth.uid())        ← 同じく組織を確認せず、current_value / rank を自由に書ける
--   外部キー challenge_id → organization_challenges の確認は RLS を通らないため、他組織の challenge_id でも入る。
--   組織 A のユーザーが組織 B の challenge_id で { user_id: 自分, current_value: 999999 } を insert / update すると、
--   B の管理画面に見知らぬ参加者・水増しされた参加者数として出る (src/app/api/org/challenges/route.ts の participantCount)。
--   設計 (docs/design/org/09-rls-policies.md) では、participants の UPDATE は service_role (バッチによる進捗更新) のみ。
--
-- 変更:
--   1. "Users can join challenges" を作り直す。WITH CHECK を次の 3 つすべてにする:
--        - user_id = (SELECT auth.uid())                                    本人の行だけ
--        - challenge_id が自分の所属組織 (user_profiles.organization_id) のチャレンジ
--          (SELECT ポリシーと同じ判定。organization_challenges と user_profiles を EXISTS で結ぶ)
--        - COALESCE(current_value, 0) = 0 AND rank IS NULL                   進捗 0・順位なしでの参加だけ
--      3 つ目は、UPDATE を閉じても INSERT で current_value / rank を自己申告できると水増しが残るため。
--   2. "Users can update own participation" を削除する。authenticated / anon に UPDATE のポリシーが無くなり
--      (暗黙 DENY。エラーにはならず 0 件更新)、進捗・順位は service_role (RLS の対象外) だけが更新できる。
--   組織メンバー判定のヘルパー関数は今のところ無い (20261007065936 の departments は
--   user_profiles.department_id の追加、20261007022126 は org_role を直接ポリシーに書く形)。
--   そのため SELECT ポリシーと同じ、インラインの EXISTS にそろえた (関数を増やすと、同じ判定が 2 通りになる)。
--
-- 既存の正当な利用経路への影響: なし。
--   organization_challenge_participants を書き込むコードは、リポジトリ内 (src/・apps/mobile/・supabase/functions/・scripts/・packages/) に無い。
--   参照は src/app/api/org/challenges/route.ts:55-58 の参加者数の COUNT (SELECT) だけで、SELECT ポリシーは変えない。
--   Web / モバイル (apps/mobile/app/(org)/org/challenges.tsx) は /api/org/challenges の participantCount を表示するだけ。
--   service_role は RLS の対象外のため、バッチによる参加行の作成・進捗更新は変わらない。
--
-- 冪等: DROP POLICY IF EXISTS → CREATE POLICY。2 回続けて適用してもエラーにならない。
-- ロールバック: supabase/rollbacks/20261007094300_challenge_participants_org_scope.down.sql

-- ---------------------------------------------------------------
-- 1. INSERT: 本人が、自分の所属組織のチャレンジに、進捗 0・順位なしで参加する場合だけ
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Users can join challenges" ON public.organization_challenge_participants;
CREATE POLICY "Users can join challenges" ON public.organization_challenge_participants
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.organization_challenges oc
      JOIN public.user_profiles up ON up.organization_id = oc.organization_id
      WHERE oc.id = organization_challenge_participants.challenge_id
        AND up.id = (SELECT auth.uid())
    )
    AND COALESCE(current_value, 0) = 0
    AND rank IS NULL
  );

-- ---------------------------------------------------------------
-- 2. UPDATE: 利用者からは更新させない (service_role だけ)
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Users can update own participation" ON public.organization_challenge_participants;
