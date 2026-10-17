-- migration: 20261018010000_purge_dissolved_family_groups.sql
-- 戻し方: supabase/rollbacks/20261018010000_purge_dissolved_family_groups.down.sql
-- #1125 (B) 解散した家族のグループ (family_groups.status = 'dissolved') を、解散から 90 日で物理削除する (段 C)。設計 docs/design/operator/11-ops-batches-non-billing.md §5.4。
-- 範囲: #1125 の (B)。課金系のバッチ (Stripe・収益・ライセンス) は、オーナーの選択「課金は無料のまま計測」により、この段では足さない (#1125 の残り)。
--
-- 背景:
--   解散した家族のグループ (operator_force_dissolve_family が status = 'dissolved'・dissolved_at = now() にする) は、これまで永久に残っていた
--   (名前・メンバーの履歴・招待)。org/05 §7.3 の「90 日後に物理削除」は archived を前提にしていて、いまの状態機械 (active / dissolved だけ) に合わない。
--   そこで、解散から 90 日を過ぎた行を、pg_cron のジョブ purge-dissolved-family-groups (毎日 03:40 JST) が 1 回 500 件まで物理削除する。
--
-- 消える範囲 (設計 §5.4.2):
--   - family_groups の行 (本体)。外部キーの CASCADE で family_members・family_invites・family_promotion_requests も一緒に消える
--     (user_profiles.family_id は SET NULL。解散時に既に NULL)
--   - 保護者の同意の記録 (parental_consents) を持つグループは、消さずに残す (候補から外す)。残した数は戻り値の skipped_with_consents_count に出る
--     (同意の記録まで消してよいかはオーナーの確認事項。確認の結果は「消さずに残す」)。parental_consents は行の有無だけで見る (取り消し済みの行を持つグループも残す)
--   - membership_audit (scope_id に外部キーが無い)・利用者の食事・献立・健康の記録 (family_groups と結ばれていない) は消えない
--
-- 動き:
--   - purge_dissolved_family_groups(p_dry_run) は、候補 (dissolved・dissolved_at が 90 日より前・同意の記録なし) を dissolved_at の古い順に 500 件まで消す。
--     戻り値は (purge_count, remaining_count, skipped_with_consents_count, dry_run)。dry run (true) は件数を数えるだけで、何も消さず、監査ログも書かない
--   - 消す回 (候補が 1 件以上ある回) だけ、admin_audit_logs に system.family.dissolved_purge を 1 行書く (actor NULL・target_type cron_job・severity info)。
--     候補が 0 件の回は、同意の記録を持つグループだけが残る回も含めて書かない (何も変わらない回。設計 §7.1 P-16・P-27)
--   - 将来 family_groups を ON DELETE RESTRICT で参照する表が足されると、その行を持つグループの DELETE が 23503 で失敗する。関数は例外になり、
--     取引ごと巻き戻る (1 件も消えず、監査ログも書かない)。ジョブの実行は failed になり、定期処理の失敗の監視 (段 A・B) が知らせる (設計 §7.1 P-25・S-21)
--
-- 権限の考え方:
--   - 関数は SECURITY INVOKER・search_path 空・参照は完全修飾。呼ぶのは pg_cron (所有者 postgres。RLS を通り抜ける) と service_role (BYPASSRLS) だけ。
--     admin_audit_logs の INSERT のポリシー (actor_id = auth.uid()) はどちらにも当たらない (cleanup_email_outbox・record_backup_audit と同じ形)
--   - EXECUTE は service_role だけ。Supabase は関数を作ると anon / authenticated / service_role に EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付けるので、
--     FROM PUBLIC, anon, authenticated, service_role の完全形で外してから付け直す (20261010123500 と同じ)
--
-- 既存データへの影響: この migration を本番に当てたあとの最初の 03:40 JST に、解散から 90 日を過ぎた (同意の記録を持たない) グループが消える。
--   本番の family_groups は 2026-10-17 の読み取りで 0 行。当てる前に SELECT * FROM public.purge_dissolved_family_groups(true); で件数を確かめられる。
--   関数を作った直後の確認は dry run だけ (何も消さない)。
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE・GRANT / COMMENT / ジョブは同名・同じ処理を呼ぶものを登録解除してから登録のため、2 回続けて適用してもエラーにならず、ジョブは 1 つのまま。
-- 確認: tests/purge-dissolved-family-groups-contract.test.ts / tests/integration/security/purge-dissolved-family-groups.test.ts

-- ----------------------------------------------------------------
-- (1) 関数: 解散から保存期間を過ぎたグループの物理削除
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_dissolved_family_groups(p_dry_run BOOLEAN DEFAULT false)
RETURNS TABLE (purge_count INTEGER, remaining_count INTEGER, skipped_with_consents_count INTEGER, dry_run BOOLEAN)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  -- 解散から物理削除までの保存期間。org/05 §7.3 の「90 日後に物理削除」と、隠したコンテンツ (purge-hidden-content) の 90 日に合わせる
  c_retention   CONSTANT pg_catalog.interval := interval '90 days';
  -- 1 回の実行で消す上限。残りは翌日 (大量の行を 1 回の取引で消さない。purge-hidden-content の 300 秒の切り上げと同じ考え方)
  c_batch_limit CONSTANT INTEGER := 500;
  v_candidates  INTEGER := 0;
  v_skipped     INTEGER := 0;
  v_purged      INTEGER := 0;
