-- rollback: 20261008200800_org_challenge_progress.sql
-- ⚠️ 権限が広がる: 戻すと、同じ組織のメンバー全員 (管理者を含む) が、組織のチャレンジの全参加者の user_id・current_value・rank を
--    読めるようになる (#1132 の前の状態)。参加者どうしにだけ順位を見せる・管理者には集計だけを見せる、というオーナー判断 (2026-10-08) に反する。
--    明示的な承認を得た場合に限って使う。
--
-- 内容:
--   1. pg_cron のジョブ update-org-challenge-progress を登録解除する (無ければ何もしない。pg_cron が無い DB でも何もしない)
--   2. 関数 get_org_challenge_ranking(uuid, uuid, integer, boolean) / get_org_challenge_aggregates(uuid) /
--      update_org_challenge_progress(timestamptz) を削除する
--   3. organization_challenge_participants のポリシーを元に戻す
--        「Users can view own participation」「Users can leave challenges」を削除し、
--        「Org members can view participants」(同じ組織のメンバー全員が SELECT できる) を戻す。
--        定義は supabase/baseline/prod_schema.sql のとおり。
--   データには触れない: 関数が書いた current_value / rank、completed にしたチャレンジの status は、そのまま残る。
--
-- 先に API のデプロイ (関数 get_org_challenge_aggregates / get_org_challenge_ranking を呼ぶコード) を戻すこと。
-- 先にこのロールバックを当てると、管理者向けのチャレンジ一覧とメンバー向けのチャレンジ画面が 500 になる (関数が無いため)。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  PERFORM cron.unschedule(j.jobid)
     FROM cron.job AS j
    WHERE j.jobname = 'update-org-challenge-progress';
END
$$;

DROP FUNCTION IF EXISTS public.get_org_challenge_ranking(uuid, uuid, integer, boolean);
DROP FUNCTION IF EXISTS public.get_org_challenge_aggregates(uuid);
DROP FUNCTION IF EXISTS public.update_org_challenge_progress(timestamptz);

DROP POLICY IF EXISTS "Users can leave challenges" ON public.organization_challenge_participants;
DROP POLICY IF EXISTS "Users can view own participation" ON public.organization_challenge_participants;

DROP POLICY IF EXISTS "Org members can view participants" ON public.organization_challenge_participants;
CREATE POLICY "Org members can view participants" ON public.organization_challenge_participants
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.organization_challenges oc
      JOIN public.user_profiles up ON up.organization_id = oc.organization_id
     WHERE oc.id = organization_challenge_participants.challenge_id
       AND up.id = auth.uid()
  ));
