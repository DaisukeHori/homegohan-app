-- rollback: 20261016234000_email_outbox.sql
-- #1193 の送信待ち (email_outbox) を元に戻す (正典: docs/design/operator/10-logs-and-mail-retry.md §5.5)。順に:
--   1. pg_cron のジョブ cleanup-email-outbox を登録解除する (pg_cron が無い DB では何もしない)
--   2. public.prepare_account_deletion(uuid) を 20261010000100_auth_users_fk_on_delete.sql の定義 (逐語) で作り直す
--      (email_outbox の段 1b・1c と戻り値のキー email_outbox が無くなる。REVOKE / GRANT / COMMENT も同じ)
--   3. RPC 8 本を DROP FUNCTION IF EXISTS で消す (引数の型まで完全形)
--   4. public.email_outbox を消す (ポリシー・索引・権限は表と一緒に消える)
--
-- 注意:
--   - 先に Web のデプロイ (sendEmail の登録・worker・vercel.json) を戻すこと。表を先に消すと sendEmail の登録が失敗する。
--   - 戻すと queued の行は失われる (送られない)。sent / dead の記録も消える。
--   - 2. を 3.・4. より先に流す (段 1b・1c が email_outbox を参照するため。plpgsql は実行時に解決するので順を守れば安全)。
--   - 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (冪等)。

-- 1. ジョブの登録解除
DO $$
DECLARE
  v_job RECORD;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;

  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'cleanup-email-outbox'
    ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END
$$;