BEGIN
  -- 消す候補: 解散から保存期間を過ぎ、保護者の同意の記録 (parental_consents) を持たないグループ
  SELECT pg_catalog.count(*)::INTEGER INTO v_candidates
    FROM public.family_groups AS g
   WHERE g.status = 'dissolved'
     AND g.dissolved_at IS NOT NULL
     AND g.dissolved_at < pg_catalog.now() - c_retention
     AND NOT EXISTS (SELECT 1 FROM public.parental_consents AS pc WHERE pc.family_id = g.id);
  -- 消さずに残すもの: 同意の記録を持つグループ (数だけ報告する)
  SELECT pg_catalog.count(*)::INTEGER INTO v_skipped
    FROM public.family_groups AS g
   WHERE g.status = 'dissolved'
     AND g.dissolved_at IS NOT NULL
     AND g.dissolved_at < pg_catalog.now() - c_retention
     AND EXISTS (SELECT 1 FROM public.parental_consents AS pc WHERE pc.family_id = g.id);

  IF NOT p_dry_run AND v_candidates > 0 THEN
    DELETE FROM public.family_groups AS g
     WHERE g.id IN (
       SELECT g2.id
         FROM public.family_groups AS g2
        WHERE g2.status = 'dissolved'
          AND g2.dissolved_at IS NOT NULL
          AND g2.dissolved_at < pg_catalog.now() - c_retention
          AND NOT EXISTS (SELECT 1 FROM public.parental_consents AS pc WHERE pc.family_id = g2.id)
        ORDER BY g2.dissolved_at ASC
        LIMIT c_batch_limit
     );
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    -- 監査ログ (system.*・actor NULL。07 §3.2)。消すものがある回だけ書く。0 件の回は、同意の記録を持つグループだけが残る回 (v_skipped > 0) も含めて書かない
    -- (何も変わらない回。ジョブの生死は実行履歴と停止の検知で分かり、残した数は戻り値と dry run で分かる)
    INSERT INTO public.admin_audit_logs (actor_id, action_type, target_type, severity, details)
    VALUES (NULL, 'system.family.dissolved_purge', 'cron_job', 'info',
            pg_catalog.jsonb_build_object(
              'purge_count', v_purged,
              'remaining_count', v_candidates - v_purged,
              'skipped_with_consents_count', v_skipped,
              'retention_days', EXTRACT(DAY FROM c_retention)::INTEGER
            ));
  END IF;

  RETURN QUERY SELECT
    CASE WHEN p_dry_run THEN v_candidates ELSE v_purged END,
    CASE WHEN p_dry_run THEN 0 ELSE v_candidates - v_purged END,
    v_skipped,
    p_dry_run;
END $$;

REVOKE ALL ON FUNCTION public.purge_dissolved_family_groups(BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_dissolved_family_groups(BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.purge_dissolved_family_groups(BOOLEAN) IS
  '#1125 (B): 解散した家族のグループ (status = dissolved) を、解散 (dissolved_at) から 90 日を過ぎたものから古い順に 500 件まで物理削除する (pg_cron のジョブ purge-dissolved-family-groups が毎日 03:40 JST に呼ぶ)。family_members・family_invites・family_promotion_requests は外部キーの CASCADE で一緒に消える。保護者の同意の記録 (parental_consents) を持つグループは消さずに残し、数を skipped_with_consents_count に返す。消す回だけ監査ログ system.family.dissolved_purge を書く。p_dry_run = true は数えるだけ。service_role のみ。';

-- ----------------------------------------------------------------
-- (2) 作った直後の確認: 乾いた実行 (dry run) を 1 回だけ流す。何も消さず、何も書かない。
--     「作れるが動かない」状態 (列名の誤りなど。plpgsql は実行時まで分からない) を、適用時に止める。migration は本番に自動で当たるため
-- ----------------------------------------------------------------
DO $$
DECLARE
  v_rows INTEGER;
BEGIN
  SELECT pg_catalog.count(*)::INTEGER INTO v_rows FROM public.purge_dissolved_family_groups(true);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'purge_dissolved_family_groups(true) の戻り値が 1 行ではありません: %', v_rows;
  END IF;
END
$$;

-- ----------------------------------------------------------------
-- (3) pg_cron のジョブ (20261016234000_email_outbox.sql と同じ形)
-- ----------------------------------------------------------------
DO $$
DECLARE
  v_job RECORD;
BEGIN
  -- pg_cron が入っていない DB には cron.job が無い。ジョブは登録できないので、何もしない
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron が入っていないため、ジョブの登録を飛ばしました';
    RETURN;
  END IF;

  -- 同じ処理を呼ぶ既存のジョブ (名前は問わない) と、これから登録する名前のジョブを、先に登録解除する。
  -- command は NOTICE に載せない (秘密が入っていることがある)。
  FOR v_job IN
    SELECT jobid, jobname, schedule
    FROM cron.job
    WHERE jobname = 'purge-dissolved-family-groups'
       OR command ~* '[[:<:]]purge_dissolved_family_groups[[:>:]]'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE '登録済みの pg_cron のジョブを登録解除しました (同じ処理は、このあと登録するジョブが引き継ぎます): jobid=%, jobname=%, schedule=%',
      v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;

  -- 毎日 03:40 JST (18:40 UTC。purge-hidden-content の 03:25・cleanup-email-outbox の 03:20 と重ならない): 解散から 90 日を過ぎた家族のグループを 500 件まで消す
  PERFORM cron.schedule(
    'purge-dissolved-family-groups',
    '40 18 * * *',
    'SELECT public.purge_dissolved_family_groups(false);'
  );
END
$$;
