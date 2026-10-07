-- migration: 20261007112000_family_promotion_requests.sql
-- #1232: 子供メンバー昇格の本人同意フロー (1/3) — リクエストテーブル + 監査 action 拡張
--
-- 背景: promote_child_to_user は対象者本人の同意なしに family_members.user_id /
-- user_profiles.family_id を書き換える強制編入経路だった (critical / definer-rpc-idor)。
-- 本 migration は同意フローの土台テーブルを新設する。
-- 招待システム本体 (family_invites) には一切手を入れない (#1232 スコープ制約#5)。
--
-- 設計: Issue #1232 実装設計 v2 §3-1 (v3 で変更なし)。設計からの変更点:
--   - 設計時の version 20260714090000 は本番台帳 (最新 20261007094400) より古いため、新しい version で置く。
--   - SELECT ポリシーは family_members を直接参照せず、#1257 (20261007063110) のヘルパー
--     public.is_active_family_adult(family_id) を使う (家族テーブルのポリシーの書き方をそろえる)。
--     条件 (自分がその家族の active な representative / adult) は設計と同じ。
--
-- 冪等: CREATE TABLE / INDEX IF NOT EXISTS、DROP POLICY IF EXISTS → CREATE POLICY、
--       DROP CONSTRAINT IF EXISTS → ADD CONSTRAINT。
-- ロールバック: supabase/rollbacks/20261007112000_family_promotion_requests.down.sql

CREATE TABLE IF NOT EXISTS public.family_promotion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES public.family_groups(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','revoked','expired')),
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_family_promotion_requests_family
  ON public.family_promotion_requests(family_id);
CREATE INDEX IF NOT EXISTS idx_family_promotion_requests_member
  ON public.family_promotion_requests(member_id);
-- 1 member あたり pending は最大1件 (request RPC が事前 revoke するが DB でも担保)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_family_promotion_pending_member
  ON public.family_promotion_requests(member_id) WHERE status = 'pending';

ALTER TABLE public.family_promotion_requests ENABLE ROW LEVEL SECURITY;

-- 権限設計:
-- - 書き込みは SECURITY DEFINER RPC のみ (INSERT/UPDATE/DELETE の GRANT もポリシーも無し)。
-- - Supabase の default privileges は CREATE TABLE 時点で anon/authenticated/service_role に
--   テーブル権限を自動付与する。REVOKE FROM PUBLIC だけでは剥がれない (#1039/#1020 の
--   関数と同じ理屈がテーブルにも当てはまる) ため、ロール個別に完全形で REVOKE する。
-- - token 列は本人同意の証跡 (メールで対象者本人にのみ届く)。発行側 rep/adult が読める
--   必要はないため、列単位 GRANT で SELECT 対象から除外する (defense-in-depth。
--   accept には email 一致検証があるため token 単独では悪用不能だが、そもそも見せない)。
-- ※この結果 `SELECT *` は authenticated に対し permission denied になる。
--   フロントエンドは必ず明示列リストで SELECT すること
--   (src/app/(main)/family/members/[id]/promote/page.tsx 参照)。
REVOKE ALL ON public.family_promotion_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON public.family_promotion_requests TO service_role;
GRANT SELECT (id, family_id, member_id, email, status, requested_by,
              expires_at, created_at, resolved_at, resolved_by)
  ON public.family_promotion_requests TO authenticated;

-- family の active rep/adult は自 family のリクエストを閲覧可 (promote ページの承認待ち表示用)
DROP POLICY IF EXISTS family_promotion_requests_select_family ON public.family_promotion_requests;
CREATE POLICY family_promotion_requests_select_family ON public.family_promotion_requests
  FOR SELECT
  TO authenticated
  USING (public.is_active_family_adult(family_id));

-- ★#1232 v2 (G2): 「対象者本人 (email 一致) の SELECT ポリシー」は意図的に作らない。
-- RLS の USING 句は呼び出しロールの実権限で評価され、authenticated は auth.users への
-- GRANT を一切持たないため、USING 句内の auth.users 直接参照は permission denied となり、
-- OR 結合された正当な SELECT まで巻き添えで全滅する (v1 レビュー指摘 MAJOR-2)。
-- 対象者本人向けのデータ取得は SECURITY DEFINER 関数 get_promotion_details(p_token)
-- (20261007112100) 経由に一本化する。family_invites が対象者本人 SELECT ポリシーを
-- 一切持たず get_invite_details 経由で読ませているのと同じ確立済み設計。

COMMENT ON TABLE public.family_promotion_requests IS
  '#1232: 子供メンバー枠への本人同意 (昇格リクエスト)。書き込みは request/accept/reject/revoke_child_promotion RPC のみ。token 列は authenticated から読めない (列単位 GRANT)。';

-- ─────────────────────────────────────────────────────────
-- membership_audit の action ホワイトリスト拡張
-- ★#1232 v2 (G1): 値リストは本番現行 (20260710210039_membership_lifecycle_fixes.sql。
-- 2026-10-06 の本番スナップショット supabase/baseline/prod_schema.sql でも同じ 23 値) を完全に含む。
-- 特に owner_transfer_declined / representative_transfer_declined は
-- decline_org_owner_transfer / decline_family_representative_transfer が実際に INSERT
-- する値であり、欠落させると譲渡辞退フローが 23514 で全滅する (v1 レビュー指摘 MAJOR-1)。
-- 受諾成功は既存 'child_promoted' を流用 (既存監査コンシューマ互換)。
ALTER TABLE public.membership_audit DROP CONSTRAINT IF EXISTS membership_audit_action_check;
ALTER TABLE public.membership_audit ADD CONSTRAINT membership_audit_action_check CHECK (action IN (
  'group_created','group_dissolved',
  'invite_created','invite_accepted','invite_rejected','invite_revoked','invite_expired',
  'member_added','member_removed','member_left','child_added','child_promoted',
  'role_changed',
  'owner_transfer_proposed','owner_transferred','owner_transfer_declined',
  'representative_transfer_proposed','representative_transferred','representative_transfer_declined',
  'operator_force_owner_transfer','operator_force_representative_transfer',
  'operator_force_dissolve',
  'paste_executed',
  -- ▼ #1232 追加 (3 値)
  'child_promotion_requested','child_promotion_rejected','child_promotion_revoked'
));