-- 2. prepare_account_deletion を 20261010000100 の定義に戻す
CREATE OR REPLACE FUNCTION public.prepare_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- 生のメールアドレスの代わりに入れる固定の文字列。.invalid は RFC 2606 の予約済みで、実在するアドレスにならない
  c_masked_email   CONSTANT pg_catalog.text := 'redacted@redacted.invalid';
  v_emails         pg_catalog.text[];
  v_delivery_logs  pg_catalog.int4 := 0;
  v_inquiries      pg_catalog.int4 := 0;
  v_org_invites    pg_catalog.int4 := 0;
  v_family_invites pg_catalog.int4 := 0;
  v_promotions     pg_catalog.int4 := 0;
  v_private_recipes pg_catalog.int4 := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'prepare_account_deletion: p_user_id is required' USING ERRCODE = '22023';
  END IF;

  -- 本人のメールアドレス (小文字)。ログイン用のメールと、外部ログイン (Google など) の identity に入っているメール
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT s.email), ARRAY[]::pg_catalog.text[])
    INTO v_emails
    FROM (
      SELECT pg_catalog.lower(u.email) AS email
        FROM auth.users AS u
       WHERE u.id = p_user_id
      UNION
      SELECT pg_catalog.lower(i.identity_data ->> 'email')
        FROM auth.identities AS i
       WHERE i.user_id = p_user_id
    ) AS s
   WHERE s.email IS NOT NULL AND s.email <> '';

  -- 1) メール配信ログ: 本人宛のログの宛先を伏せる (行は残す)
  UPDATE public.email_delivery_logs AS l
     SET email = c_masked_email
   WHERE (l.user_id = p_user_id OR pg_catalog.lower(l.email) = ANY (v_emails))
     AND l.email <> c_masked_email;
  GET DIAGNOSTICS v_delivery_logs = ROW_COUNT;

  -- 2) 問い合わせ: 本人の問い合わせの連絡先メールを伏せる (本文は残す。ログイン前に同じアドレスで送った分も含む)
  UPDATE public.inquiries AS q
     SET email = c_masked_email
   WHERE (q.user_id = p_user_id OR pg_catalog.lower(q.email) = ANY (v_emails))
     AND q.email <> c_masked_email;
  GET DIAGNOSTICS v_inquiries = ROW_COUNT;

  -- 3) 組織の招待: 本人のアドレス宛、または本人が受諾した招待の宛先を伏せ、まだ pending のものは revoked にする
  --    (伏せたアドレスは誰も受諾できない。revoked にしないと、受諾できない pending の招待が残り続ける)
  UPDATE public.organization_invites AS oi
     SET email      = c_masked_email,
         status     = CASE WHEN oi.status = 'pending' THEN 'revoked' ELSE oi.status END,
         revoked_at = CASE WHEN oi.status = 'pending' THEN pg_catalog.now() ELSE oi.revoked_at END
   WHERE (pg_catalog.lower(oi.email) = ANY (v_emails) OR oi.accepted_by = p_user_id)
     AND oi.email <> c_masked_email;
  GET DIAGNOSTICS v_org_invites = ROW_COUNT;

  -- 4) 家族の招待・昇格リクエスト: 同じく伏せる。先に関係する家族グループの行をロックする
  --    (CLAUDE.md「家族 (family_*) を変える関数のロック順」: 最初に family_groups、そのあとで子の行)
  PERFORM 1
     FROM public.family_groups AS g
    WHERE g.id IN (
            SELECT fi.family_id
              FROM public.family_invites AS fi
             WHERE (pg_catalog.lower(fi.email) = ANY (v_emails) OR fi.accepted_by = p_user_id)
               AND fi.email <> c_masked_email
            UNION
            SELECT fp.family_id
              FROM public.family_promotion_requests AS fp
             WHERE pg_catalog.lower(fp.email) = ANY (v_emails)
               AND fp.email <> c_masked_email
          )
    ORDER BY g.id
      FOR NO KEY UPDATE;

  UPDATE public.family_invites AS fi
     SET email      = c_masked_email,
         status     = CASE WHEN fi.status = 'pending' THEN 'revoked' ELSE fi.status END,
         revoked_at = CASE WHEN fi.status = 'pending' THEN pg_catalog.now() ELSE fi.revoked_at END
   WHERE (pg_catalog.lower(fi.email) = ANY (v_emails) OR fi.accepted_by = p_user_id)
     AND fi.email <> c_masked_email;
  GET DIAGNOSTICS v_family_invites = ROW_COUNT;

  UPDATE public.family_promotion_requests AS fp
     SET email       = c_masked_email,
         status      = CASE WHEN fp.status = 'pending' THEN 'revoked' ELSE fp.status END,
         resolved_at = CASE WHEN fp.status = 'pending' THEN pg_catalog.now() ELSE fp.resolved_at END
   WHERE pg_catalog.lower(fp.email) = ANY (v_emails)
     AND fp.email <> c_masked_email;
  GET DIAGNOSTICS v_promotions = ROW_COUNT;

  -- 5) 非公開のレシピ: 本人のものを消す。
  --    recipes.user_id は ON DELETE SET NULL で、user_id が NULL の行は RLS ("Users can view public recipes":
  --    user_id IS NULL OR is_public OR 本人) で全員に見える。退会で user_id が外れると、非公開のレシピまで全員に公開されてしまう。
  --    公開レシピ (is_public = true) は、本人が公開したもので、他の利用者のコレクション・いいね・コメントが付いていることがあるので
  --    残す (user_id だけが外れる)。recipes を指す外部キーはすべて ON DELETE CASCADE なので、消して詰まることは無い
  --    (tests/integration/security/auth-users-fk-on-delete.test.ts の E が、ここで DELETE する表を削除の起点に含めて検査する)。
  DELETE FROM public.recipes AS r
   WHERE r.user_id = p_user_id
     AND r.is_public IS NOT TRUE;
  GET DIAGNOSTICS v_private_recipes = ROW_COUNT;

  -- 件数だけを返す (メールアドレスは返さない)
  RETURN pg_catalog.jsonb_build_object(
    'email_delivery_logs', v_delivery_logs,
    'inquiries', v_inquiries,
    'organization_invites', v_org_invites,
    'family_invites', v_family_invites,
    'family_promotion_requests', v_promotions,
    'private_recipes', v_private_recipes
  );
END
$function$;

REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO service_role;

COMMENT ON FUNCTION public.prepare_account_deletion(uuid) IS
  '#1175: 退会の直前に呼ぶ。本人の生のメールアドレスを残す記録 (email_delivery_logs / inquiries / 組織・家族の招待 / 家族の昇格リクエスト) の宛先を伏せ、pending の招待を revoked にする。本人の非公開レシピを消す (user_id が NULL の行は全員に見えるため)。件数だけの jsonb を返す。service_role のみ。';

-- 3. RPC 8 本
DROP FUNCTION IF EXISTS public.claim_email_outbox(TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.complete_email_outbox(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.fail_email_outbox(UUID, TEXT, TEXT, TEXT, INTEGER, BOOLEAN, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.requeue_email_outbox(UUID);
DROP FUNCTION IF EXISTS public.email_outbox_dead_counts(INTEGER);
DROP FUNCTION IF EXISTS public.cleanup_email_outbox();
DROP FUNCTION IF EXISTS public.mark_email_outbox_dead_alerted(TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.unmark_email_outbox_dead_alerted(TIMESTAMPTZ);

-- 4. 表
DROP TABLE IF EXISTS public.email_outbox;
