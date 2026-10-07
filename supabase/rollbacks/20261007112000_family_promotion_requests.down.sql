-- rollback: 20261007112000_family_promotion_requests.sql
-- 最後の手段。先に 20261007112100 のロールバック (RPC 5 本の削除) を当ててから当てる。
-- 監査の action CHECK は本番の 2026-10-06 時点の 23 値 (20260710210039) に戻す。
-- #1232 で追加した 3 値の行が membership_audit に残っていると、CHECK の付け直しは 23514 で失敗する。
-- その行を消すか残すかは監査の扱いとして判断してから実行すること。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止)。

DROP POLICY IF EXISTS family_promotion_requests_select_family ON public.family_promotion_requests;
DROP TABLE IF EXISTS public.family_promotion_requests;

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
  'paste_executed'
));
